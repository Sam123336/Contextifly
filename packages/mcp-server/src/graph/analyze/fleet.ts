/**
 * Fleet analysis: one backend, many consumer apps, one question —
 * "if I change this service, which app breaks, and on which screen?"
 *
 * Every app is analysed at its **release** branch (master, then main) — indexed
 * from a detached worktree, so the developer's checkout is never touched. That
 * is the version users are actually running, and the one a backend change can
 * take down.
 *
 * When the repo has a *different* branch checked out, that version is analysed
 * too, working tree and all. The two answers routinely disagree, and the
 * disagreement is the point: a feature branch that already migrated to the new
 * contract reports clean while production is still one merge away from crashing.
 * "Works on my branch" and "works for users" are different questions, so both
 * get asked.
 *
 * Graphs are cached per app+role under .pixelcontextifly/fleet/, keyed by sha —
 * a re-run costs nothing until that branch moves. A dirty working tree is never
 * cached, because a sha no longer describes what is in it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { endpointMatch, parseApiId, toEndpoint, type Endpoint } from './endpoints';
import { isDirty, readGitState, revParse, withWorktree } from '../store/git';
import { indexProject } from '../extract/indexer';
import { GraphIndex } from './graph-index';
import { graphDir } from '../store/graph-store';
import type { GraphNode, ProjectGraph } from '../types';

export const WORKSPACE_FILE = 'contextifly.workspace.json';
const DEFAULT_BRANCHES = ['master', 'main'];
const MAX_CALL_SITES = 6;

export interface FleetApp {
  /** Display name, e.g. "customer-app". */
  name: string;
  /** Path to the app repo — absolute, or relative to the backend root. */
  path: string;
  /** Free-text label for the report ("flutter", "next", "react"). */
  kind?: string;
  /** Branch to analyse. Defaults to master, then main, then the working tree. */
  branch?: string;
  /** Prefix this app prepends to every backend path, e.g. "/api/v1". */
  basePath?: string;
}

export interface FleetConfig {
  /** The backend itself: `basePath` is its global prefix, if it sets one. */
  backend?: { basePath?: string };
  apps: FleetApp[];
}

/**
 * Which line of an app's history a graph came from.
 *
 * `release` is what users are actually running. `checkout` is the branch the
 * developer has open right now, working tree and all. They routinely disagree,
 * and the disagreement is the answer: a backend change can be harmless against
 * the feature branch that already adapted to it, and still take production down.
 */
export type BranchRole = 'release' | 'checkout';

export interface BranchGraph {
  app: FleetApp;
  graph: ProjectGraph;
  /** Branch analysed, or 'working tree' when no branch could be resolved. */
  ref: string;
  role: BranchRole;
  /** True when the cached graph was reused because nothing had moved. */
  reused: boolean;
}

// --- workspace config -------------------------------------------------------

export function workspaceFile(root: string): string {
  return path.join(path.resolve(root), WORKSPACE_FILE);
}

export function loadFleetConfig(root: string): FleetConfig | null {
  const file = workspaceFile(root);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as FleetConfig;
  if (!Array.isArray(parsed.apps)) {
    throw new Error(`${WORKSPACE_FILE} must contain an "apps" array.`);
  }
  for (const app of parsed.apps) {
    if (!app.name || !app.path) {
      throw new Error(`${WORKSPACE_FILE}: every app needs both "name" and "path".`);
    }
  }
  return parsed;
}

/** Write a starter workspace config the user fills in. Never overwrites. */
export function scaffoldFleetConfig(root: string): string {
  const file = workspaceFile(root);
  if (existsSync(file)) return file;
  const example: FleetConfig = {
    backend: { basePath: '' },
    apps: [
      { name: 'customer-app', path: '../customer-app', kind: 'flutter', branch: 'master' },
      { name: 'delivery-app', path: '../delivery-app', kind: 'flutter', branch: 'master' },
      { name: 'web', path: '../web', kind: 'next', branch: 'master' },
    ],
  };
  writeFileSync(file, JSON.stringify(example, null, 2) + '\n');
  return file;
}

// --- per-app graphs ---------------------------------------------------------

function appRoot(backendRoot: string, app: FleetApp): string {
  return path.resolve(backendRoot, app.path);
}

