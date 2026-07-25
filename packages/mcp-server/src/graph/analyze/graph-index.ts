/**
 * The in-memory index every analyzer runs on: nodes by id, edges in both
 * directions, and the three traversals everything else is built from —
 * `resolve` (name → node), `routeSubtree` (what a screen renders) and
 * `dependents` (what breaks if this changes).
 */

import type { EdgeKind, GraphEdge, GraphNode, ProjectGraph } from '../types';

/** Max depth for render-tree walks — deep enough for real trees, bounded against cycles. */
export const RENDER_DEPTH = 10;

export class GraphIndex {
  readonly byId = new Map<string, GraphNode>();
  private readonly out = new Map<string, GraphEdge[]>();
  private readonly into = new Map<string, GraphEdge[]>();

  constructor(readonly graph: ProjectGraph) {
    for (const node of graph.nodes) this.byId.set(node.id, node);
    for (const edge of graph.edges) {
      push(this.out, edge.from, edge);
      push(this.into, edge.to, edge);
    }
  }

  outEdges(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    return filterKinds(this.out.get(id) ?? [], kinds);
  }

  inEdges(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    return filterKinds(this.into.get(id) ?? [], kinds);
  }

  routes(): GraphNode[] {
    return this.graph.nodes
      .filter((n) => n.type === 'route')
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve a user-supplied target (node id, component name, file path, or
   * route path) to matching nodes — best match first: exact name beats id
   * suffix, and components/routes beat synthesized api nodes.
   */
  resolve(target: string): GraphNode[] {
    const exact = this.byId.get(target) ?? this.byId.get(`route:${target}`);
    if (exact) return [exact];
    const t = target.toLowerCase();
    const typeRank: Record<string, number> = {
      component: 0, route: 1, hook: 2, context: 3, api: 4, channel: 4, file: 5, native: 6,
    };
    const score = (n: GraphNode): number => {
      if (n.name.toLowerCase() === t || n.id.toLowerCase() === t) return 100;
      if (n.id.toLowerCase().endsWith(`#${t}`)) return 80;
      if (n.id.toLowerCase().endsWith(`/${t}`)) return 60;
      return 0;
    };
    const rank = (n: GraphNode) => score(n) * 10 - (typeRank[n.type] ?? 9);
    const matches = this.graph.nodes.filter((n) => score(n) > 0);
    if (matches.length > 0) return matches.sort((a, b) => rank(b) - rank(a));
    return this.graph.nodes.filter((n) => n.id.toLowerCase().includes(t));
  }

  /** All nodes reachable from a route's page component via renders edges. */
  routeSubtree(routeId: string): GraphNode[] {
    const start = this.outEdges(routeId, ['routes_to']).map((e) => e.to);
    const seen = new Set<string>(start);
    let frontier = start;
    for (let depth = 0; depth < RENDER_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.outEdges(id, ['renders', 'defines'])) {
          if (!seen.has(e.to)) {
            seen.add(e.to);
            next.push(e.to);
          }
        }
      }
      frontier = next;
    }
    return [...seen].map((id) => this.byId.get(id)).filter((n): n is GraphNode => !!n);
  }

  /**
   * Transitive dependents: everything that could break if `nodeId` changes.
   * Walks all edge kinds in reverse (dependent → dependency).
   */
  dependents(nodeId: string): GraphNode[] {
    const seen = new Set<string>([nodeId]);
    const result: GraphNode[] = [];
    let frontier = [nodeId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.inEdges(id)) {
          if (seen.has(e.from)) continue;
          seen.add(e.from);
          const node = this.byId.get(e.from);
          if (node) {
            result.push(node);
            next.push(e.from);
          }
        }
      }
      frontier = next;
    }
    return result;
  }
}

function push(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge) {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function filterKinds(edges: GraphEdge[], kinds?: EdgeKind[]): GraphEdge[] {
  return kinds ? edges.filter((e) => kinds.includes(e.kind)) : edges;
}
