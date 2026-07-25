import { GraphIndex } from '../analyze/graph-index';
import { extractUiCandidates, matchUiElement } from '../analyze/search';
import type { GraphNode } from '../types';

/**
 * "Explain Visually": multi-diagram dossier for any graph node, generated
 * from the Software Knowledge Graph itself — navigation-in, composition,
 * data flow, and a state-placement decision tree with the branch this
 * project actually needs highlighted. Diagrams are Mermaid (renders inline
 * in Claude Code / GitHub); every box is a real node from this codebase.
 */

const MAX_DIAGRAM_NODES = 22;
const DEPTH = 3;

export function renderExplainVisually(index: GraphIndex, target: string): string {
  const resolved = index.resolve(target);
  if (resolved.length === 0) {
    return `No graph node matches \`${target}\` — try search_graph first.`;
  }
  const node = resolved[0];
  const lines: string[] = [`# ${node.name} — visual explanation`, ''];
  lines.push(`_${node.type}${node.file ? ` · ${node.file}` : ''}_`, '');

  const sections: (string | null)[] =
    node.type === 'api'
      ? [apiFlow(index, node), recommendations(index, node)]
      : [
          navigationIn(index, node),
          composition(index, node),
          dataFlow(index, node),
          statePlacement(index, node),
          recommendations(index, node),
        ];
  for (const s of sections) if (s) lines.push(s, '');
  return lines.join('\n');
}

// --- 🗺️ how users reach it -------------------------------------------------

function navigationIn(index: GraphIndex, node: GraphNode): string | null {
  const routes =
    node.type === 'route'
      ? [node]
      : index
          .routes()
          .filter((r) => r.file && index.routeSubtree(r.id).some((n) => n.id === node.id))
          .slice(0, 3);
  if (routes.length === 0) return null;

  const m = new MermaidBuilder('flowchart LR');
  for (const route of routes) {
    for (const e of index.inEdges(route.id, ['navigates_to']).slice(0, 5)) {
      const from = index.byId.get(e.from);
      if (from) m.edge(from, route, 'navigates');
    }
    if (node.type !== 'route') m.edge(route, node, 'renders');
  }
  if (m.empty()) return null;
  return `## 🗺️ How users reach it\n\n${m.render()}`;
}

// --- 📦 what it is composed of ---------------------------------------------

function composition(index: GraphIndex, node: GraphNode): string | null {
  const start =
    node.type === 'route'
      ? index.outEdges(node.id, ['routes_to']).map((e) => e.to)
      : [node.id];
  const m = new MermaidBuilder('flowchart TD');
  const seen = new Set(start);
  let frontier = start;
  for (let d = 0; d < DEPTH && frontier.length > 0 && m.size() < MAX_DIAGRAM_NODES; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const parent = index.byId.get(id);
      if (!parent) continue;
      for (const e of index.outEdges(id, ['renders'])) {
        const child = index.byId.get(e.to);
        if (!child || m.size() >= MAX_DIAGRAM_NODES) continue;
        m.edge(parent, child);
        if (!seen.has(e.to)) {
          seen.add(e.to);
          next.push(e.to);
        }
      }
    }
    frontier = next;
  }
  if (m.empty()) return null;
  return `## 📦 What it's composed of\n\n${m.render()}`;
}

// --- 🔄 where data comes from and goes -------------------------------------

function dataFlow(index: GraphIndex, node: GraphNode): string | null {
  // Subtree of interest: the node plus what it renders.
  const ids = new Set<string>([node.id]);
  if (node.type === 'route') {
    for (const n of index.routeSubtree(node.id)) ids.add(n.id);
  } else {
    let frontier = [node.id];
    for (let d = 0; d < DEPTH; d++) {
      const next: string[] = [];
      for (const id of frontier)
        for (const e of index.outEdges(id, ['renders']))
          if (!ids.has(e.to)) {
            ids.add(e.to);
            next.push(e.to);
          }
      frontier = next;
    }
  }

  // Data direction: API → hook → context/component → child (props flow down).
  const m = new MermaidBuilder('flowchart LR');
  for (const id of ids) {
    const n = index.byId.get(id);
    if (!n) continue;
    for (const e of index.outEdges(id, ['uses'])) {
      const source = index.byId.get(e.to);
      if (!source) continue;
      m.edge(source, n, source.type === 'context' ? 'state' : 'hook');
      // Where does the hook get its data? (hook → api / context)
      for (const he of index.outEdges(e.to, ['calls'])) {
        const api = index.byId.get(he.to);
        if (api) m.edge(api, source, 'data');
      }
      for (const he of index.outEdges(e.to, ['uses'])) {
        const ctx = index.byId.get(he.to);
        if (ctx) m.edge(ctx, source);
      }
    }
    for (const e of index.outEdges(id, ['calls'])) {
      const api = index.byId.get(e.to);
      if (api) m.edge(api, n, 'data');
    }
  }
  if (m.empty()) return null;
  return `## 🔄 Where data comes from\n\n${m.render()}`;
}

