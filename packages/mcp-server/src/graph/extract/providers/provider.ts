import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { GraphEdge, GraphNode, ProjectGraph, StoredFileSymbols } from '../../types';

/**
 * A provider compiles one slice of the project (a framework, a config format,
 * a spec file) into IR nodes and edges. Providers never know about each
 * other; the orchestrator in indexer.ts merges their outputs. Cross-provider
 * linking happens only through shared deterministic node ids
 * (e.g. `api:POST /orders` emitted by both a frontend and a backend provider).
 */
export interface Provider {
  /** Stable name recorded in ProjectGraph.providers. */
  name: string;
  /**
   * Compile the project slice this provider understands.
   * Returns null when the project contains nothing for this provider.
   * `prev` is the previously stored graph, for providers that support
   * incremental re-indexing; providers must treat it as read-only.
   */
  extract(root: string, prev: ProjectGraph | null, opts: ProviderOptions): ProviderOutput | null;
}

export interface ProviderOptions {
  /** Force a full rebuild even when an incremental update would be possible. */
  force?: boolean;
}

export interface ProviderOutput {
  files: ProjectGraph['files'];
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  /** Frontend provider only: per-file symbol cache powering incremental runs. */
  symbols?: Record<string, StoredFileSymbols>;
  /** Frontend provider only: incremental bookkeeping surfaced in IndexStats. */
  mode?: 'full' | 'incremental';
  reparsed?: number;
  reused?: number;
}

/** Dedup-aware node/edge accumulator shared by providers and the orchestrator. */
export class GraphSink {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];
  private readonly edgeSeen = new Set<string>();

  addNode(node: GraphNode): void {
    const prev = this.nodes.get(node.id);
    if (!prev) {
      this.nodes.set(node.id, node);
      return;
    }
    // Same id from two producers (e.g. a frontend call and a backend handler
    // both emitting `api:POST /orders`): keep the richer facts. A node backed
    // by a declaration (declared / owning file) wins over a synthesized
    // reference regardless of which provider ran first.
    if ((node.declared && !prev.declared) || (node.file && !prev.file)) {
      this.nodes.set(node.id, { ...prev, ...node });
    }
  }

  addEdge(edge: GraphEdge): void {
    const key = `${edge.from}|${edge.kind}|${edge.to}`;
    if (this.edgeSeen.has(key)) return;
    this.edgeSeen.add(key);
    this.edges.push(edge);
  }
}

export interface DiscoveredFile {
  rel: string;
  abs: string;
  hash: string;
}

const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

/**
 * Walk the project for source files with the given extensions, hashing as we
 * go (parse-free). Hidden directories and common build outputs are skipped.
 */
export function discoverFiles(
  root: string,
  extensions: Set<string>,
  opts: { skipDirs?: Set<string>; skipFile?: (name: string) => boolean } = {},
): DiscoveredFile[] {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const out: DiscoveredFile[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || skipDirs.has(entry)) continue;
      const abs = path.join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!extensions.has(path.extname(entry))) continue;
      if (opts.skipFile?.(entry)) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      out.push({ rel, abs, hash: sha1(readFileSync(abs, 'utf8')) });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** `/product/${id}` → `/product/:param`; strips query/hash; '' → '/'. */
export function toPathname(raw: string): string | undefined {
  if (raw.startsWith('/')) return raw.split(/[?#]/)[0];
  try {
    return new URL(raw).pathname;
  } catch {
    return undefined;
  }
}