function cacheFile(backendRoot: string, app: FleetApp, role: BranchRole): string {
  const safe = app.name.replace(/[^\w.-]/g, '_');
  return path.join(graphDir(backendRoot), 'fleet', `${safe}.${role}.json`);
}

/**
 * Index one app at one ref. `ref === null` means the working tree as it stands,
 * uncommitted edits included — that is what the developer is actually running.
 *
 * `cacheKey === null` disables caching, which is what a dirty working tree
 * requires: a sha no longer describes the contents.
 */
function loadVariant(
  backendRoot: string,
  app: FleetApp,
  root: string,
  ref: string | null,
  role: BranchRole,
  cacheKey: string | null,
): BranchGraph {
  const cache = cacheFile(backendRoot, app, role);
  if (cacheKey && existsSync(cache)) {
    try {
      const cached = JSON.parse(readFileSync(cache, 'utf8')) as { key: string; graph: ProjectGraph };
      if (cached.key === cacheKey && cached.graph?.version === 2) {
        return { app, graph: cached.graph, ref: ref ?? 'working tree', role, reused: true };
      }
    } catch {
      // corrupt cache: fall through and rebuild.
    }
  }

  const graph = ref
    ? withWorktree(root, ref, (dir) => indexProject(dir, { force: true }).graph)
    : indexProject(root, { force: true }).graph;
  graph.root = root; // the worktree is gone; point file paths at the real repo

  if (cacheKey) {
    mkdirSync(path.dirname(cache), { recursive: true });
    writeFileSync(cache, JSON.stringify({ key: cacheKey, graph }));
  }
  return { app, graph, ref: ref ?? 'working tree', role, reused: false };
}

/**
 * The versions of one app worth analysing.
 *
 * Always the **release** branch (master, then main) — that is what users are
 * running, and it is the version a backend change can actually take down. Plus,
 * when the repo has a different branch checked out, that **checkout** too: the
 * developer needs to know that "works on my branch" and "works in production"
 * are two different questions.
 *
 * Throws when the repo is missing — a fleet answer that silently drops an app is
 * worse than an error, because "not affected" would be a lie.
 */
export function appBranches(backendRoot: string, app: FleetApp): BranchGraph[] {
  const root = appRoot(backendRoot, app);
  if (!existsSync(root)) {
    throw new Error(`App \`${app.name}\`: no directory at ${root} — fix its "path" in ${WORKSPACE_FILE}.`);
  }

  let releaseRef: string | null = null;
  let releaseSha: string | null = null;
  for (const candidate of app.branch ? [app.branch] : DEFAULT_BRANCHES) {
    const resolved = revParse(root, candidate);
    if (resolved) {
      releaseRef = candidate;
      releaseSha = resolved;
      break;
    }
  }

  // Not a git repo, or no master/main: the working tree is all there is.
  if (!releaseRef) {
    return [loadVariant(backendRoot, app, root, null, 'release', null)];
  }

  const out = [loadVariant(backendRoot, app, root, releaseRef, 'release', releaseSha)];

  const state = readGitState(root);
  const onOwnBranch = state && state.branch !== 'HEAD' && state.branch !== releaseRef;
  if (onOwnBranch) {
    // The working tree, not the branch tip: uncommitted work is part of what
    // this developer is running. Cacheable only while the tree is clean.
    const dirty = isDirty(root);
    const key = dirty ? null : `${state.branch}@${state.head}`;
    const checkout = loadVariant(backendRoot, app, root, null, 'checkout', key);
    checkout.ref = dirty ? `${state.branch} (uncommitted changes)` : state.branch;
    out.push(checkout);
  }
  return out;
}

// --- endpoint impact --------------------------------------------------------

export interface CallSite {
  file: string;
  line: number;
  caller: string;
}

export interface AppHit {
  /** The backend endpoint, as declared. */
  endpoint: string;
  /** The path as this app spells it — differs when parameters are interpolated. */
  calledAs: string;
  confidence: number;
  reason?: string;
  callSites: CallSite[];
  /** User-visible screens/routes that reach this call. */
  screens: string[];
}

export interface BranchImpact {
  ref: string;
  role: BranchRole;
  reused: boolean;
  hits: AppHit[];
}

