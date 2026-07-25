/** The project map: routes with their component trees, and the navigation diagram. */

import type { GraphIndex } from '../analyze/graph-index';

/** Markdown project map: route list with component trees and API calls, plus a Mermaid nav diagram. */
export function renderProjectMap(index: GraphIndex): string {
  const routes = index.routes();
  const lines: string[] = ['# Project map', ''];

  if (routes.length === 0) {
    lines.push('_No routes detected (not a Next.js app-router/pages-router project?)._', '');
  }

  for (const route of routes) {
    lines.push(`## \`${route.name}\`${route.file ? `  — ${route.file}` : ''}`);
    const subtree = index.routeSubtree(route.id);
    const components = subtree.filter((n) => n.type === 'component');
    const apis = new Set<string>();
    for (const n of subtree) {
      for (const e of index.outEdges(n.id, ['calls'])) apis.add(e.to.replace(/^api:/, ''));
    }
    if (components.length > 0) {
      lines.push('', renderComponentTree(index, route.id));
    }
    if (apis.size > 0) {
      lines.push('', '**API calls:** ' + [...apis].map((a) => `\`${a}\``).join(', '));
    }
    lines.push('');
  }

  const mermaid = routeNavMermaid(index);
  if (mermaid) {
    lines.push('## Navigation flow', '', '```mermaid', mermaid, '```', '');
  }
  return lines.join('\n');
}

function renderComponentTree(index: GraphIndex, routeId: string): string {
  const lines: string[] = [];
  const visit = (id: string, depth: number, seen: Set<string>) => {
    if (depth > 4 || seen.has(id)) return;
    seen.add(id);
    const node = index.byId.get(id);
    if (!node) return;
    if (node.type === 'component') {
      lines.push(`${'  '.repeat(depth)}- ${node.name}${depth === 0 ? ` (${node.file})` : ''}`);
    }
    for (const e of index.outEdges(id, ['renders'])) visit(e.to, depth + 1, seen);
  };
  for (const e of index.outEdges(routeId, ['routes_to'])) visit(e.to, 0, new Set());
  return lines.join('\n');
}

/** Mermaid flowchart of route → route navigation. */
export function routeNavMermaid(index: GraphIndex): string | null {
  const routes = index.routes();
  if (routes.length === 0) return null;

  // Map every node in each route's subtree back to that route.
  const owner = new Map<string, Set<string>>();
  for (const route of routes) {
    for (const n of index.routeSubtree(route.id)) {
      let set = owner.get(n.id);
      if (!set) owner.set(n.id, (set = new Set()));
      set.add(route.id);
    }
    // The page file itself also belongs to the route.
    if (route.file) {
      let set = owner.get(route.file);
      if (!set) owner.set(route.file, (set = new Set()));
      set.add(route.id);
    }
  }

  const links = new Set<string>();
  for (const edge of index.graph.edges) {
    if (edge.kind !== 'navigates_to') continue;
    const fromRoutes = owner.get(edge.from) ?? new Set<string>();
    for (const fromRoute of fromRoutes) {
      if (fromRoute !== edge.to) links.add(`${fromRoute}-->${edge.to}`);
    }
  }

  const lines = ['flowchart TD'];
  const declared = new Set<string>();
  const declare = (id: string) => {
    if (declared.has(id)) return;
    declared.add(id);
    const label = index.byId.get(id)?.name ?? id.replace(/^route:/, '');
    lines.push(`  ${mermaidId(id)}["${label}"]`);
  };
  for (const route of routes) declare(route.id);
  for (const link of links) {
    const [from, to] = link.split('-->');
    declare(from);
    declare(to);
    lines.push(`  ${mermaidId(from)} --> ${mermaidId(to)}`);
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

function mermaidId(id: string): string {
  return 'n_' + id.replace(/[^A-Za-z0-9]/g, '_');
}
