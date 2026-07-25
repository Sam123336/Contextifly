/**
 * PR simulation — the digital twin, applied to a whole change instead of one node.
 *
 * The premise: you already know what you changed, and you tested it. The bugs
 * that reach production live in the code you *didn't* change and therefore
 * never thought to test. So every analyser here computes the same thing from a
 * different angle — **behaviour that moved, minus everything the PR touched.**
 *
 * That requires two graphs. A text diff shows which lines changed; it cannot
 * show what those lines are now *connected to*. Indexing base and head
 * separately and subtracting the edge sets makes activation visible: an added
 * edge is a path that just went live, a removed edge is a flow that just broke.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { toEndpoint, parseApiId, type Endpoint } from './endpoints';
import {
  applyPatch,
  changedFiles as gitChangedFiles,
  lastCommitDays,
  patchFiles,
  revParse,
  showFile,
  withWorktree,
} from '../store/git';
import {
  fleetImpact,
  loadFleetConfig,
  renderFleetImpact,
  WORKSPACE_FILE,
  type FleetConfig,
} from './fleet';
import { indexProject } from '../extract/indexer';
import { GraphIndex } from './graph-index';
import { loadGraph } from '../store/graph-store';
import type { GraphEdge, GraphNode, ProjectGraph } from '../types';

/** A dependency older than this, newly pulled into a live path, is called out. */
const LEGACY_DAYS = 180;
/** Ceiling on `git log` calls — legacy checking must not turn into a repo scan. */
const MAX_AGE_PROBES = 40;
/** Lines after a call site scanned for unguarded access to its response. */
const GUARD_WINDOW = 12;
const MAX_ROWS = 12;

export interface PrInput {
  /** Branch/sha holding the change. */
  ref?: string;
  /** What it merges into. Defaults to master, then main. */
  base?: string;
  /** Path to a .diff/.patch file applied on top of base — for a PR you have not fetched. */
  patch?: string;
}

/** Node types other code consumes: changing one changes someone else's contract. */
const CONTRACT_TYPES = new Set<GraphNode['type']>([
  'api', 'service', 'controller', 'entity', 'hook', 'context', 'channel',
]);

const edgeKey = (e: GraphEdge) => `${e.from}|${e.kind}|${e.to}`;

// --- graph construction -----------------------------------------------------

function resolveBase(root: string, base?: string): string {
  const candidates = base ? [base] : ['master', 'main'];
  for (const candidate of candidates) {
    if (revParse(root, candidate)) return candidate;
  }
  throw new Error(
    base
      ? `Base ref \`${base}\` does not exist in this repo.`
      : 'Could not find a `master` or `main` branch to use as the base — pass `base` explicitly.',
  );
}

function graphAt(root: string, ref: string): ProjectGraph {
  const stored = loadGraph(root);
  const sha = revParse(root, ref);
  // The stored graph already *is* this commit — skip the worktree entirely.
  if (stored && sha && stored.commit === sha) return stored;
  return withWorktree(root, ref, (dir) => {
    const graph = indexProject(dir, { force: true }).graph;
    graph.root = root;
    return graph;
  });
}

function graphWithPatch(root: string, base: string, patchFile: string): ProjectGraph {
  const abs = path.resolve(patchFile);
  if (!existsSync(abs)) throw new Error(`Patch file not found: ${abs}`);
  return withWorktree(root, base, (dir) => {
    applyPatch(dir, abs);
    const graph = indexProject(dir, { force: true }).graph;
    graph.root = root;
    return graph;
  });
}

// --- analysers --------------------------------------------------------------

/** Nodes owned by a file the PR touched — the change's own footprint. */
function touchedNodes(index: GraphIndex, changed: Set<string>): GraphNode[] {
  return index.graph.nodes.filter((n) => n.file && changed.has(n.file) && n.type !== 'file');
}

/**
 * 1. What the user sees differently: routes/screens reachable from the change.
 */
function userSurface(index: GraphIndex, touched: GraphNode[]): string[] {
  const routes = new Set<string>();
  for (const node of touched) {
    if (node.type === 'route') routes.add(node.name);
    for (const dep of index.dependents(node.id)) {
      if (dep.type === 'route') routes.add(dep.name);
    }
  }
  return [...routes].sort();
}