// --- 🌐 api reverse flow ----------------------------------------------------

function apiFlow(index: GraphIndex, api: GraphNode): string {
  const m = new MermaidBuilder('flowchart LR');
  for (const e of index.inEdges(api.id, ['calls']).slice(0, 8)) {
    const caller = index.byId.get(e.from);
    if (!caller) continue;
    m.edge(api, caller, 'data');
    for (const route of index.dependents(caller.id).filter((d) => d.type === 'route').slice(0, 3)) {
      m.edge(caller, route, 'shown on');
    }
  }
  return `## 🌐 Where this API's data appears\n\n${m.render()}`;
}

// --- 🧠 state placement decision --------------------------------------------

function statePlacement(index: GraphIndex, node: GraphNode): string | null {
  // Analyze the node itself if it IS state, else the state it consumes.
  const stateNodes =
    node.type === 'context' || node.type === 'hook'
      ? [node]
      : index
          .outEdges(node.id, ['uses'])
          .map((e) => index.byId.get(e.to))
          .filter((n): n is GraphNode => !!n && n.type === 'context')
          .slice(0, 2);
  if (stateNodes.length === 0) return null;

  const parts: string[] = ['## 🧠 State placement — is it in the right place?'];
  let treeRendered = false;
  for (const state of stateNodes) {
    // Speak the project's language: Flutter widgets get Flutter advice.
    const dart = (state.file ?? node.file ?? '').endsWith('.dart');
    const terms = dart
      ? {
          unit: 'widget',
          local: 'setState() inside the widget',
          lift: 'Lift state up — pass via constructor',
          global: 'Provider / Riverpod / Bloc',
        }
      : {
          unit: 'component',
          local: 'useState() in the component',
          lift: 'Lift state to common parent',
          global: 'Context / store',
        };

    const consumers = index
      .inEdges(state.id, ['uses'])
      .map((e) => index.byId.get(e.from))
      .filter((n): n is GraphNode => !!n);
    const routes = new Set(
      index.dependents(state.id).filter((d) => d.type === 'route').map((d) => d.name),
    );
    const branch =
      consumers.length <= 1 ? 'local' : routes.size <= 1 ? 'lift' : 'context';
    const verdictText =
      branch === 'local'
        ? `only ${consumers.length} consumer — plain \`${dart ? 'setState()' : 'useState()'}\` in that ${terms.unit} is enough`
        : branch === 'lift'
          ? `${consumers.length} consumers but all within one ${dart ? 'screen' : 'route'} — lift state to their common parent ${terms.unit}`
          : `${consumers.length} consumers across ${routes.size} ${dart ? 'screens' : 'routes'} — ${terms.global} is justified`;

    const hl = (b: string) => (b === branch ? ':::chosen' : '');
    if (!treeRendered) {
      treeRendered = true;
      parts.push(
        '',
        '```mermaid',
        'flowchart TD',
        `  Q1{"Used by more than one ${terms.unit}?"}`,
        `  L["${terms.local}"]${hl('local')}`,
        `  Q2{"Consumers span multiple ${dart ? 'screens' : 'routes'}?"}`,
        `  P["${terms.lift}"]${hl('lift')}`,
        `  C["${terms.global}"]${hl('context')}`,
        '  Q1 -->|no| L',
        '  Q1 -->|yes| Q2',
        '  Q2 -->|no| P',
        '  Q2 -->|yes| C',
        '  classDef chosen fill:#2ea04326,stroke:#2ea043,stroke-width:2px',
        '```',
      );
    }
    parts.push(
      '',
      `**\`${state.name}\` today:** consumed by ${consumers
        .slice(0, 6)
        .map((c) => `\`${c.name}\``)
        .join(', ')}${consumers.length > 6 ? ` +${consumers.length - 6} more` : ''}` +
        (routes.size > 0 ? ` across ${[...routes].map((r) => `\`${r}\``).join(', ')}` : ''),
      `**Verdict:** ${verdictText}.`,
    );
  }
  return parts.join('\n');
}

// --- 💡 recommendations -----------------------------------------------------

function recommendations(index: GraphIndex, node: GraphNode): string | null {
  const recs: string[] = [];
  if ((node.loc ?? 0) >= 150) {
    recs.push(`Split it — ${node.loc} lines is past the healthy threshold (run \`what_if split ${node.name}\`).`);
  }
  const renderers = index.inEdges(node.id, ['renders', 'routes_to']).length;
  if (renderers >= 5) {
    recs.push(`High blast radius — rendered from ${renderers} places; changes here need the full affected-routes list (\`get_impact\`).`);
  }
  if (node.type === 'component' && renderers === 0 && index.inEdges(node.id).length <= 1) {
    recs.push('Nothing renders this component — possibly dead code (verify barrel re-exports before deleting).');
  }
  const apiCount = index.outEdges(node.id, ['calls']).length;
  if (apiCount >= 3) {
    const home = (node.file ?? '').endsWith('.dart') ? 'a repository/service class' : 'a hook or service';
    recs.push(`Calls ${apiCount} APIs directly — consider consolidating fetches into ${home} so loading and error states live in one place.`);
  }
  if (recs.length === 0) return null;
  return `## 💡 Recommendations for this project\n\n${recs.map((r) => `- ${r}`).join('\n')}`;
}

