import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { ProjectGraph } from '../types';

const DIR_NAME = '.pixelcontextifly';
const GRAPH_FILE = 'graph.json';
const HISTORY_DIR = 'history';
const MAX_SNAPSHOTS = 20;

export function graphDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), DIR_NAME);
}

/**
 * Persist the graph. If a previous graph exists and its content differs, it is
 * archived to history/<indexedAt>.json first — this is what powers graph_diff.
 */
export function saveGraph(graph: ProjectGraph): string {
  const dir = graphDir(graph.root);
  mkdirSync(dir, { recursive: true });
  // Self-ignoring cache dir (same trick as .next/): derived data, never committed.
  const gitignore = path.join(dir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n');

  const file = path.join(dir, GRAPH_FILE);
  const previous = loadGraph(graph.root);
  if (previous && contentKey(previous) !== contentKey(graph)) {
    const historyDir = path.join(dir, HISTORY_DIR);
    mkdirSync(historyDir, { recursive: true });
    const name = previous.indexedAt.replace(/[:.]/g, '-') + '.json';
    renameSync(file, path.join(historyDir, name));
    for (const old of listSnapshots(graph.root).slice(MAX_SNAPSHOTS)) {
      unlinkSync(path.join(historyDir, old));
    }
  }
  writeFileSync(file, JSON.stringify(graph));
  return file;
}

/** Structural identity — ignores indexedAt so no-op re-indexes don't pile up snapshots. */
function contentKey(graph: ProjectGraph): string {
  return createHash('sha1')
    .update(JSON.stringify({ files: graph.files, nodes: graph.nodes, edges: graph.edges }))
    .digest('hex');
}

/** Snapshot filenames, newest first. */
export function listSnapshots(projectRoot: string): string[] {
  const dir = path.join(graphDir(projectRoot), HISTORY_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
}

export function loadSnapshot(projectRoot: string, name: string): ProjectGraph | null {
  const file = path.join(graphDir(projectRoot), HISTORY_DIR, path.basename(name));
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ProjectGraph;
}

export function loadGraph(projectRoot: string): ProjectGraph | null {
  const file = path.join(graphDir(projectRoot), GRAPH_FILE);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProjectGraph;
  // Older IR versions are derived data: reject and let the caller re-index.
  if (parsed.version !== 2) return null;
  return parsed;
}

/** Count indexed files whose on-disk content no longer matches the stored hash. */
export function staleFileCount(graph: ProjectGraph): number {
  let stale = 0;
  for (const [relPath, { hash }] of Object.entries(graph.files)) {
    const abs = path.join(graph.root, relPath);
    try {
      const current = createHash('sha1').update(readFileSync(abs, 'utf8')).digest('hex');
      if (current !== hash) stale++;
    } catch {
      stale++; // deleted or unreadable
    }
  }
  return stale;
}