interface LegacyHit {
  from: string;
  to: string;
  kind: string;
  file: string;
  days: number;
}

/**
 * 2. Reactivated legacy paths — the incident this whole tool exists for.
 *
 * Three predicates, all required: the edge is **new** (this PR created it), its
 * target was **not touched** by the PR (nobody reviewed it), and the target's
 * file is **old** (nobody has exercised it in months). Live + unreviewed + stale
 * is the fingerprint of "our change quietly switched execution onto code whose
 * contract nobody had updated".
 */
function reactivatedLegacy(
  root: string,
  after: GraphIndex,
  addedEdges: GraphEdge[],
  changed: Set<string>,
): LegacyHit[] {
  const hits: LegacyHit[] = [];
  const seen = new Set<string>();
  let probes = 0;
  for (const edge of addedEdges) {
    if (probes >= MAX_AGE_PROBES) break;
    const target = after.byId.get(edge.to);
    if (!target?.file || target.type === 'file') continue;
    if (changed.has(target.file)) continue; // reviewed as part of this PR
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    probes++;
    const days = lastCommitDays(root, target.file);
    if (days === null || days < LEGACY_DAYS) continue;
    hits.push({
      from: after.byId.get(edge.from)?.name ?? edge.from,
      to: target.name,
      kind: edge.kind,
      file: target.file,
      days,
    });
  }
  return hits.sort((a, b) => b.days - a.days);
}

interface ContractRisk {
  target: GraphNode;
  consumers: { name: string; file: string; line: number; unguarded?: string }[];
}

/**
 * 3. Contract risk — a changed thing, and the consumers the PR left alone.
 *
 * When those consumers dereference the response two levels deep with no
 * optional chaining, a field that turns null is a white screen. The guard sniff
 * is a regex over the exact call sites the graph names: it reads twelve lines,
 * not the project, and it is explicitly heuristic.
 */
function contractRisks(
  root: string,
  ref: string,
  after: GraphIndex,
  touched: GraphNode[],
  changed: Set<string>,
): ContractRisk[] {
  const risks: ContractRisk[] = [];
  for (const node of touched) {
    if (!CONTRACT_TYPES.has(node.type)) continue;
    const consumers: ContractRisk['consumers'] = [];
    for (const edge of after.inEdges(node.id)) {
      // defines/imports/contains are wiring, not consumption: a module listing a
      // provider does not care what that provider returns.
      if (edge.kind === 'defines' || edge.kind === 'imports' || edge.kind === 'contains') continue;
      const source = edge.source;
      if (!source || changed.has(source.file)) continue; // the PR updated this caller
      const from = after.byId.get(edge.from);
      consumers.push({
        name: from?.name ?? edge.from,
        file: source.file,
        line: source.line,
        unguarded: unguardedAccess(root, ref, source.file, source.line),
      });
    }
    if (consumers.length > 0) {
      risks.push({ target: node, consumers: consumers.slice(0, MAX_ROWS) });
    }
  }
  return risks.sort((a, b) => b.consumers.length - a.consumers.length);
}

/**
 * The first chained dereference near a call site that has no `?.` anywhere in
 * it — `data.order.status` survives a null `data`, `data?.order?.status` does
 * not crash. Heuristic by construction: reports the line, never a verdict.
 */
function unguardedAccess(root: string, ref: string, file: string, line: number): string | undefined {
  const text = showFile(root, ref, file) ?? readLocal(root, file);
  if (!text) return undefined;
  return firstUnguardedChain(text.split('\n'), line);
}