export interface AppImpact {
  app: FleetApp;
  /** One entry per analysed version: always release, plus the checkout when it differs. */
  branches: BranchImpact[];
  /** Set when this app could not be analysed at all — never treated as "safe". */
  error?: string;
}

/** True when any analysed version of this app is affected. */
export function isAffected(impact: AppImpact): boolean {
  return impact.branches.some((b) => b.hits.length > 0);
}

/** Endpoints a change to `targetId` can reach: declared APIs among its dependents. */
export function affectedEndpoints(index: GraphIndex, targetId: string): GraphNode[] {
  const self = index.byId.get(targetId);
  const reachable = index.dependents(targetId).filter((n) => n.type === 'api');
  if (self?.type === 'api') reachable.unshift(self);
  // Declared endpoints first: those are the ones this backend owns and can break.
  return reachable.sort((a, b) => Number(b.declared ?? 0) - Number(a.declared ?? 0));
}

/** Every endpoint an app calls, with the call sites and screens behind each. */
function calledEndpoints(
  index: GraphIndex,
  stripPrefixes: string[],
): { endpoint: Endpoint; node: GraphNode }[] {
  const out: { endpoint: Endpoint; node: GraphNode }[] = [];
  for (const node of index.graph.nodes) {
    if (node.type !== 'api' || node.declared) continue;
    const parsed = parseApiId(node.id);
    if (!parsed) continue;
    out.push({ endpoint: toEndpoint(parsed.method, parsed.url, stripPrefixes), node });
  }
  return out;
}

/** Screen-shaped widget/component names, for stacks without a route table. */
const SCREEN_NAME = /(Screen|Page|View|Route|Activity|Fragment)$/;

/**
 * The user-visible surfaces behind an endpoint.
 *
 * On the web a route owns its component, so routes fall out of the dependent
 * walk. Flutter apps often have no route table at all — there the screen *is* a
 * widget, so named screen widgets are the honest answer rather than "unknown".
 */
function screensFor(index: GraphIndex, apiId: string): string[] {
  const dependents = index.dependents(apiId);
  const routes = dependents.filter((n) => n.type === 'route').map((n) => n.name);
  if (routes.length > 0) return [...new Set(routes)].sort();

  const widgets = dependents
    .filter((n) => (n.type === 'component' || n.type === 'controller') && SCREEN_NAME.test(n.name))
    .map((n) => n.name);
  for (const edge of index.inEdges(apiId, ['calls'])) {
    const caller = index.byId.get(edge.from);
    if (caller && SCREEN_NAME.test(caller.name)) widgets.push(caller.name);
  }
  return [...new Set(widgets)].sort();
}

function callSitesFor(index: GraphIndex, apiId: string): CallSite[] {
  const sites: CallSite[] = [];
  for (const edge of index.inEdges(apiId, ['calls'])) {
    if (!edge.source) continue;
    sites.push({
      file: edge.source.file,
      line: edge.source.line,
      caller: index.byId.get(edge.from)?.name ?? edge.from,
    });
  }
  return sites.slice(0, MAX_CALL_SITES);
}

/**
 * Match a set of backend endpoints against one app's graph.
 * The empty-hits case is a *proof of non-impact*, not a shrug: reachability is
 * a closed set, so an app with no matching call genuinely cannot be affected
 * through the HTTP boundary.
 */
export function impactOnBranch(
  branch: BranchGraph,
  declared: Endpoint[],
  backendBasePath: string | undefined,
): BranchImpact {
  const index = new GraphIndex(branch.graph);
  const strip = [branch.app.basePath, backendBasePath].filter((p): p is string => !!p);
  const hits: AppHit[] = [];

  for (const { endpoint: called, node } of calledEndpoints(index, strip)) {
    for (const target of declared) {
      const match = endpointMatch(target, called);
      if (!match.matched) continue;
      hits.push({
        endpoint: `${target.method} ${target.raw}`,
        calledAs: `${called.method} ${called.raw}`,
        confidence: match.confidence,
        reason: match.reason,
        callSites: callSitesFor(index, node.id),
        screens: screensFor(index, node.id),
      });
      break; // one hit per call site; the first (best) declared match wins
    }
  }
  hits.sort((a, b) => b.confidence - a.confidence || b.screens.length - a.screens.length);
  return { ref: branch.ref, role: branch.role, reused: branch.reused, hits };
}