// --- screenshot blueprint (sketch → code mapping) -----------------------------

/**
 * Screenshot Blueprint: take a Contextifly screenshot analysis (which contains
 * an ASCII Screen Sketch), locate every sketched element in the codebase via
 * the graph, and render the code-side diagram next to it. Ends with an
 * explicit brief for generating design-variant sketches, so the whole
 * "analyze → map → redesign" loop runs on ~1k tokens instead of re-reading
 * the image or the codebase.
 */
export function renderBlueprint(index: GraphIndex, markdown: string): string {
  const sketch = markdown.match(/# Screen Sketch[\s\S]*?```(?:text)?\n([\s\S]*?)```/)?.[1];
  const componentNames = extractComponentNames(markdown);
  if (componentNames.length === 0) {
    return (
      'No components found in the provided markdown — pass the full output of ' +
      'analyze_screenshot (it must include the # Components section).'
    );
  }

  // Map every sketched element to code.
  const rows: { label: string; hit?: { node: GraphNode; routes: string[] } }[] = [];
  const routeVotes = new Map<string, number>();
  for (const label of componentNames.slice(0, 15)) {
    const matches = matchUiElement(index, label);
    const best = matches[0];
    rows.push({ label, hit: best ? { node: best.node, routes: best.routes } : undefined });
    if (best) {
      for (const r of best.routes) routeVotes.set(r, (routeVotes.get(r) ?? 0) + 1);
    }
  }
  const matched = rows.filter((r) => r.hit);
  const screenRoute = [...routeVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const lines: string[] = ['# Screenshot blueprint → code', ''];
  if (sketch) {
    lines.push('## What the screenshot shows', '', '```text', sketch.trimEnd(), '```', '');
  }

  lines.push(
    `## Where each element lives in the code (${matched.length}/${rows.length} matched)`,
    '',
    '| Sketch element | Code | File | Screens |',
    '|---|---|---|---|',
  );
  for (const r of rows) {
    if (r.hit) {
      lines.push(
        `| ${r.label} | \`${r.hit.node.name}\` (${r.hit.node.type}) | ${r.hit.node.file ?? '—'} | ${
          r.hit.routes.slice(0, 3).map((x) => `\`${x}\``).join(' ') || '—'
        } |`,
      );
    } else {
      lines.push(`| ${r.label} | _no match — likely a library/generic element_ | — | — |`);
    }
  }
  lines.push('');

  // Code-side drawing: the render tree of the screen the elements point at.
  if (screenRoute) {
    const routeNode = index.resolve(screenRoute)[0];
    if (routeNode) {
      const comp = composition(index, routeNode);
      if (comp) {
        lines.push(
          `## How this screen is built in code (\`${screenRoute}\`)`,
          '',
          comp.replace(/^## .*\n\n/, ''),
          '',
        );
      }
    }
  }

  // Brief for the AI layer: generate the variant sketches from the tiny ASCII,
  // never from the image.
  lines.push(
    '## Design-variant brief',
    '',
    'Using ONLY the Screen Sketch above (do not re-read the image), produce **3 variant',
    'sketches** in the same ASCII style, each implementing one improvement from the',
    "analysis' Problems/Suggestions sections (e.g. reposition a primary CTA, merge",
    'duplicate sections, fix hierarchy). Under each variant, list which of the matched',
    'code components from the table would need to change, so the redesign is',
    'immediately actionable.',
  );
  return lines.join('\n');
}

