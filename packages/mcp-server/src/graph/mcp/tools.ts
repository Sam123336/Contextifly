import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v3';
import {
  deriveFeatures,
  loadFeatureConfig,
  renderFeature,
  renderFeatureList,
} from '../analyze/features';
import {
  ensureGitState,
  type GitState,
  gitDrift,
  loadGitState,
  readGitState,
  saveGitState,
} from '../store/git';
import { assertKnownTool } from '../../tool-manifest';
import { renderImpactAcrossApps } from '../analyze/fleet';
import { saveGraphHtml } from '../render/graph-html';
import { indexProject } from '../extract/indexer';
import { simulatePr } from '../analyze/pr-simulation';
import { GraphIndex } from '../analyze/graph-index';
import { analyzeProject } from '../analyze/health';
import { extractUiCandidates, matchUiElement, searchNodes } from '../analyze/search';
import { whatIf } from '../analyze/what-if';
import { renderGraphDiff, renderTimeline } from '../render/history';
import { renderProjectMap } from '../render/project-map';
import { recordUsage, renderSavingsReport } from '../store/usage-ledger';
import { saveSavingsHtml } from '../render/savings-html';
import {
  graphDir,
  listSnapshots,
  loadGraph,
  loadSnapshot,
  saveGraph,
  staleFileCount,
} from '../store/graph-store';
import type { ProjectGraph } from '../types';
import { renderBlueprint, renderExplainVisually, traceFlow } from '../render/visual';

const projectDirParam = z
  .string()
  .min(1)
  .describe('Absolute path to the project root (the directory containing package.json).');