/**
 * What the release branch and the developer's checkout disagree about — the
 * "works on my branch, breaks in production" case, stated out loud.
 */
export function divergence(branches: BranchImpact[]): string | null {
  const release = branches.find((b) => b.role === 'release');
  const checkout = branches.find((b) => b.role === 'checkout');
  if (!release || !checkout) return null;

  // The "(uncommitted changes)" marker belongs in the branch header, not in
  // every sentence of the prose below.
  const name = (b: BranchImpact) => b.ref.replace(/\s*\(.*\)$/, '');
  const key = (b: BranchImpact) => new Set(b.hits.map((h) => h.endpoint));
  const onRelease = key(release);
  const onCheckout = key(checkout);
  const onlyRelease = [...onRelease].filter((e) => !onCheckout.has(e));
  const onlyCheckout = [...onCheckout].filter((e) => !onRelease.has(e));

  if (onlyRelease.length === 0 && onlyCheckout.length === 0) {
    return onRelease.size > 0
      ? `Both \`${name(release)}\` and \`${name(checkout)}\` call these endpoints — your branch does not change the exposure.`
      : null;
  }
  const parts: string[] = [];
  if (onlyRelease.length > 0) {
    parts.push(
      `⚠️ **Breaks on \`${name(release)}\`, not on \`${name(checkout)}\`** — ` +
        `${onlyRelease.map((e) => `\`${e}\``).join(', ')}. Your branch has already adapted; ` +
        `what ships to users has not. Merging the backend change before \`${name(checkout)}\` ` +
        `lands breaks production, and your local testing will not show it.`,
    );
  }
  if (onlyCheckout.length > 0) {
    parts.push(
      `🔎 **New on \`${name(checkout)}\`, absent from \`${name(release)}\`** — ` +
        `${onlyCheckout.map((e) => `\`${e}\``).join(', ')}. Your branch introduces this ` +
        `dependency, so the two must ship together or in the right order.`,
    );
  }
  return parts.join('\n\n');
}

/** Analyse every app in the fleet against a set of backend endpoints. */
export function fleetImpact(
  backendRoot: string,
  config: FleetConfig,
  declared: Endpoint[],
): AppImpact[] {
  return config.apps.map((app) => {
    try {
      const branches = appBranches(backendRoot, app).map((b) =>
        impactOnBranch(b, declared, config.backend?.basePath),
      );
      return { app, branches };
    } catch (err) {
      return {
        app,
        branches: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

// --- rendering --------------------------------------------------------------

/** True when this app ships to devices and cannot be hotfixed. */
function isMobile(app: FleetApp): boolean {
  return /flutter|dart|android|ios|react-?native|mobile/i.test(`${app.kind ?? ''} ${app.name}`);
}

/**
 * The non-PR question: "I am about to change this service — who breaks?"
 * Same engine as the PR simulation, entered from a single node instead of a diff.
 */
export function renderImpactAcrossApps(root: string, index: GraphIndex, target: string): string {
  const resolved = index.resolve(target);
  if (resolved.length === 0) {
    return `No graph node matches \`${target}\` — try \`search_graph\` first.`;
  }
  const node = resolved[0];

  let config: FleetConfig | null;
  try {
    config = loadFleetConfig(root);
  } catch (err) {
    return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!config) {
    const file = scaffoldFleetConfig(root);
    return [
      `# Cross-app impact of changing \`${node.name}\``,
      '',
      `I created a starter workspace config at \`${file}\`.`,
      '',
      'Fill in the real repo paths for your apps (delete the ones you do not have), then run this again:',
      '',
      '```json',
      readFileSync(file, 'utf8').trimEnd(),
      '```',
      '',
      '- `path` — absolute, or relative to this backend repo',
      '- `branch` — defaults to `master`, then `main`; each app is analysed there, never on whatever branch it has checked out',
      '- `basePath` — set it when the app calls `/api/orders` but the backend declares `/orders`',
    ].join('\n');
  }

  const endpointNodes = affectedEndpoints(index, node.id);
  const strip = config.backend?.basePath ? [config.backend.basePath] : [];
  const declared: Endpoint[] = [];
  for (const api of endpointNodes) {
    const parsed = parseApiId(api.id);
    if (parsed) declared.push(toEndpoint(parsed.method, parsed.url, strip));
  }

  const impacts = fleetImpact(root, config, declared);
  const total = impacts.reduce(
    (n, i) => n + i.branches.reduce((m, b) => m + b.hits.length, 0),
    0,
  );
  return [
    `# Cross-app impact of changing \`${node.name}\` (${node.type})`,
    '',
    `Reaches **${declared.length} endpoint(s)** · **${impacts.filter(isAffected).length}** of ` +
      `${impacts.length} app(s) affected · ${total} call site(s)`,
    '',
    renderFleetImpact(impacts, declared, ''),
    '_Endpoints are matched across repos by path shape — parameterised segments cannot be compared literally. ' +
      'Confidence is shown wherever the match is not exact._',
  ].join('\n');
}

