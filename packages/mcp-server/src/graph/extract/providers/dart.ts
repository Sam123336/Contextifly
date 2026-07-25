import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ProjectGraph } from '../../types';
import {
  GraphSink,
  discoverFiles,
  toPathname,
  type Provider,
  type ProviderOutput,
} from './provider';

/**
 * Dart/Flutter provider (beta).
 *
 * Dart has no in-process TypeScript-compatible parser we can ship in a single
 * bundle, so this is a structured scanner, not a full AST: comments are
 * stripped string-aware, declarations are located by regex, and references are
 * attributed to the nearest enclosing class. That covers the structural bulk
 * of idiomatic Flutter code; exotic layouts may produce gaps.
 *
 * Always runs in full (no incremental support).
 */

const WIDGET_BASES = new Set([
  'StatelessWidget',
  'StatefulWidget',
  'ConsumerWidget',
  'ConsumerStatefulWidget',
  'HookWidget',
  'HookConsumerWidget',
]);
const STATE_CONTAINER_BASES = ['ChangeNotifier', 'Cubit', 'Bloc', 'ValueNotifier', 'GetxController'];
const SKIP_DIRS = new Set([
  '.dart_tool', 'build', 'ios', 'android', 'macos', 'linux', 'windows', 'web', '.git', 'node_modules',
]);
const MAX_DART_FILES = 3_000;

interface DartClass {
  name: string;
  /** node id this class's references are attributed to (State<X> → X's id). */
  attributeTo: string;
  offset: number;
}

interface DartFile {
  rel: string;
  /** comment-stripped source */
  text: string;
  classes: DartClass[];
  /** local declarations: name → node id */
  widgets: Map<string, string>;
  containers: Map<string, string>;
  providers: Map<string, string>;
  imports: string[];
}