export function registerGraphTools(server: McpServer): void {
  // Wrapper: every successful graph answer is appended to the local
  // token-savings ledger (best-effort — bookkeeping never breaks an answer).
  const tool = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<{ isError?: boolean; content?: { type: 'text'; text: string }[] }>,
  ): void => {
    // A tool absent from the manifest has no trust class, so `contextifly
    // permissions` would silently leave it un-allowlisted and users would get
    // surprise prompts on upgrade. Fail here instead — loudly, in development.
    assertKnownTool(name);
    (server.tool as CallableFunction)(
      name,
      description,
      schema,
      async (args: { projectDir?: string }) => {
        const started = Date.now();
        const res = await handler(args);
        if (!res.isError && typeof args?.projectDir === 'string') {
          recordUsage(
            args.projectDir,
            name,
            res.content?.[0]?.text?.length ?? 0,
            Date.now() - started,
          );
        }
        return res;
      },
    );
  };

  tool(
    'index_project',
    'Build (or rebuild) the local Software Knowledge Graph for a TypeScript/React/Next.js ' +
      'or Flutter/Dart project (Dart support is beta). Parses components/widgets, ' +
      'routes, navigation, state, and API calls statically — and for Flutter also the ' +
      'native platform-channel bridge (Dart MethodChannel/EventChannel ↔ Android/iOS ' +
      'handlers, linked by channel name) — then ' +
      'stores the graph in <project>/.pixelcontextifly/graph.json, along with an ' +
      'interactive HTML visualization at .pixelcontextifly/graph.html the user can ' +
      'open in a browser. Everything runs locally — no code leaves the machine. Run ' +
      'this once before using the other graph tools; re-running is a cheap no-op that ' +
      'reuses the stored graph when nothing changed (tracked via a git-state sidecar) ' +
      'and only rebuilds when files change, you commit, or you switch branches.',
    { projectDir: projectDirParam },
    async ({ projectDir }) => {
      try {
        // Reuse the stored graph untouched when git says nothing moved (same
        // branch + commit + main head) and no file changed on disk — no
        // rebuild, no file rewrite. Re-running becomes a fast no-op.
        const existing = loadGraph(projectDir);
        const current = readGitState(projectDir);
        if (existing) {
          const saved = loadGitState(projectDir);
          if (graphIsFresh(existing, saved, current)) {
            ensureGitState(projectDir, saved, current); // upgrade pre-git graphs
            return text(renderReuse(projectDir, existing, current));
          }
        }
        const { graph, stats, warnings } = indexProject(projectDir);
        const file = saveGraph(graph);
        const html = saveGraphHtml(graph);
        if (current) saveGitState(projectDir, current);
        const modeNote =
          stats.mode === 'incremental'
            ? ` (incremental: re-parsed ${stats.reparsed}, reused ${stats.reused})`
            : '';
        const lines = [
          `Indexed **${stats.files} files** in ${stats.durationMs}ms${modeNote} → \`${file}\``,
          '',
          `🕸 Interactive visualization: \`${html}\` — open it in a browser.`,
          '',
          `- components: ${stats.components}`,
          `- routes: ${stats.routes}`,
          `- hooks: ${stats.hooks}`,
          `- contexts: ${stats.contexts}`,
          `- API endpoints: ${stats.apis}`,
          ...(stats.controllers + stats.services + stats.modules + stats.entities > 0
            ? [
                `- controllers: ${stats.controllers}`,
                `- services: ${stats.services}`,
                `- modules: ${stats.modules}`,
                `- entities: ${stats.entities}`,
              ]
            : []),
          ...(stats.channels + stats.natives > 0
            ? [
                `- native channels: ${stats.channels}`,
                `- native handlers: ${stats.natives}`,
              ]
            : []),
          `- edges: ${stats.edges}`,
        ];
        if (warnings.length > 0) {
          lines.push('', ...warnings.map((w) => `⚠️ ${w}`));
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'get_project_map',
    'Return a markdown map of an indexed project: every route with its component tree ' +
      'and API calls, plus a Mermaid diagram of route-to-route navigation. ' +
      'Requires index_project to have been run first.',
    { projectDir: projectDirParam },
    async ({ projectDir }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        return text(staleNote + renderProjectMap(index));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'get_impact',
    'Impact analysis: given a component name, file path, or route, list everything that ' +
      'transitively depends on it — affected components, files, routes, and API call ' +
      'sites. Use before modifying or deleting code to understand regression risk.',
    {
      projectDir: projectDirParam,
      target: z
        .string()
        .min(1)
        .describe(
          'What you plan to change: a component name ("CheckoutForm"), relative file ' +
            'path ("src/components/CheckoutForm.tsx"), or route ("/checkout").',
        ),
    },
    async ({ projectDir, target }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        const resolved = index.resolve(target);
        if (resolved.length === 0) {
          return text(
            `${staleNote}No graph node matches \`${target}\`. Try search_graph to find the right name.`,
          );
        }
        const lines: string[] = [staleNote + `# Impact of changing \`${target}\``, ''];
        for (const node of resolved.slice(0, 3)) {
          const deps = index.dependents(node.id);
          const byType = (t: string) => deps.filter((d) => d.type === t);
          const routes = byType('route');

          // APIs and contexts inside the blast radius (used by anything affected).
          const affectedIds = new Set([node.id, ...deps.map((d) => d.id)]);
          const blastApis = new Set<string>();
          const blastContexts = new Set<string>();
          const blastChannels = new Set<string>();
          for (const id of affectedIds) {
            for (const e of index.outEdges(id, ['calls'])) {
              blastApis.add(index.byId.get(e.to)?.name ?? e.to);
            }
            for (const e of index.outEdges(id, ['uses'])) {
              const t = index.byId.get(e.to);
              if (t?.type === 'context') blastContexts.add(t.name);
            }
            for (const e of index.outEdges(id, ['invokes'])) {
              blastChannels.add(index.byId.get(e.to)?.name ?? e.to);
            }
          }

          const risk =
            routes.length >= 3 || deps.length >= 20
              ? 'High'
              : routes.length >= 1 || deps.length >= 6
                ? 'Medium'
                : 'Low';

          lines.push(
            `## ${node.type}: \`${node.id}\``,
            '',
            `**Affected:** ${byType('component').length} components · ` +
              `${byType('file').length} files · ${routes.length} routes · ` +
              `${byType('hook').length} hooks · ${blastContexts.size} contexts`,
            blastApis.size > 0
              ? `**APIs in blast radius:** ${[...blastApis].map((a) => `\`${a}\``).join(', ')}`
              : '',
            blastChannels.size > 0
              ? `**Native channels in blast radius:** ${[...blastChannels].map((c) => `\`${c}\``).join(', ')}`
              : '',
            `**Regression risk:** ${risk}`,
            '',
          );
          if (routes.length > 0) {
            lines.push('**Affected routes (regression risk):**');
            lines.push(...routes.map((r) => `- \`${r.name}\``), '');
          }
          const others = deps.filter((d) => d.type !== 'route').slice(0, 40);
          if (others.length > 0) {
            lines.push('**Dependents:**');
            lines.push(...others.map((d) => `- ${d.type}: \`${d.id}\``));
            if (deps.length > others.length + routes.length) {
              lines.push(`- …and ${deps.length - others.length - routes.length} more`);
            }
            lines.push('');
          }
        }
        if (resolved.length > 3) {
          lines.push(`_${resolved.length - 3} more matches omitted — pass a more specific target._`);
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'match_screenshot',
    'Semantic screenshot ↔ code matching: map UI elements from a Contextifly ' +
      'screenshot analysis to the components that implement them, including which ' +
      'routes/screens each match appears on. Pass either a single element ' +
      'description ("Orange Checkout Button") or the full markdown from ' +
      'analyze_screenshot to match every detected element at once. For the reverse ' +
      'direction ("where does GET /products appear visually?") use get_impact on the endpoint.',
    {
      projectDir: projectDirParam,
      element: z
        .string()
        .optional()
        .describe('One UI element description, e.g. "Orange Checkout Button".'),
      markdown: z
        .string()
        .optional()
        .describe('Full markdown output of analyze_screenshot — matches all detected elements.'),
    },
    async ({ projectDir, element, markdown }) => {
      try {
        if (!element && !markdown) {
          throw new Error('Provide either `element` or `markdown`.');
        }
        const { index, staleNote } = loadIndex(projectDir);
        const queries = element ? [element] : extractUiCandidates(markdown!);
        const lines = [staleNote + '# Screenshot → code matches', ''];
        let any = false;
        for (const q of queries) {
          const matches = matchUiElement(index, q);
          if (matches.length === 0) continue;
          any = true;
          lines.push(`### "${q}"`);
          for (const m of matches) {
            const routes =
              m.routes.length > 0
                ? ` — appears on: ${m.routes.map((r) => `\`${r}\``).join(', ')}`
                : '';
            lines.push(`- **${m.node.name}** (${m.node.type}) \`${m.node.id}\`${routes}`);
          }
          lines.push('');
        }
        if (!any) {
          lines.push(
            '_No graph nodes matched. The UI may be built from generic/library ' +
              'components — try search_graph with text from the element, or start ' +
              'from the route the screen belongs to._',
          );
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'blueprint_screenshot',
    'Screenshot Blueprint — the full "eye" loop at minimal token cost. Feed it ' +
      'the complete markdown from analyze_screenshot (which includes the ASCII ' +
      'Screen Sketch): it maps every sketched element to the code that implements ' +
      'it (component, file, screens), renders how that screen is actually built ' +
      '(Mermaid render tree), and returns a brief for generating 3 design-variant ' +
      'sketches from the tiny ASCII instead of re-reading the image. Use after ' +
      'analyze_screenshot whenever the user wants to connect a screenshot to code ' +
      'or redesign a screen.',
    {
      projectDir: projectDirParam,
      markdown: z
        .string()
        .min(1)
        .describe('Full markdown output of analyze_screenshot (must include # Components; ideally # Screen Sketch).'),
    },
    async ({ projectDir, markdown }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        return text(staleNote + renderBlueprint(index, markdown));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'trace_flow',
    'Trace a user journey through the graph as a styled flow diagram — the ' +
      'low-token way to explain flows like checkout end-to-end. With from+to: ' +
      'shortest path over navigation/render/API edges, decorated with the API ' +
      'calls and alternative branches at each step, plus a numbered step list ' +
      'with file paths. With only from: the forward journey tree from that entry ' +
      'point. Use this INSTEAD of reading source files when asked "how does the ' +
      'X flow work" — a few hundred tokens of verified edges replaces reading ' +
      'dozens of files. Render the returned Mermaid.',
    {
      projectDir: projectDirParam,
      from: z
        .string()
        .min(1)
        .describe('Flow start: route ("/cart"), component ("CartPage"), or screen name.'),
      to: z
        .string()
        .optional()
        .describe('Flow destination, e.g. "/orders" or "OrderTracking". Omit for the forward journey tree.'),
    },
    async ({ projectDir, from, to }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        return text(staleNote + traceFlow(index, from, to));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'explain_visually',
    'Explain Visually: generate a multi-diagram Mermaid dossier for any component, ' +
      'route, state container, or API — how users reach it (navigation-in), what ' +
      'it is composed of (render tree), where its data comes from (API → hook → ' +
      'state → UI), a state-placement decision tree with the branch THIS project ' +
      'actually needs highlighted, and project-specific recommendations. Every box ' +
      'is a real node from this codebase — ideal for explaining frontend ' +
      'architecture to backend developers. Render the returned Mermaid blocks.',
    {
      projectDir: projectDirParam,
      target: z
        .string()
        .min(1)
        .describe('Component, route, context/hook, or API to explain, e.g. "Checkout".'),
    },
    async ({ projectDir, target }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        return text(staleNote + renderExplainVisually(index, target));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'what_if',
    'Digital twin: simulate a change against the Software Knowledge Graph before ' +
      'touching code. Actions: "remove" (what breaks immediately, what is at risk ' +
      'transitively, which routes stay safe, files to touch, regression risk), ' +
      '"split" (call sites to update, natural split boundaries from child/state ' +
      'clusters, verdict), "lazy_load" (exclusive vs shared subtree, loading ' +
      'boundaries needed, whether it is worth it). Deterministic traversal — ' +
      'answers "what happens if…" without re-reading the project.',
    {
      projectDir: projectDirParam,
      action: z
        .enum(['remove', 'split', 'lazy_load'])
        .describe('The hypothetical change to simulate.'),
      target: z
        .string()
        .min(1)
        .describe('Component name, context name, file path, or route (for lazy_load).'),
    },
    async ({ projectDir, action, target }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        return text(staleNote + whatIf(index, action, target));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'impact_across_apps',
    'Fleet impact: "if I change this backend service, which of my apps breaks, and on ' +
      'which screen?" Joins the backend graph to every consumer app declared in ' +
      'contextifly.workspace.json on the endpoints they share — the only symbol a NestJS ' +
      'controller, a Flutter http call and a web fetch() have in common. Each app is ' +
      'indexed at its master branch (never at whatever branch it has checked out), so you ' +
      'always compare against the live version. Reports, per app: affected endpoints, the ' +
      'exact call sites, the screens behind them — and the apps that are provably NOT ' +
      'affected. Mobile apps are escalated automatically because shipped builds cannot be ' +
      'hotfixed. Creates a starter workspace config on first run.',
    {
      projectDir: projectDirParam,
      target: z
        .string()
        .min(1)
        .describe('What you plan to change: a service ("OrdersService"), controller, entity, endpoint, or file path.'),
    },
    async ({ projectDir, target }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        return text(staleNote + renderImpactAcrossApps(projectDir, index, target));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'simulate_pr',
    'Digital twin of a whole pull request: indexes the code before AND after the change ' +
      'in a throwaway git worktree (your checkout is never touched) and subtracts the two ' +
      'graphs. A text diff shows which lines changed; this shows what those lines are now ' +
      'CONNECTED to. Reports: which screens the user sees change; 🕰 reactivated legacy ' +
      'paths (a new edge into code the PR does not touch and nobody has committed to in ' +
      'months — the classic "our change silently switched execution onto stale code that ' +
      'returns null and crashes the frontend"); ⚠️ contract risk (things the PR changes ' +
      'that untouched consumers still call, with unguarded dereferences flagged at the ' +
      'call site); 💥 flows left pointing at something deleted; cross-app impact on every ' +
      'app in contextifly.workspace.json; and a ranked test scope. Use before merging any ' +
      'PR whose blast radius is not obvious.',
    {
      projectDir: projectDirParam,
      ref: z
        .string()
        .optional()
        .describe('Branch or sha holding the change, e.g. "feature/checkout-v2" or "origin/pr-123".'),
      base: z
        .string()
        .optional()
        .describe('What it merges into. Defaults to master, then main.'),
      patch: z
        .string()
        .optional()
        .describe('Path to a .diff/.patch file, applied on top of base — for a PR you have not fetched.'),
    },
    async ({ projectDir, ref, base, patch }) => {
      try {
        return text(simulatePr(projectDir, { ref, base, patch }));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'get_feature',
    'Feature Graph: reason about the project in features, not files. Without a ' +
      'feature name, lists all features (from contextifly.features.json if present, ' +
      'otherwise auto-derived from route groups) with member counts and cross-feature ' +
      'shared nodes. With a name, returns the full dossier: routes, components, ' +
      'state, APIs, and entry points from outside the feature. Answers ' +
      '"explain Authentication" instead of "explain auth.ts".',
    {
      projectDir: projectDirParam,
      feature: z
        .string()
        .optional()
        .describe('Feature name from the list, e.g. "Checkout". Omit to list all features.'),
    },
    async ({ projectDir, feature }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        const loaded = loadFeatureConfig(projectDir);
        const config = loaded?.config ?? deriveFeatures(index);
        const source = loaded?.source ?? 'auto-derived from routes';
        if (!feature) {
          return text(staleNote + renderFeatureList(index, config, source));
        }
        const key = Object.keys(config).find((k) => k.toLowerCase() === feature.toLowerCase());
        if (!key) {
          return text(
            `${staleNote}No feature named \`${feature}\`. Available: ${Object.keys(config)
              .map((k) => `\`${k}\``)
              .join(', ')}`,
          );
        }
        return text(staleNote + renderFeature(index, key, config[key]));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'graph_timeline',
    'Architecture timeline: chronological evolution of the project across all ' +
      'stored graph snapshots — which routes/components/APIs/state were added or ' +
      'removed at each step, tagged with dates and git commits. Answers ' +
      '"how did this architecture evolve over time?"',
    { projectDir: projectDirParam },
    async ({ projectDir }) => {
      try {
        const current = loadGraph(projectDir);
        if (!current) {
          throw new Error(`No graph found at ${graphDir(projectDir)}. Run index_project first.`);
        }
        const history = listSnapshots(projectDir)
          .reverse() // oldest first
          .map((name) => loadSnapshot(projectDir, name))
          .filter((g): g is ProjectGraph => !!g);
        return text(renderTimeline([...history, current]));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'search_graph',
    'Search the Software Knowledge Graph by name — components, routes, files, or API ' +
      'endpoints — and see how each match connects to the rest of the codebase. ' +
      'Useful for mapping UI elements from a screenshot analysis to the code that ' +
      'renders them (e.g. search for the component or button name Contextifly identified).',
    {
      projectDir: projectDirParam,
      query: z.string().min(1).describe('Name or fragment, e.g. "checkout", "ProductCard".'),
    },
    async ({ projectDir, query }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        const hits = searchNodes(index, query);
        if (hits.length === 0) {
          return text(`${staleNote}No nodes match \`${query}\`.`);
        }
        const lines = [staleNote + `# Matches for \`${query}\``, ''];
        for (const hit of hits) {
          lines.push(`- **${hit.node.name}** (${hit.node.type}) — \`${hit.node.id}\``);
          for (const relation of hit.relations) {
            lines.push(`    - ${relation}`);
          }
        }
        return text(lines.join('\n'));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'analyze_project',
    'Smart analysis of an indexed project: architecture score (0-100) with a ' +
      'breakdown of circular imports, possibly-dead components/hooks, API routes ' +
      'never called from the UI, oversized components, and duplicate component ' +
      'names. Pure static graph analysis — fast, deterministic, no LLM involved.',
    { projectDir: projectDirParam },
    async ({ projectDir }) => {
      try {
        const { index, staleNote } = loadIndex(projectDir);
        return text(staleNote + analyzeProject(index).markdown);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  tool(
    'graph_diff',
    'Temporal graph: compare the current knowledge graph against an earlier snapshot ' +
      '(snapshots are archived automatically each time index_project detects changes). ' +
      'Shows added/removed routes, components, hooks, contexts and APIs, plus which ' +
      'components became more or less coupled. Answers "what changed architecturally?"',
    {
      projectDir: projectDirParam,
      snapshot: z
        .string()
        .optional()
        .describe(
          'Snapshot filename from .pixelcontextifly/history/ to compare against. ' +
            'Omit to compare against the most recent snapshot.',
        ),
    },
    async ({ projectDir, snapshot }) => {
      try {
        const current = loadGraph(projectDir);
        if (!current) {
          throw new Error(`No graph found at ${graphDir(projectDir)}. Run index_project first.`);
        }
        const names = listSnapshots(projectDir);
        if (names.length === 0) {
          return text(
            'No history snapshots yet. Snapshots are created automatically when ' +
              'index_project is re-run after the code has changed — index now, make ' +
              'changes, index again, then diff.',
          );
        }
        const name = snapshot ?? names[0];
        const before = loadSnapshot(projectDir, name);
        if (!before) {
          return text(
            `Snapshot \`${name}\` not found. Available snapshots (newest first):\n` +
              names.map((n) => `- \`${n}\``).join('\n'),
          );
        }
        return text(renderGraphDiff(before, current));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // Registered directly (not via the wrapper) so the report never counts itself.
  server.tool(
    'token_savings',
    'Exploration-avoided report with pie-chart diagrams: estimated files/tokens of ' +
      'repository exploration replaced by graph queries (clearly labeled estimates), ' +
      'measured answer sizes and latency, plus real measured screenshot-compression ' +
      'savings. ONLY call this when the user EXPLICITLY asks about savings/usage/cost ' +
      '(e.g. "contextifly token analyze", "how much has contextifly saved"). Never call ' +
      'it proactively, never append it to other answers, and do not mention it unless ' +
      'asked. Render the returned Mermaid.',
    { projectDir: projectDirParam },
    async ({ projectDir }) => {
      try {
        const report = renderSavingsReport(projectDir);
        const html = saveSavingsHtml(projectDir);
        return text(
          html ? `${report}\n\n🖥 Styled dashboard: \`${html}\` — open it in a browser.` : report,
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );
}

function loadIndex(projectDir: string): { index: GraphIndex; staleNote: string } {
  let graph = loadGraph(projectDir);
  if (!graph) {
    throw new Error(
      `No graph found at ${graphDir(projectDir)}. Run the index_project tool first.`,
    );
  }
  // Live context: if git moved (new commits, branch switch, main advanced) or a
  // file changed on disk, transparently re-index so every answer reflects the
  // current code — no manual refresh step.
  const current = readGitState(projectDir);
  const saved = loadGitState(projectDir);
  const reason = staleReason(graph, saved, current);
  let staleNote = '';
  if (reason) {
    const { graph: fresh } = indexProject(projectDir);
    saveGraph(fresh);
    saveGraphHtml(fresh);
    if (current) saveGitState(projectDir, current);
    graph = fresh;
    staleNote = `> ♻️ ${reason} — graph auto-refreshed before answering.\n\n`;
  } else {
    ensureGitState(projectDir, saved, current); // upgrade pre-git graphs
  }
  return { index: new GraphIndex(graph), staleNote };
}

/**
 * Why the stored graph is out of date, or null when it can be served as-is.
 * Git is the primary signal (branch / commit / main-branch head); file hashes
 * catch uncommitted working-tree edits that don't move HEAD. When git can't be
 * consulted (non-repo or no prior sidecar) only the file-hash check applies.
 */
function staleReason(
  graph: ProjectGraph,
  saved: GitState | null,
  current: GitState | null,
): string | null {
  const drift = gitDrift(saved, current);
  if (drift) return drift;
  const stale = staleFileCount(graph);
  return stale > 0 ? `${stale} file(s) changed on disk` : null;
}

function graphIsFresh(
  graph: ProjectGraph,
  saved: GitState | null,
  current: GitState | null,
): boolean {
  return staleReason(graph, saved, current) === null;
}

function renderReuse(root: string, graph: ProjectGraph, git: GitState | null): string {
  const where = git ? `branch \`${git.branch}\` @ \`${git.head.slice(0, 7)}\`` : 'no git repo';
  const file = path.join(graphDir(root), 'graph.json');
  const count = (t: string) => graph.nodes.filter((n) => n.type === t).length;
  return [
    `✓ **Graph already up to date** — reused \`${file}\` (${where}); no rebuild needed.`,
    '',
    '_Nothing changed since the last index. Edit a file, commit, or switch branches to trigger a refresh._',
    '',
    `- files: ${Object.keys(graph.files).length}`,
    `- components: ${count('component')}`,
    `- routes: ${count('route')}`,
    `- API endpoints: ${count('api')}`,
    `- edges: ${graph.edges.length}`,
  ].join('\n');
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function errorText(err: unknown) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
    ],
  };
}
