import * as path from 'node:path';
import { gitHead } from '../store/git';
import { normalize } from './normalizer';
import { dartProvider } from './providers/dart';
import { frontendProvider } from './providers/frontend';
import { nativeProvider } from './providers/native';
import { nestjsProvider } from './providers/nestjs';
import { GraphSink, type Provider } from './providers/provider';
import { loadGraph } from '../store/graph-store';
import type { GraphEdge, GraphNode, IndexStats, ProjectGraph } from '../types';

// Re-exported for callers that reason about Next.js file conventions.
export { apiRouteForFile, routeForFile } from './providers/frontend';

/**
 * Orchestrator: runs every registered provider over the project, merges
 * their IR output (providers link only through shared deterministic node
 * ids), runs the normalizer, and assembles the versioned graph.
 */
const PROVIDERS: Provider[] = [frontendProvider, nestjsProvider, dartProvider, nativeProvider];

export interface IndexResult {
  graph: ProjectGraph;
  stats: IndexStats;
  warnings: string[];
}

export interface IndexOptions {
  /** Force a full rebuild even when an incremental update would be possible. */
  force?: boolean;
}

export function indexProject(rootDir: string, opts: IndexOptions = {}): IndexResult {
  const started = Date.now();
  const root = path.resolve(rootDir);
  const warnings: string[] = [];
  const prev = opts.force ? null : safeLoadPrevious(root);

  const sink = new GraphSink();
  const files: ProjectGraph['files'] = {};
  const contributed: string[] = [];
  let symbols: ProjectGraph['symbols'];
  let mode: IndexStats['mode'] = 'full';
  let reparsed = 0;
  let reused = 0;

  for (const provider of PROVIDERS) {
    const out = provider.extract(root, prev, opts);
    if (!out) continue;
    contributed.push(provider.name);
    Object.assign(files, out.files);
    for (const n of out.nodes) sink.addNode(n);
    for (const e of out.edges) sink.addEdge(e);
    warnings.push(...out.warnings);
    if (out.symbols) symbols = out.symbols;
    if (out.mode) mode = out.mode;
    reparsed += out.reparsed ?? 0;
    reused += out.reused ?? 0;
  }

  // Repair pass: carried-over edges may reference synthesized route/api nodes
  // that had no owning file — recreate them deterministically from their ids.
  for (const e of sink.edges) {
    for (const id of [e.from, e.to]) {
      if (sink.nodes.has(id)) continue;
      if (id.startsWith('route:')) {
        sink.addNode({ id, type: 'route', name: id.slice('route:'.length) });
      } else if (id.startsWith('api:')) {
        sink.addNode({ id, type: 'api', name: id.slice('api:'.length) });
      }
    }
  }

  normalize(sink.nodes.values());

  const commit = gitHead(root);
  const graph: ProjectGraph = {
    version: 2,
    root,
    indexedAt: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    providers: contributed,
    files,
    nodes: sortNodes([...sink.nodes.values()]),
    edges: sortEdges(sink.edges),
    ...(symbols ? { symbols } : {}),
  };
  const count = (t: string) => graph.nodes.filter((n) => n.type === t).length;
  const stats: IndexStats = {
    files: Object.keys(files).length,
    components: count('component'),
    routes: count('route'),
    apis: count('api'),
    hooks: count('hook'),
    contexts: count('context'),
    controllers: count('controller'),
    services: count('service'),
    modules: count('module'),
    entities: count('entity'),
    channels: count('channel'),
    natives: count('native'),
    edges: graph.edges.length,
    durationMs: Date.now() - started,
    mode,
    reparsed,
    reused,
  };
  return { graph, stats, warnings };
}

// Deterministic ordering so incremental and full rebuilds produce identical output.
function sortNodes(list: GraphNode[]): GraphNode[] {
  return list.sort((a, b) => a.id.localeCompare(b.id));
}
function sortEdges(list: GraphEdge[]): GraphEdge[] {
  return list.sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to),
  );
}

function safeLoadPrevious(root: string): ProjectGraph | null {
  try {
    const prev = loadGraph(root);
    return prev && prev.root === root ? prev : null;
  } catch {
    return null;
  }
}
