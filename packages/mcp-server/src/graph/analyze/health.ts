/** Architecture score: circular imports, dead code, unused endpoints, oversized components. */

import type { GraphNode } from '../types';
import type { GraphIndex } from './graph-index';

/** Next.js entry-point files whose components are invoked by the framework, not by imports. */
const FRAMEWORK_ENTRY = new Set([
  'page', 'layout', 'template', 'error', 'loading', 'not-found',
  'global-error', 'default', 'middleware', '_app', '_document',
]);

function baseName(file: string | undefined): string {
  if (!file) return '';
  const b = file.split('/').pop() ?? '';
  return b.replace(/\.[^.]+$/, '');
}

export interface AnalysisReport {
  score: number;
  markdown: string;
}

export function analyzeProject(index: GraphIndex): AnalysisReport {
  const nodes = index.graph.nodes;

  // 1. Circular imports — SCCs of size > 1 in the file-import graph.
  const cycles = importCycles(index);

  // 2. Dead code — components nobody renders/routes to, hooks nobody uses.
  //    Framework entry files are excluded (Next.js calls them, not imports).
  const deadComponents = nodes.filter(
    (n) =>
      n.type === 'component' &&
      !FRAMEWORK_ENTRY.has(baseName(n.file)) &&
      index.inEdges(n.id, ['renders', 'routes_to']).length === 0,
  );
  const deadHooks = nodes.filter(
    (n) => n.type === 'hook' && index.inEdges(n.id, ['uses']).length === 0,
  );

  // 3. Declared API routes that no frontend code calls. An endpoint counts as
  //    called when it has an incoming `calls` edge (declared + called merge
  //    into one node), or when a called node's path shape matches it (Next.js
  //    `api:ROUTE` handlers carry no method, so they stay separate nodes).
  const called = nodes.filter(
    (n) => n.type === 'api' && index.inEdges(n.id, ['calls']).length > 0,
  );
  const calledPaths = called.map((n) => n.name.split(' ').pop() ?? '');
  const unusedApis = nodes.filter(
    (n) =>
      n.type === 'api' &&
      n.declared &&
      index.inEdges(n.id, ['calls']).length === 0 &&
      !calledPaths.some((p) => samePathShape(p, n.name)),
  );

  // 4. Oversized components/hooks.
  const large = nodes
    .filter((n) => (n.loc ?? 0) >= 150)
    .sort((a, b) => (b.loc ?? 0) - (a.loc ?? 0));

  // 5. Same component name declared in multiple files.
  const byName = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.type !== 'component' || FRAMEWORK_ENTRY.has(baseName(n.file))) continue;
    const list = byName.get(n.name);
    if (list) list.push(n);
    else byName.set(n.name, [n]);
  }
  const duplicates = [...byName.entries()].filter(([, list]) => list.length > 1);

  // 6. Structural duplicates — different names, identical normalized JSX
  //    shape (the copy-pasted-then-renamed components name matching misses).
  const byShape = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.type !== 'component' || !n.shape || FRAMEWORK_ENTRY.has(baseName(n.file))) continue;
    const list = byShape.get(n.shape);
    if (list) list.push(n);
    else byShape.set(n.shape, [n]);
  }
  const structuralDups = [...byShape.values()].filter(
    // >1 distinct names: same-name shape twins are already in `duplicates`.
    (list) => list.length > 1 && new Set(list.map((n) => n.name)).size > 1,
  );

  // 7. Native bridge integrity — platform channels the Dart side invokes with no
  //    native handler (a MissingPluginException waiting to happen), and native
  //    handlers no Dart code invokes (dead bridge). Channel-level & best-effort:
  //    names built dynamically or handled in unscanned/plugin code aren't
  //    resolved, so these are hints to verify, not proofs.
  const channels = nodes.filter((n) => n.type === 'channel');
  const danglingChannels = channels.filter(
    (c) =>
      index.inEdges(c.id, ['invokes']).length > 0 &&
      index.inEdges(c.id, ['handles']).length === 0,
  );
  const orphanHandlers = channels.filter(
    (c) =>
      index.inEdges(c.id, ['handles']).length > 0 &&
      index.inEdges(c.id, ['invokes']).length === 0,
  );

  const penalty =
    Math.min(24, cycles.length * 8) +
    Math.min(16, (deadComponents.length + deadHooks.length) * 2) +
    Math.min(15, large.length * 3) +
    Math.min(10, unusedApis.length * 2) +
    Math.min(10, duplicates.length * 2) +
    Math.min(10, structuralDups.length * 2) +
    Math.min(12, danglingChannels.length * 4) +
    Math.min(6, orphanHandlers.length * 2);
  const score = Math.max(0, 100 - penalty);
  const grade =
    score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'needs attention';

  const check = (bad: number, okMsg: string, badMsg: string) =>
    bad === 0 ? `- ✓ ${okMsg}` : `- ⚠ ${badMsg}`;

  const lines: string[] = [
    `# Architecture score: ${score}/100 (${grade})`,
    '',
    check(cycles.length, 'No circular imports', `${cycles.length} circular import chain(s)`),
    check(
      deadComponents.length + deadHooks.length,
      'No dead components or hooks',
      `${deadComponents.length + deadHooks.length} unreferenced component(s)/hook(s)`,
    ),
    check(large.length, 'All components reasonably sized', `${large.length} component(s) over 150 lines`),
    check(unusedApis.length, 'All declared API routes are used', `${unusedApis.length} API route(s) never called from the UI`),
    check(duplicates.length, 'No duplicate component names', `${duplicates.length} component name(s) defined in multiple files`),
    check(structuralDups.length, 'No structural duplicates', `${structuralDups.length} group(s) of structurally identical components`),
    ...(channels.length > 0
      ? [
          check(
            danglingChannels.length,
            'Every invoked platform channel has a native handler',
            `${danglingChannels.length} platform channel(s) invoked from Dart with no native handler`,
          ),
        ]
      : []),
    '',
  ];

  if (cycles.length > 0) {
    lines.push('## Circular imports');
    for (const cycle of cycles.slice(0, 8)) {
      lines.push(`- ${cycle.map((f) => `\`${f}\``).join(' → ')} → back to start`);
    }
    lines.push('');
  }
  if (deadComponents.length + deadHooks.length > 0) {
    lines.push('## Possibly dead code');
    for (const n of [...deadComponents, ...deadHooks].slice(0, 20)) {
      lines.push(`- ${n.type}: \`${n.id}\``);
    }
    lines.push(
      '',
      '_Static analysis only — verify before deleting. Barrel re-exports (`export * from`), ' +
        'dynamic imports, and usage from files outside this project are not tracked._',
      '',
    );
  }
  if (unusedApis.length > 0) {
    lines.push('## API routes never called from the UI');
    for (const n of unusedApis.slice(0, 20)) lines.push(`- \`${n.name}\` — ${n.file}`);
    lines.push('', '_May be called by external clients, webhooks, or server code._', '');
  }
  if (large.length > 0) {
    lines.push('## Large components (>150 lines — consider splitting)');
    for (const n of large.slice(0, 10)) lines.push(`- \`${n.id}\` — ${n.loc} lines`);
    lines.push('');
  }
  if (duplicates.length > 0) {
    lines.push('## Duplicate component names (merge or rename?)');
    for (const [name, list] of duplicates.slice(0, 10)) {
      lines.push(`- \`${name}\`: ${list.map((n) => `\`${n.file}\``).join(', ')}`);
    }
    lines.push('');
  }
  if (structuralDups.length > 0) {
    lines.push('## Structural duplicates (same JSX shape, different names — merge candidates)');
    for (const list of structuralDups.slice(0, 10)) {
      lines.push(
        `- ${list.map((n) => `\`${n.id}\`${n.loc ? ` (${n.loc} lines)` : ''}`).join(' ≈ ')}`,
      );
    }
    lines.push(
      '',
      '_Shape compares normalized element/attribute structure; text and values may differ. ' +
        'Read both before merging — identical shape does not guarantee identical purpose._',
      '',
    );
  }

  if (danglingChannels.length > 0) {
    lines.push('## Platform channels invoked from Dart with no native handler');
    for (const c of danglingChannels.slice(0, 15)) {
      const callers = index.inEdges(c.id, ['invokes']).map((e) => e.from);
      const shown = callers.slice(0, 3).map((f) => `\`${f}\``).join(', ');
      const more = callers.length > 3 ? ` +${callers.length - 3} more` : '';
      lines.push(`- \`${c.name}\` — invoked from ${shown}${more}; no Android/iOS handler found`);
    }
    lines.push(
      '',
      '_Runtime MissingPluginException risk. Channel-level static scan — a name built ' +
        'dynamically, or handled in a plugin/unscanned file, will show here as a false ' +
        'positive. Verify against the native source before acting._',
      '',
    );
  }
  if (orphanHandlers.length > 0) {
    lines.push('## Native channel handlers with no Dart caller');
    for (const c of orphanHandlers.slice(0, 15)) {
      const handlers = index.inEdges(c.id, ['handles']).map((e) => e.from);
      lines.push(`- \`${c.name}\` — handled in ${handlers.map((f) => `\`${f}\``).join(', ')}; no Dart invokeMethod found`);
    }
    lines.push('', '_Possibly dead native bridge code, or invoked from Dart via a dynamic channel name._', '');
  }

  // Component heatmap: most-depended-on components = highest change risk.
  const componentHeat = nodes
    .filter((n) => n.type === 'component')
    .map((n) => ({ n, renderers: index.inEdges(n.id, ['renders', 'routes_to']).length }))
    .filter((h) => h.renderers > 0)
    .sort((a, b) => b.renderers - a.renderers)
    .slice(0, 8);
  if (componentHeat.length > 0) {
    lines.push('## Usage hotspots (change with care)');
    for (const { n, renderers } of componentHeat) {
      const routes = index.dependents(n.id).filter((d) => d.type === 'route').length;
      const stars = '★'.repeat(Math.min(5, 1 + Math.floor(renderers / 3)));
      lines.push(
        `- \`${n.name}\` — rendered from ${renderers} place(s), reaches ${routes} route(s) ${stars}`,
      );
    }
    lines.push('');
  }

  // State fan-out: contexts consumed by many components → re-render risk.
  const stateFanout = nodes
    .filter((n) => n.type === 'context')
    .map((n) => ({ n, consumers: index.inEdges(n.id, ['uses']).length }))
    .filter((h) => h.consumers > 0)
    .sort((a, b) => b.consumers - a.consumers);
  if (stateFanout.length > 0) {
    lines.push('## State fan-out');
    for (const { n, consumers } of stateFanout.slice(0, 6)) {
      const warn = consumers >= 15 ? ' ⚠ high re-render risk — consider splitting' : '';
      lines.push(`- \`${n.name}\` — consumed by ${consumers} component(s)${warn}`);
    }
    lines.push('');
  }

  lines.push(
    '---',
    '_Score = 100 − penalties (cycles −8 each, dead code −2, large components −3, ' +
      'unused APIs −2, duplicate names −2; each category capped). Structural metrics ' +
      'only — it cannot judge naming, correctness, or design quality._',
  );
  return { score, markdown: lines.join('\n') };
}

/** Two endpoint paths match if segments align, treating :params as wildcards. */
function samePathShape(a: string, b: string): boolean {
  const as = a.split('/').filter(Boolean);
  const bs = b.split('/').filter(Boolean);
  return (
    as.length === bs.length &&
    as.every((s, i) => s === bs[i] || s.startsWith(':') || bs[i].startsWith(':'))
  );
}

/** Tarjan SCC over file→file import edges; returns cycles (SCCs of size > 1). */
function importCycles(index: GraphIndex): string[][] {
  const files = index.graph.nodes.filter((n) => n.type === 'file').map((n) => n.id);
  let counter = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const strongConnect = (v: string) => {
    idx.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const e of index.outEdges(v, ['imports'])) {
      const w = e.to;
      if (!idx.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1) cycles.push(scc.reverse());
    }
  };

  for (const f of files) if (!idx.has(f)) strongConnect(f);
  return cycles;
}