/** Pure core of the guard sniff, kept separate so it can be checked directly. */
export function firstUnguardedChain(lines: string[], startLine: number): string | undefined {
  const end = Math.min(lines.length, startLine - 1 + GUARD_WINDOW);
  for (let i = Math.max(0, startLine - 1); i < end; i++) {
    const code = (lines[i] ?? '').split('//')[0];
    // `a?.b.c` still counts as guarded: one `?.` short-circuits the whole chain.
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*){2,})\b/g)) {
      const chain = m[1];
      if (chain.includes('?.')) continue;
      // Capitalised roots are types, namespaces and enums (`Express.Multer.File`,
      // `OrderStatus.Pending`) — they are resolved at compile time and cannot be
      // null at runtime. Response objects are conventionally camelCase.
      if (/^[A-Z]/.test(chain)) continue;
      if (/^(this|window|document|console|process|require|module|exports)\b/.test(chain)) continue;
      return `${chain} (line ${i + 1})`;
    }
  }
  return undefined;
}

function readLocal(root: string, file: string): string | null {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}

/** 4. Flows that break outright: an edge disappeared but its caller did not. */
function brokenFlows(before: GraphIndex, after: GraphIndex, removed: GraphEdge[]): string[] {
  const out: string[] = [];
  for (const edge of removed) {
    if (edge.kind === 'defines' || edge.kind === 'imports') continue;
    if (!after.byId.has(edge.from)) continue; // caller deleted too — intentional
    if (after.byId.has(edge.to)) continue; // still exists, just re-wired
    const from = before.byId.get(edge.from);
    const to = before.byId.get(edge.to);
    out.push(
      `\`${from?.name ?? edge.from}\` —${edge.kind}→ \`${to?.name ?? edge.to}\`` +
        (edge.source ? ` (${edge.source.file}:${edge.source.line})` : ''),
    );
  }
  return out.slice(0, MAX_ROWS);
}

// --- report -----------------------------------------------------------------

export interface SimulateOptions extends PrInput {
  /** Skip the cross-app section even when a workspace config exists. */
  skipFleet?: boolean;
}

