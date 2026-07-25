import * as path from 'node:path';
import {
  deriveFeatures,
  loadFeatureConfig,
  renderFeature,
  renderFeatureList,
} from './graph/analyze/features';
import { saveGraphHtml } from './graph/render/graph-html';
import { indexProject } from './graph/extract/indexer';
import { GraphIndex } from './graph/analyze/graph-index';
import { analyzeProject } from './graph/analyze/health';
import { searchNodes } from './graph/analyze/search';
import { renderGraphDiff } from './graph/render/history';
import { renderProjectMap } from './graph/render/project-map';
import { renderSavingsReport } from './graph/store/usage-ledger';
import { saveSavingsHtml } from './graph/render/savings-html';
import {
  graphDir,
  listSnapshots,
  loadGraph,
  loadSnapshot,
  saveGraph,
  staleFileCount,
} from './graph/store/graph-store';

// ---- terminal branding ------------------------------------------------------

const BANNER_LINES = [
  ' ▄▄▄▄▄ ▄▄▄▄▄ ▄   ▄ ▄▄▄▄▄ ▄▄▄▄▄ ▄   ▄ ▄▄▄▄▄ ▄▄▄ ▄▄▄▄▄ ▄     ▄   ▄',
  ' █     █   █ ██  █   █   █      ▀▄▀    █    █  █     █      ▀▄▀',
  ' █     █   █ █ █ █   █   █▄▄▄  ▄▀ ▀▄   █    █  █▄▄▄  █       █',
  ' █▄▄▄▄ █▄▄▄█ █  ██   █   █▄▄▄▄ █   █   █   ▄█▄ █     █▄▄▄▄   █',
];
const TAGLINE = ' see it · understand it · build better';

/** Blue → purple gradient (matches the Contextifly logo). */
function gradient(line: string, row: number, rows: number): string {
  const from = [59, 130, 246]; // #3b82f6
  const to = [168, 85, 247]; // #a855f7
  let out = '';
  const len = Math.max(1, line.length - 1);
  for (let i = 0; i < line.length; i++) {
    const t = Math.min(1, i / len + row / (rows * 4));
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    out += `\x1b[38;2;${r};${g};${b}m${line[i]}`;
  }
  return out + '\x1b[0m';
}

function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function banner(): string {
  if (!useColor()) {
    return ['', ...BANNER_LINES, TAGLINE, ''].join('\n');
  }
  const colored = BANNER_LINES.map((l, i) => gradient(l, i, BANNER_LINES.length));
  return ['', ...colored, `\x1b[2m${TAGLINE}\x1b[0m`, ''].join('\n');
}

/** One-line brand mark for command output (only when a human is watching). */
function brandLine(): string {
  if (!useColor()) return '';
  return gradient('🕸 contextifly', 0, 1) + ' \x1b[2m· software knowledge graph\x1b[0m\n';
}

const USAGE = `Contextifly — software knowledge graph CLI

Usage: contextifly <command> [args]        (no command → MCP stdio server)

  index   <dir>            Build/refresh the graph (+ graph.html) for a project
  map     <dir>            Route/component/API map with Mermaid navigation flow
  analyze <dir>            Architecture score + debt report
  impact  <dir> <target>   What depends on a component/file/route
  search  <dir> <query>    Find nodes by name and show their relationships
  diff    <dir> [snapshot] Compare current graph against a history snapshot
  feature <dir> [name]     List features, or show one feature's full dossier
  savings <dir>            Exploration-avoided report (files, tokens, latency)
  help                     Show this help

The graph is stored in <dir>/.pixelcontextifly/ — see docs/GRAPH-SPEC.md for the format.
`;

const COMMANDS = new Set(['index', 'map', 'analyze', 'impact', 'search', 'diff', 'feature', 'savings', 'help', '--help', '-h']);

