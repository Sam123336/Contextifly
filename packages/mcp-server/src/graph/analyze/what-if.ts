/** Single-node simulation: remove / split / lazy-load, answered from the graph. */

import type { GraphNode } from '../types';
import { RENDER_DEPTH, type GraphIndex } from './graph-index';

export type WhatIfAction = 'remove' | 'split' | 'lazy_load';

/**
 * Simulate a change against the graph before touching code.
 * Deterministic traversal — the "what breaks / what's safe" answer an LLM
 * cannot reliably produce without re-reading the whole project.
 */
export function whatIf(index: GraphIndex, action: WhatIfAction, target: string): string {
  const resolved = index.resolve(target);
  if (resolved.length === 0) {
    return `No graph node matches \`${target}\` — try search_graph first.`;
  }
  const node = resolved[0];
  const note =
    resolved.length > 1
      ? `\n\n_${resolved.length - 1} other match(es) ignored — pass a more specific target._`
      : '';

  switch (action) {
    case 'remove':
      return simulateRemove(index, node) + note;
    case 'split':
      return simulateSplit(index, node) + note;
    case 'lazy_load':
      return simulateLazyLoad(index, node) + note;
  }
}

function simulateRemove(index: GraphIndex, node: GraphNode): string {
  const direct = index
    .inEdges(node.id)
    .map((e) => ({ edge: e, from: index.byId.get(e.from) }))
    .filter((d) => d.from && d.from.type !== 'file'); // defines/imports are mechanical, not breakage
  const deps = index.dependents(node.id);
  const affectedRoutes = new Set(deps.filter((d) => d.type === 'route').map((d) => d.name));
  const safeRoutes = index
    .routes()
    .filter((r) => r.file && !affectedRoutes.has(r.name))
    .map((r) => r.name);
  const filesTouched = new Set<string>([node.file ?? '']);
  for (const { from } of direct) if (from?.file) filesTouched.add(from.file);
  filesTouched.delete('');

  const risk = affectedRoutes.size >= 3 || deps.length >= 20 ? 'High' : affectedRoutes.size >= 1 || deps.length >= 6 ? 'Medium' : 'Low';

  const lines = [
    `# What if I remove \`${node.name}\` (${node.type})?`,
    '',
    `**Breaks immediately** — ${direct.length} direct reference(s):`,
    ...direct
      .slice(0, 15)
      .map((d) => `- \`${d.from!.name}\` (${d.from!.type}) —${d.edge.kind}→ \`${node.name}\``),
    '',
    `**At risk transitively:** ${deps.filter((d) => d.type === 'component').length} components across ${affectedRoutes.size} route(s)` +
      (affectedRoutes.size > 0 ? `: ${[...affectedRoutes].map((r) => `\`${r}\``).join(', ')}` : ''),
    safeRoutes.length > 0 ? `**Unaffected routes:** ${safeRoutes.map((r) => `\`${r}\``).join(', ')}` : '',
    '',
    `**Estimated files to touch:** ${filesTouched.size}`,
    `**Regression risk:** ${risk}`,
  ];
  if (node.type === 'context') {
    const consumers = index.inEdges(node.id, ['uses']).length;
    lines.push(
      '',
      `_This is a state container with ${consumers} consumer(s) — each needs a replacement state source before removal._`,
    );
  }
  return lines.filter((l) => l !== undefined).join('\n');
}

function simulateSplit(index: GraphIndex, node: GraphNode): string {
  const renderers = index.inEdges(node.id, ['renders', 'routes_to']);
  const children = index.outEdges(node.id, ['renders']).map((e) => index.byId.get(e.to));
  const state = index.outEdges(node.id, ['uses']).map((e) => index.byId.get(e.to));
  const apis = index.outEdges(node.id, ['calls']).map((e) => index.byId.get(e.to));

  const lines = [
    `# What if I split \`${node.name}\`?`,
    '',
    `**Size:** ${node.loc ?? '?'} lines · renders ${children.length} child component(s) · ` +
      `uses ${state.length} state source(s) · calls ${apis.length} API(s)`,
    '',
    `**Call sites to update after the split:** ${renderers.length}`,
    ...renderers.slice(0, 10).map((e) => `- \`${index.byId.get(e.from)?.name ?? e.from}\``),
    '',
  ];
  if (children.length > 0) {
    lines.push(
      '**Natural split boundaries** (each child cluster + the state/APIs only it needs):',
      ...children.filter(Boolean).map((c) => `- extract around \`${c!.name}\``),
      '',
    );
  }
  if (state.length > 1) {
    lines.push(
      `_It touches ${state.length} state sources (${state.filter(Boolean).map((s) => `\`${s!.name}\``).join(', ')}) — ` +
        'splitting along state boundaries usually reduces re-renders the most._',
    );
  }
  const verdict =
    (node.loc ?? 0) >= 150 || children.length >= 5
      ? 'Worth splitting — size/fan-out above healthy thresholds.'
      : 'Marginal benefit — the component is not oversized; split only if it clarifies ownership.';
  lines.push('', `**Verdict:** ${verdict}`);
  return lines.join('\n');
}

function simulateLazyLoad(index: GraphIndex, node: GraphNode): string {
  // Route target: defer its exclusive subtree. Component target: defer it + its subtree.
  const isRoute = node.type === 'route';
  const subtree = isRoute
    ? index.routeSubtree(node.id)
    : [node, ...collectRenderSubtree(index, node.id)];
  const subtreeIds = new Set(subtree.map((n) => n.id));

  // Which of those nodes are ALSO reachable from other routes (stay in shared bundles)?
  const otherRoutes = index.routes().filter((r) => r.file && r.id !== node.id);
  const sharedIds = new Set<string>();
  for (const r of otherRoutes) {
    if (!isRoute && r.name === node.name) continue;
    for (const n of index.routeSubtree(r.id)) {
      if (subtreeIds.has(n.id)) sharedIds.add(n.id);
    }
  }
  const exclusive = subtree.filter((n) => n.type === 'component' && !sharedIds.has(n.id) && n.id !== node.id);
  const shared = subtree.filter((n) => n.type === 'component' && sharedIds.has(n.id));
  const entries = index.inEdges(node.id, isRoute ? ['navigates_to'] : ['renders', 'routes_to']);
  const exclusiveLoc = exclusive.reduce((sum, n) => sum + (n.loc ?? 0), 0);

  const verdict =
    exclusive.length >= 3 || exclusiveLoc > 200
      ? 'Worthwhile — a meaningful exclusive subtree would move out of the initial bundle.'
      : 'Minimal gain — most of this subtree is shared with other routes and stays in the bundle anyway.';

  return [
    `# What if I lazy-load \`${node.name}\`?`,
    '',
    `**Deferred (exclusive to this ${isRoute ? 'route' : 'component'}):** ${exclusive.length} component(s), ~${exclusiveLoc} lines` +
      (exclusive.length > 0 ? ` — ${exclusive.slice(0, 8).map((n) => `\`${n.name}\``).join(', ')}` : ''),
    `**Stays in shared bundle:** ${shared.length} component(s) also used elsewhere` +
      (shared.length > 0 ? ` — ${shared.slice(0, 8).map((n) => `\`${n.name}\``).join(', ')}` : ''),
    `**Loading boundaries to add:** ${entries.length} entry point(s) will need a loading state`,
    '',
    `**Verdict:** ${verdict}`,
    '',
    '_Line counts are a structural proxy — confirm byte sizes with your bundler analyzer._',
  ].join('\n');
}

function collectRenderSubtree(index: GraphIndex, id: string): GraphNode[] {
  const seen = new Set<string>([id]);
  const out: GraphNode[] = [];
  let frontier = [id];
  for (let depth = 0; depth < RENDER_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of index.outEdges(cur, ['renders'])) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const n = index.byId.get(e.to);
        if (n) {
          out.push(n);
          next.push(e.to);
        }
      }
    }
    frontier = next;
  }
  return out;
}