/** Pull component names out of the "# Components" section of an analysis. */
function extractComponentNames(markdown: string): string[] {
  const section = markdown.match(/# Components\n([\s\S]*?)(?=\n# |$)/)?.[1] ?? '';
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of section.matchAll(/^[-*]\s*\**([A-Za-z][A-Za-z0-9 /]{1,32}?)\**\s*(?:[—:–(-]|$)/gm)) {
    const name = m[1].trim();
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  if (names.length === 0) return extractUiCandidates(markdown);
  return names;
}

// --- flow tracing (user journeys) -------------------------------------------

const FLOW_KINDS = ['navigates_to', 'routes_to', 'renders', 'calls'] as const;
const FLOW_DEPTH = 12;

/**
 * Trace a user journey through the graph: shortest path from `from` to `to`
 * over navigation/render/API edges, decorated with the side-branches
 * (API calls, alternative navigations) each step can take. Single-endpoint
 * mode renders the forward journey tree from an entry point.
 *
 * This is the low-token replacement for "read 20 files to explain checkout":
 * the whole dossier is a few hundred tokens of verified edges.
 */
export function traceFlow(index: GraphIndex, from: string, to?: string): string {
  const start = index.resolve(from)[0];
  if (!start) return `No graph node matches \`${from}\` — try search_graph first.`;

  if (!to) return flowTree(index, start);

  const goal = index.resolve(to)[0];
  if (!goal) return `No graph node matches \`${to}\` — try search_graph first.`;

  // BFS shortest path over flow edges.
  const parent = new Map<string, { prev: string; kind: string }>();
  const seen = new Set<string>([start.id]);
  let frontier = [start.id];
  let found = false;
  for (let d = 0; d < FLOW_DEPTH && frontier.length > 0 && !found; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of index.outEdges(id, [...FLOW_KINDS])) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        parent.set(e.to, { prev: id, kind: e.kind });
        if (e.to === goal.id) {
          found = true;
          break;
        }
        next.push(e.to);
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!found) {
    return (
      `No flow path found from \`${start.name}\` to \`${goal.name}\` through ` +
      'navigation/render/API edges. Both exist — they may be connected only via ' +
      'state, or through navigation the parser could not see (e.g. anonymous ' +
      '`Navigator.push`). Try get_impact on each to view their neighborhoods.'
    );
  }

  // Reconstruct path.
  const pathIds: string[] = [goal.id];
  while (pathIds[0] !== start.id) pathIds.unshift(parent.get(pathIds[0])!.prev);
  const pathSet = new Set(pathIds);

  const m = new MermaidBuilder('flowchart TD');
  const steps: string[] = [];
  for (let i = 0; i < pathIds.length; i++) {
    const node = index.byId.get(pathIds[i])!;
    if (i + 1 < pathIds.length) {
      const nextNode = index.byId.get(pathIds[i + 1])!;
      m.edge(node, nextNode, parent.get(nextNode.id)!.kind.replace('_to', ''));
    }
    // Side branches: APIs called and alternative navigations off the main path.
    for (const e of index.outEdges(node.id, ['calls'])) {
      const api = index.byId.get(e.to);
      if (api && !pathSet.has(api.id) && m.size() < MAX_DIAGRAM_NODES) m.edge(node, api, 'calls', true);
    }
    for (const e of index.outEdges(node.id, ['navigates_to'])) {
      const alt = index.byId.get(e.to);
      if (alt && !pathSet.has(alt.id) && m.size() < MAX_DIAGRAM_NODES) m.edge(node, alt, 'alt', true);
    }
    steps.push(
      `${i + 1}. **${node.name}** (${node.type})${node.file ? ` — \`${node.file}\`` : ''}`,
    );
  }

  return [
    `# Flow: ${start.name} → ${goal.name}`,
    '',
    m.render(),
    '',
    '## Steps',
    ...steps,
    '',
    '_Solid arrows = the traced path; dashed = side effects and alternative branches at each step._',
  ].join('\n');
}

/**
 * Forward journey tree from an entry point, at route level: navigation is
 * aggregated from each route's entire render subtree and labeled with the
 * component that triggers it; API calls appear as dashed side-effects.
 */
function flowTree(index: GraphIndex, start: GraphNode): string {
  const startRoutes =
    start.type === 'route'
      ? [start]
      : index
          .routes()
          .filter((r) => r.file && index.routeSubtree(r.id).some((n) => n.id === start.id));
  if (startRoutes.length === 0) {
    return `\`${start.name}\` is not on any route — pass a route or screen, or use from+to for a point-to-point path.`;
  }

  const m = new MermaidBuilder('flowchart TD');
  const seen = new Set(startRoutes.map((r) => r.id));
  let frontier = startRoutes.map((r) => r.id);
  for (let d = 0; d < 4 && frontier.length > 0 && m.size() < MAX_DIAGRAM_NODES; d++) {
    const next: string[] = [];
    for (const routeId of frontier) {
      const route = index.byId.get(routeId);
      if (!route) continue;
      for (const member of index.routeSubtree(routeId)) {
        for (const e of index.outEdges(member.id, ['navigates_to'])) {
          const target = index.byId.get(e.to);
          if (!target || e.to === routeId || m.size() >= MAX_DIAGRAM_NODES) continue;
          m.edge(route, target, `via ${member.name}`);
          if (!seen.has(e.to)) {
            seen.add(e.to);
            next.push(e.to);
          }
        }
        for (const e of index.outEdges(member.id, ['calls'])) {
          const api = index.byId.get(e.to);
          if (api && m.size() < MAX_DIAGRAM_NODES) m.edge(route, api, member.name, true);
        }
      }
    }
    frontier = next;
  }
  if (m.empty()) {
    return `\`${start.name}\` has no outgoing navigation — nothing to trace forward. Pass a \`to\` target for a point-to-point path.`;
  }
  return [
    `# User journey from ${start.name}`,
    '',
    m.render(),
    '',
    '_Solid arrows = navigation (labeled with the component that triggers it); dashed = API calls made along the way._',
  ].join('\n');
}

// --- mermaid builder ---------------------------------------------------------

const TYPE_SHAPE: Record<string, [string, string]> = {
  route: ['([', '])'],
  api: ['[(', ')]'],
  context: ['{{', '}}'],
  hook: ['{{', '}}'],
  component: ['[', ']'],
  file: ['[', ']'],
};

const TYPE_STYLE: Record<string, string> = {
  route: 'fill:#f59e0b1a,stroke:#f59e0b,color:#f59e0b',
  api: 'fill:#10b9811a,stroke:#10b981,color:#10b981',
  component: 'fill:#6366f11a,stroke:#6366f1',
  context: 'fill:#c084fc1a,stroke:#c084fc',
  hook: 'fill:#c084fc1a,stroke:#c084fc',
};

class MermaidBuilder {
  private readonly declared = new Map<string, GraphNode>();
  private readonly edges = new Set<string>();
  private readonly lines: string[] = [];

  constructor(private readonly header: string) {}

  edge(from: GraphNode, to: GraphNode, label?: string, dashed = false): void {
    this.declare(from);
    this.declare(to);
    const key = `${from.id}|${to.id}|${label ?? ''}`;
    if (this.edges.has(key)) return;
    this.edges.add(key);
    const arrow = dashed
      ? label
        ? `-.->|${label}|`
        : '-.->'
      : label
        ? `-->|${label}|`
        : '-->';
    this.lines.push(`  ${mid(from.id)} ${arrow} ${mid(to.id)}`);
  }

  private declare(n: GraphNode): void {
    if (this.declared.has(n.id)) return;
    this.declared.set(n.id, n);
    const [open, close] = TYPE_SHAPE[n.type] ?? ['[', ']'];
    this.lines.unshift(`  ${mid(n.id)}${open}"${n.name.replace(/"/g, "'")}"${close}`);
  }

  size(): number {
    return this.declared.size;
  }
  empty(): boolean {
    return this.edges.size === 0;
  }
  render(): string {
    // Color nodes by type so diagrams read like the graph.html legend.
    const styleLines: string[] = [];
    const byType = new Map<string, string[]>();
    for (const n of this.declared.values()) {
      if (!TYPE_STYLE[n.type]) continue;
      const list = byType.get(n.type);
      if (list) list.push(mid(n.id));
      else byType.set(n.type, [mid(n.id)]);
    }
    for (const [type, ids] of byType) {
      styleLines.push(`  classDef ${type} ${TYPE_STYLE[type]}`);
      styleLines.push(`  class ${ids.join(',')} ${type}`);
    }
    return ['```mermaid', this.header, ...this.lines, ...styleLines, '```'].join('\n');
  }
}

function mid(id: string): string {
  return 'n' + id.replace(/[^A-Za-z0-9]/g, '_');
}