/** Handle CLI invocation. Returns false when argv is not a CLI command (→ run MCP server). */
export function runCli(argv: string[]): boolean {
  const [cmd, ...rest] = argv;
  if (!cmd || !COMMANDS.has(cmd)) return false;

  try {
    dispatch(cmd, rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
  return true;
}

function dispatch(cmd: string, rest: string[]): void {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(banner() + USAGE);
    return;
  }

  const dir = rest[0];
  if (!dir) throw new Error(`Missing <dir> argument.\n\n${USAGE}`);
  const root = path.resolve(dir);

  if (cmd === 'index') {
    const { graph, stats, warnings } = indexProject(root);
    const file = saveGraph(graph);
    const html = saveGraphHtml(graph);
    const modeNote =
      stats.mode === 'incremental'
        ? ` (incremental: ${stats.reparsed} re-parsed, ${stats.reused} reused)`
        : '';
    process.stdout.write(brandLine());
    console.log(
      `Indexed ${stats.files} files in ${stats.durationMs}ms${modeNote}\n` +
        `  graph: ${file}\n  visualization: ${html}\n` +
        `  components=${stats.components} routes=${stats.routes} hooks=${stats.hooks} ` +
        `contexts=${stats.contexts} apis=${stats.apis} edges=${stats.edges}` +
        (stats.controllers + stats.services + stats.modules + stats.entities > 0
          ? `\n  controllers=${stats.controllers} services=${stats.services} ` +
            `modules=${stats.modules} entities=${stats.entities}`
          : ''),
    );
    for (const w of warnings) console.error(`warning: ${w}`);
    return;
  }

  const index = loadIndexOrThrow(root);

  switch (cmd) {
    case 'map':
      console.log(renderProjectMap(index));
      return;
    case 'analyze':
      console.log(analyzeProject(index).markdown);
      return;
    case 'impact': {
      const target = rest[1];
      if (!target) throw new Error('Usage: contextifly impact <dir> <target>');
      console.log(renderImpact(index, target));
      return;
    }
    case 'search': {
      const query = rest[1];
      if (!query) throw new Error('Usage: contextifly search <dir> <query>');
      const hits = searchNodes(index, query);
      if (hits.length === 0) {
        console.log(`No nodes match "${query}".`);
        return;
      }
      for (const hit of hits) {
        console.log(`${hit.node.type.padEnd(9)} ${hit.node.id}`);
        for (const r of hit.relations) console.log(`          ${r}`);
      }
      return;
    }
    case 'savings': {
      console.log(renderSavingsReport(root));
      const html = saveSavingsHtml(root);
      if (html) console.log(`\n  dashboard: ${html} — open in a browser`);
      return;
    }
    case 'feature': {
      const loaded = loadFeatureConfig(root);
      const config = loaded?.config ?? deriveFeatures(index);
      const source = loaded?.source ?? 'auto-derived from routes';
      const name = rest[1];
      if (!name) {
        console.log(renderFeatureList(index, config, source));
        return;
      }
      const key = Object.keys(config).find((k) => k.toLowerCase() === name.toLowerCase());
      if (!key) {
        throw new Error(`No feature "${name}". Available: ${Object.keys(config).join(', ')}`);
      }
      console.log(renderFeature(index, key, config[key]));
      return;
    }
    case 'diff': {
      const names = listSnapshots(root);
      if (names.length === 0) {
        console.log('No history snapshots yet — re-index after code changes to create one.');
        return;
      }
      const name = rest[1] ?? names[0];
      const before = loadSnapshot(root, name);
      if (!before) {
        throw new Error(`Snapshot "${name}" not found. Available:\n${names.join('\n')}`);
      }
      console.log(renderGraphDiff(before, index.graph));
      return;
    }
  }
}

function loadIndexOrThrow(root: string): GraphIndex {
  const graph = loadGraph(root);
  if (!graph) {
    throw new Error(`No graph at ${graphDir(root)} — run: contextifly index ${root}`);
  }
  const stale = staleFileCount(graph);
  if (stale > 0) {
    console.error(`warning: ${stale} indexed file(s) changed since last index — re-run index for fresh results.`);
  }
  return new GraphIndex(graph);
}

function renderImpact(index: GraphIndex, target: string): string {
  const resolved = index.resolve(target);
  if (resolved.length === 0) {
    return `No graph node matches "${target}" — try: contextifly search <dir> ${target}`;
  }
  const lines: string[] = [];
  for (const node of resolved.slice(0, 3)) {
    const deps = index.dependents(node.id);
    const routes = deps.filter((d) => d.type === 'route');
    const risk =
      routes.length >= 3 || deps.length >= 20
        ? 'High'
        : routes.length >= 1 || deps.length >= 6
          ? 'Medium'
          : 'Low';
    lines.push(
      `# Impact of ${node.type} ${node.id}`,
      `Affected: ${deps.filter((d) => d.type === 'component').length} components · ` +
        `${deps.filter((d) => d.type === 'file').length} files · ${routes.length} routes`,
      `Regression risk: ${risk}`,
      '',
    );
    for (const d of deps) lines.push(`- ${d.type}: ${d.id}`);
    lines.push('');
  }
  if (resolved.length > 3) {
    lines.push(`(${resolved.length - 3} more matches omitted — pass a more specific target)`);
  }
  return lines.join('\n');
}