export function simulatePr(projectDir: string, input: SimulateOptions): string {
  const root = path.resolve(projectDir);
  const base = resolveBase(root, input.base);

  let head: string;
  let changedList: string[];
  let afterGraph: ProjectGraph;
  if (input.patch) {
    head = base;
    changedList = patchFiles(readFileSync(path.resolve(input.patch), 'utf8'));
    afterGraph = graphWithPatch(root, base, input.patch);
  } else if (input.ref) {
    head = input.ref;
    if (!revParse(root, head)) throw new Error(`Ref \`${head}\` does not exist in this repo.`);
    changedList = gitChangedFiles(root, base, head);
    afterGraph = graphAt(root, head);
  } else {
    throw new Error('Pass either `ref` (a PR branch/sha) or `patch` (a .diff file).');
  }

  const beforeGraph = graphAt(root, base);
  const before = new GraphIndex(beforeGraph);
  const after = new GraphIndex(afterGraph);
  const changed = new Set(changedList);

  const beforeEdges = new Set(beforeGraph.edges.map(edgeKey));
  const afterEdges = new Set(afterGraph.edges.map(edgeKey));
  const addedEdges = afterGraph.edges.filter((e) => !beforeEdges.has(edgeKey(e)));
  const removedEdges = beforeGraph.edges.filter((e) => !afterEdges.has(edgeKey(e)));

  const touched = touchedNodes(after, changed);
  const screens = userSurface(after, touched);
  const legacy = reactivatedLegacy(root, after, addedEdges, changed);
  const risks = contractRisks(root, head, after, touched, changed);
  const broken = brokenFlows(before, after, removedEdges);

  const lines: string[] = [
    `# PR simulation — \`${input.patch ? path.basename(input.patch) : head}\` → \`${base}\``,
    '',
    `${changedList.length} file(s) changed · ${touched.length} graph node(s) touched · ` +
      `${addedEdges.length} edge(s) added, ${removedEdges.length} removed`,
    '',
  ];

  // 1. user-visible surface
  lines.push('## What the user sees change');
  lines.push(
    screens.length > 0
      ? screens.map((s) => `- \`${s}\``).join('\n')
      : '_No route reaches this change — it is not directly user-visible in this repo._',
    '',
  );

  // 2. reactivated legacy paths
  lines.push('## 🕰 Reactivated legacy paths');
  if (legacy.length === 0) {
    lines.push('_None. Every newly-wired dependency was either touched by this PR or is actively maintained._', '');
  } else {
    lines.push(
      'This PR routes live traffic into code nobody has changed in months, and that this PR does not update:',
      '',
      ...legacy
        .slice(0, MAX_ROWS)
        .map((h) => `- 🚨 \`${h.from}\` now ${h.kind} \`${h.to}\` — \`${h.file}\`, last commit **${h.days} days ago**`),
      '',
      '_Check that its response shape still matches what the callers expect before merging._',
      '',
    );
  }

  // 3. contract risk
  lines.push('## ⚠️ Contract risk — consumers this PR did not update');
  if (risks.length === 0) {
    lines.push('_Nothing this PR changes is consumed by untouched code._', '');
  } else {
    for (const risk of risks.slice(0, 6)) {
      lines.push(`**\`${risk.target.name}\`** (${risk.target.type}) — ${risk.consumers.length} untouched consumer(s):`);
      for (const c of risk.consumers) {
        const guard = c.unguarded ? ` — ⚠️ unguarded \`${c.unguarded}\`` : '';
        lines.push(`- \`${c.name}\` — ${c.file}:${c.line}${guard}`);
      }
      lines.push('');
    }
    lines.push('_Unguarded = a chained dereference with no `?.` near the call site. Regex heuristic: verify before acting._', '');
  }

  // 4. broken flows
  lines.push('## 💥 Flows that break');
  lines.push(
    broken.length > 0
      ? broken.map((b) => `- ${b}`).join('\n')
      : '_No caller is left pointing at something this PR removes._',
    '',
  );

  // 5. cross-app
  if (!input.skipFleet) {
    lines.push(renderCrossApp(root, after, touched), '');
  }

  // 6. test scope + verdict
  const blockers = legacy.length + broken.length;
  lines.push(
    '## Test scope',
    screens.length > 0
      ? `Re-test end to end: ${screens.slice(0, MAX_ROWS).map((s) => `\`${s}\``).join(', ')}`
      : '_No route-level scope in this repo — see the cross-app section._',
    '',
    `**Verdict:** ${verdict(blockers, risks.length)}`,
    '',
    '_Static analysis: it cannot see feature flags, runtime branches, or URLs built at runtime. ' +
      'It narrows where to look — it does not replace looking._',
  );
  return lines.join('\n');
}

function verdict(blockers: number, risks: number): string {
  if (blockers > 0) return `🚨 **Ship blocker** — ${blockers} reactivated/broken path(s) need a decision before merge.`;
  if (risks > 0) return `⚠️ **Review needed** — ${risks} contract(s) have consumers this PR did not update.`;
  return '✅ **Contained** — no reactivated legacy path, no broken flow, no untouched consumer.';
}

/** Backend endpoints this change can reach, matched against every app in the fleet. */
function renderCrossApp(root: string, after: GraphIndex, touched: GraphNode[]): string {
  let config: FleetConfig | null;
  try {
    config = loadFleetConfig(root);
  } catch (err) {
    return `## Cross-app impact\n\n⚠️ ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!config) {
    return (
      '## Cross-app impact\n\n' +
      `_No \`${WORKSPACE_FILE}\` — this repo is analysed alone. Add one (or run \`impact_across_apps\` ` +
      'once to scaffold it) to also check the customer app, delivery app, and web against this change._'
    );
  }
  const declared = declaredEndpoints(after, touched, config);
  const impacts = fleetImpact(root, config, declared);
  return renderFleetImpact(impacts, declared);
}

export function declaredEndpoints(
  index: GraphIndex,
  touched: GraphNode[],
  config: FleetConfig,
): Endpoint[] {
  const ids = new Set<string>();
  for (const node of touched) {
    if (node.type === 'api') ids.add(node.id);
    for (const dep of index.dependents(node.id)) {
      if (dep.type === 'api') ids.add(dep.id);
    }
  }
  const out: Endpoint[] = [];
  for (const id of ids) {
    const parsed = parseApiId(id);
    if (!parsed) continue;
    out.push(toEndpoint(parsed.method, parsed.url, config.backend?.basePath ? [config.backend.basePath] : []));
  }
  return out.sort((a, b) => a.shape.localeCompare(b.shape));
}
