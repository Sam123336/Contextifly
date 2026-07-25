/** Finding nodes by name: text search, and screenshot-element → component matching. */

import type { GraphNode } from '../types';
import type { GraphIndex } from './graph-index';

export interface SearchHit {
  node: GraphNode;
  score: number;
  relations: string[];
}

/** Case-insensitive search over node names and ids, best matches first. */
export function searchNodes(index: GraphIndex, query: string, limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const node of index.graph.nodes) {
    const name = node.name.toLowerCase();
    const id = node.id.toLowerCase();
    let score = 0;
    if (name === q || id === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (id.includes(q)) score = 40;
    if (score === 0) continue;
    hits.push({ node, score, relations: describeRelations(index, node.id) });
  }
  return hits.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, limit);
}

// --- screenshot ↔ code matching -------------------------------------------

export interface UiMatch {
  node: GraphNode;
  score: number;
  /** Routes whose render tree contains this node (where it appears visually). */
  routes: string[];
}

/**
 * Match a UI element description ("Orange Checkout Button", "ProductCard")
 * against graph nodes: whole phrase first, then per-token, scores summed.
 */
export function matchUiElement(index: GraphIndex, description: string): UiMatch[] {
  const scores = new Map<string, number>();
  const add = (hits: SearchHit[], weight: number) => {
    for (const h of hits) {
      if (h.node.type === 'file') continue; // files aren't UI elements
      scores.set(h.node.id, (scores.get(h.node.id) ?? 0) + h.score * weight);
    }
  };
  add(searchNodes(index, description, 10), 2);
  for (const token of description.split(/[^A-Za-z0-9]+/)) {
    if (token.length >= 3) add(searchNodes(index, token, 10), 1);
  }
  return [...scores.entries()]
    .filter(([, s]) => s >= 60)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, score]) => ({
      node: index.byId.get(id)!,
      score,
      routes: index
        .dependents(id)
        .filter((d) => d.type === 'route')
        .map((r) => r.name),
    }));
}

/** Pull candidate UI-element names out of a Contextifly screenshot markdown. */
export function extractUiCandidates(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const s = raw.trim();
    const key = s.toLowerCase();
    if (s.length < 3 || s.length > 40 || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const m of markdown.matchAll(/\*\*([^*\n]+)\*\*/g)) push(m[1]);
  for (const m of markdown.matchAll(/"([^"\n]+)"/g)) push(m[1]);
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) push(m[1]);
  for (const m of markdown.matchAll(/^#+\s*(.+)$/gm)) push(m[1]);
  return out.slice(0, 20);
}

function describeRelations(index: GraphIndex, id: string, cap = 6): string[] {
  const parts: string[] = [];
  for (const e of index.outEdges(id)) {
    parts.push(`${e.kind} → ${index.byId.get(e.to)?.name ?? e.to}`);
  }
  for (const e of index.inEdges(id)) {
    parts.push(`← ${e.kind} by ${index.byId.get(e.from)?.name ?? e.from}`);
  }
  return parts.slice(0, cap);
}