export const dartProvider: Provider = {
  name: 'dart',
  extract(root: string): ProviderOutput | null {
    const warnings: string[] = [];
    const packageName = readPackageName(root);
    let dartFiles = discoverFiles(root, new Set(['.dart']), {
      skipDirs: SKIP_DIRS,
      skipFile: (name) => name.endsWith('.g.dart') || name.endsWith('.freezed.dart'),
    });
    if (dartFiles.length === 0) return null;
    if (dartFiles.length > MAX_DART_FILES) {
      warnings.push(`Found ${dartFiles.length} Dart files; indexing only the first ${MAX_DART_FILES}.`);
      dartFiles = dartFiles.slice(0, MAX_DART_FILES);
    }

    const files: ProjectGraph['files'] = {};
    const sink = new GraphSink();

    // ---- pass 1: declarations ------------------------------------------------
    const parsed: DartFile[] = [];
    const widgetsByName = new Map<string, string>(); // global widget name → id
    const containersByName = new Map<string, string>();
    const providersByName = new Map<string, string>();

    for (const f of dartFiles) {
      const rel = f.rel;
      const raw = readFileSync(f.abs, 'utf8');
      files[rel] = { hash: f.hash };
      sink.addNode({ id: rel, type: 'file', name: path.basename(rel), file: rel, framework: 'flutter' });

      const text = stripComments(raw);
      const df: DartFile = {
        rel, text, classes: [],
        widgets: new Map(), containers: new Map(), providers: new Map(),
        imports: [],
      };

      for (const m of text.matchAll(/import\s+'([^']+)'/g)) {
        const resolved = resolveDartImport(m[1], rel, packageName);
        if (resolved) df.imports.push(resolved);
      }

      for (const m of text.matchAll(/(?:abstract\s+)?class\s+(\w+)\s+extends\s+([\w<>, ]+)/g)) {
        const [, name, baseRaw] = m;
        const base = baseRaw.trim().split(/[<\s]/)[0];
        const id = `${rel}#${name}`;
        if (WIDGET_BASES.has(base)) {
          df.widgets.set(name, id);
          widgetsByName.set(name, id);
          df.classes.push({ name, attributeTo: id, offset: m.index! });
        } else if (base === 'State') {
          // class _XState extends State<X> → attribute to widget X
          const target = baseRaw.match(/State<\s*(\w+)/)?.[1];
          const targetId = target ? `${rel}#${target}` : id;
          df.classes.push({ name, attributeTo: targetId, offset: m.index! });
        } else if (STATE_CONTAINER_BASES.includes(base)) {
          df.containers.set(name, id);
          containersByName.set(name, id);
          df.classes.push({ name, attributeTo: id, offset: m.index! });
        } else {
          df.classes.push({ name, attributeTo: rel, offset: m.index! });
        }
      }

      // Riverpod-style providers: final cartProvider = StateNotifierProvider<...>(...)
      // (negative lookahead: `Provider.of<X>(ctx)` is usage, not a declaration)
      for (const m of text.matchAll(/final\s+(\w+)\s*=\s*(?:\w+\.)?\w*Provider\b(?!\.of\b)/g)) {
        const id = `${rel}#${m[1]}`;
        df.providers.set(m[1], id);
        providersByName.set(m[1], id);
      }

      df.classes.sort((a, b) => a.offset - b.offset);
      parsed.push(df);
    }

    for (const df of parsed) {
      const declLine = (name: string, id: string): number => {
        const cls = df.classes.find((c) => c.attributeTo === id && c.name === name);
        return cls ? lineAt(df.text, cls.offset) : 1;
      };
      for (const [name, id] of df.widgets) {
        const cls = df.classes.find((c) => c.attributeTo === id && c.name === name);
        sink.addNode({
          id, type: 'component', name, file: df.rel, framework: 'flutter',
          ...(cls ? { loc: locOf(df, cls) } : {}),
        });
        sink.addEdge({
          from: df.rel, to: id, kind: 'defines',
          source: { file: df.rel, line: declLine(name, id) },
        });
      }
      for (const [name, id] of df.containers) {
        sink.addNode({ id, type: 'context', name, file: df.rel, framework: 'flutter' });
        sink.addEdge({
          from: df.rel, to: id, kind: 'defines',
          source: { file: df.rel, line: declLine(name, id) },
        });
      }
      for (const [name, id] of df.providers) {
        sink.addNode({ id, type: 'context', name, file: df.rel, framework: 'flutter' });
        sink.addEdge({ from: df.rel, to: id, kind: 'defines', source: { file: df.rel, line: 1 } });
      }
    }

    // ---- pass 2: routes, references ------------------------------------------
    const declaredRoutes: string[] = [];
    const routeDecls: { path: string; widget?: string; file: string; line: number }[] = [];
    for (const df of parsed) {
      // GoRoute(path: '/x', ... SomeWidget(
      for (const m of df.text.matchAll(/GoRoute\s*\(\s*path:\s*'([^']+)'([\s\S]{0,500}?)(?=GoRoute\s*\(|$)/g)) {
        const widget = m[2].match(/(?:builder|pageBuilder)\s*:[\s\S]*?\b([A-Z]\w*)\s*\(/)?.[1];
        routeDecls.push({ path: m[1], widget, file: df.rel, line: lineAt(df.text, m.index!) });
      }
      // routes: { '/x': (context) => XScreen(...) }
      for (const m of df.text.matchAll(/'(\/[^']*)'\s*:\s*\(\s*\w+\s*\)\s*=>\s*(?:const\s+)?([A-Z]\w*)\s*\(/g)) {
        routeDecls.push({ path: m[1], widget: m[2], file: df.rel, line: lineAt(df.text, m.index!) });
      }
    }
    for (const r of routeDecls) {
      const routePath = r.path.startsWith('/') ? r.path : '/' + r.path;
      declaredRoutes.push(routePath);
      const routeId = `route:${routePath}`;
      sink.addNode({ id: routeId, type: 'route', name: routePath, file: r.file, framework: 'flutter' });
      const widgetId = r.widget ? widgetsByName.get(r.widget) : undefined;
      if (widgetId) {
        sink.addEdge({
          from: routeId, to: widgetId, kind: 'routes_to',
          source: { file: r.file, line: r.line },
        });
      }
    }
    const canonical = (nav: string): { path: string; fuzzy: boolean } => {
      if (declaredRoutes.includes(nav)) return { path: nav, fuzzy: false };
      const segs = nav.split('/').filter(Boolean);
      const hits = declaredRoutes.filter((d) => {
        const ds = d.split('/').filter(Boolean);
        return ds.length === segs.length &&
          ds.every((s, i) => s === segs[i] || s.startsWith(':') || segs[i].startsWith(':'));
      });
      return hits.length === 1 ? { path: hits[0], fuzzy: true } : { path: nav, fuzzy: false };
    };

    for (const df of parsed) {
      for (const target of new Set(df.imports)) {
        if (sink.nodes.has(target)) {
          sink.addEdge({ from: df.rel, to: target, kind: 'imports', source: { file: df.rel, line: 1 } });
        }
      }

      const owner = (offset: number): string => {
        let current = df.rel;
        for (const c of df.classes) {
          if (c.offset <= offset) current = c.attributeTo;
          else break;
        }
        return sink.nodes.has(current) ? current : df.rel;
      };
      const at = (offset: number) => ({ file: df.rel, line: lineAt(df.text, offset) });

      // Widget usage → renders (only names declared as widgets in this project).
      for (const m of df.text.matchAll(/\b([A-Z]\w*)\s*(?:\.\w+)?\(/g)) {
        const targetId = widgetsByName.get(m[1]);
        if (!targetId) continue;
        const from = owner(m.index!);
        if (from !== targetId) {
          sink.addEdge({ from, to: targetId, kind: 'renders', source: at(m.index!) });
        }
      }

      // Navigation: Navigator.pushNamed(ctx, '/x'), context.go('/x'), Get.toNamed('/x')
      for (const m of df.text.matchAll(
        /(?:pushNamed(?:AndRemoveUntil)?\s*\(\s*[^,)]*,|context\.(?:go|push|pushReplacement|replace)\s*\(|Get\.(?:toNamed|offNamed)\s*\()\s*'([^']+)'/g,
      )) {
        if (!m[1].startsWith('/')) continue;
        const { path: routePath, fuzzy } = canonical(m[1].split(/[?#]/)[0]);
        sink.addNode({ id: `route:${routePath}`, type: 'route', name: routePath, framework: 'flutter' });
        sink.addEdge({
          from: owner(m.index!), to: `route:${routePath}`, kind: 'navigates_to',
          source: at(m.index!),
          ...(fuzzy ? { confidence: 0.8, reason: 'matched dynamic route pattern' } : {}),
        });
      }

      // API calls: http.get(Uri.parse('...')), dio.post('...'), client.get('...')
      for (const m of df.text.matchAll(
        /\b(?:http|dio|client|api|_dio|_client|_api)\.(get|post|put|patch|delete)\w*\s*\(\s*(?:Uri\.parse\s*\(\s*)?'([^']+)'/gi,
      )) {
        const url = toPathname(m[2]);
        if (!url) continue;
        const method = m[1].toUpperCase();
        const apiId = `api:${method} ${url}`;
        sink.addNode({ id: apiId, type: 'api', name: `${method} ${url}` });
        sink.addEdge({ from: owner(m.index!), to: apiId, kind: 'calls', source: at(m.index!) });
      }

      // Platform channels (native bridge): MethodChannel('name'), EventChannel("name").
      // The native provider emits the matching `channel:name` node + `handles` edge.
      const dartConsts = stringConstMap(df.text);
      for (const m of df.text.matchAll(/\b(?:Method|Event|BasicMessage)Channel\s*\(\s*([^,)]+)/g)) {
        const name = resolveDartString(m[1], dartConsts);
        if (!name) continue;
        const channelId = `channel:${name}`;
        sink.addNode({ id: channelId, type: 'channel', name, framework: 'flutter' });
        sink.addEdge({ from: owner(m.index!), to: channelId, kind: 'invokes', source: at(m.index!) });
      }

      // State usage: ref.watch(xProvider), Provider.of<X>(ctx), context.watch<X>()
      for (const m of df.text.matchAll(/\bref\.(?:watch|read|listen)\s*\(\s*(\w+)/g)) {
        const id = providersByName.get(m[1]);
        if (id) sink.addEdge({ from: owner(m.index!), to: id, kind: 'uses', source: at(m.index!) });
      }
      for (const m of df.text.matchAll(/(?:Provider\.of|context\.watch|context\.read|BlocProvider\.of)\s*<\s*(\w+)/g)) {
        const id = containersByName.get(m[1]);
        if (id) sink.addEdge({ from: owner(m.index!), to: id, kind: 'uses', source: at(m.index!) });
      }
    }

    return { files, nodes: [...sink.nodes.values()], edges: sink.edges, warnings };
  },
};

/** Same-file Dart string constants, for resolving channel names given as identifiers. */
function stringConstMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of text.matchAll(/\b(\w+)\s*=\s*['"]([^'"]+)['"]/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

/** A channel-name argument → its string value, or null when unresolvable statically. */
function resolveDartString(expr: string, consts: Map<string, string>): string | null {
  const s = expr.trim();
  const lit = s.match(/^['"]([^'"]+)['"]$/);
  if (lit) return lit[1];
  if (/^[\w.]+$/.test(s)) return consts.get(s.split('.').pop()!) ?? null;
  return null;
}

/** 1-based line number of a character offset (stripComments keeps lines stable). */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function locOf(df: DartFile, cls: DartClass): number {
  const next = df.classes.find((c) => c.offset > cls.offset);
  const chunk = df.text.slice(cls.offset, next ? next.offset : undefined);
  return chunk.split('\n').length;
}

function readPackageName(root: string): string | null {
  const pubspec = path.join(root, 'pubspec.yaml');
  if (!existsSync(pubspec)) return null;
  return readFileSync(pubspec, 'utf8').match(/^name:\s*(\S+)/m)?.[1] ?? null;
}

/** package:app/x.dart → lib/x.dart; relative imports resolve against the file's dir. */
function resolveDartImport(spec: string, fromRel: string, packageName: string | null): string | null {
  if (packageName && spec.startsWith(`package:${packageName}/`)) {
    return 'lib/' + spec.slice(`package:${packageName}/`.length);
  }
  if (spec.startsWith('package:') || spec.startsWith('dart:')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
}

/** Remove // and /* *\/ comments without touching string contents. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' = 'code';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'sq';
      else if (c === '"') mode = 'dq';
      out += c;
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
    } else if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') out += c; // keep line numbers stable
    } else {
      // inside a string: copy verbatim, honoring escapes
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) mode = 'code';
      out += c;
    }
    i++;
  }
  return out;
}