export function renderFleetImpact(
  impacts: AppImpact[],
  declared: Endpoint[],
  heading = '## Cross-app impact',
): string {
  const lines: string[] = [];
  if (heading) lines.push(heading, '');
  if (declared.length === 0) {
    lines.push('_No backend endpoint is reachable from this change — no app can be affected through HTTP._');
    return lines.join('\n');
  }
  lines.push(
    `Endpoints in play: ${declared.map((e) => `\`${e.method} ${e.raw}\``).join(', ')}`,
    '',
  );

  const affected = impacts.filter((i) => !i.error && isAffected(i));
  const clean = impacts.filter((i) => !i.error && !isAffected(i));
  const failed = impacts.filter((i) => i.error);

  const roleLabel = (b: BranchImpact) =>
    b.role === 'release' ? `\`${b.ref}\` — what ships to users` : `\`${b.ref}\` — your checkout`;

  for (const impact of affected) {
    const total = impact.branches.reduce((n, b) => n + b.hits.length, 0);
    lines.push(
      `### 🚨 ${impact.app.name}${impact.app.kind ? ` (${impact.app.kind})` : ''} — ${total} affected call(s)`,
      '',
    );

    for (const branch of impact.branches) {
      const icon = branch.hits.length > 0 ? '🚨' : '✅';
      lines.push(`**${icon} ${roleLabel(branch)}**${branch.reused ? ' _(cached)_' : ''}`);
      if (branch.hits.length === 0) {
        lines.push('- calls none of these endpoints', '');
        continue;
      }
      for (const hit of branch.hits) {
        const flag = hit.confidence < 1 ? ` _(${Math.round(hit.confidence * 100)}% match — ${hit.reason})_` : '';
        lines.push(`- **${hit.endpoint}** — called as \`${hit.calledAs}\`${flag}`);
        if (hit.screens.length > 0) {
          lines.push(`  - screens: ${hit.screens.map((s) => `\`${s}\``).join(', ')}`);
        }
        for (const site of hit.callSites) {
          lines.push(`  - \`${site.caller}\` — ${site.file}:${site.line}`);
        }
      }
      lines.push('');
    }

    const diverged = divergence(impact.branches);
    if (diverged) lines.push(diverged, '');

    if (isMobile(impact.app)) {
      lines.push(
        '> ⚠️ **Shipped versions cannot be hotfixed.** Users on already-installed builds keep ' +
          'calling the old contract. Any change to these endpoints must stay backward-compatible ' +
          'until the old app versions are drained.',
        '',
      );
    }
  }

  if (clean.length > 0) {
    lines.push(
      `### ✅ Not affected`,
      clean
        .map(
          (i) =>
            `- **${i.app.name}** (${i.branches.map((b) => `\`${b.ref}\``).join(' + ')}) — calls none of these endpoints`,
        )
        .join('\n'),
      '',
      '_Proof, not a guess: reachability is a closed set — these apps have no HTTP path to the change._',
      '',
    );
  }

  if (failed.length > 0) {
    lines.push('### ⚠️ Could not analyse');
    for (const f of failed) lines.push(`- **${f.app.name}** — ${f.error}`);
    lines.push('', '_Treat these as unknown, not safe._', '');
  }
  return lines.join('\n');
}
