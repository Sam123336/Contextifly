import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  type CallExpression,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type SourceFile,
} from 'ts-morph';
import type { GraphNode, ProjectGraph, StoredFileSymbols } from '../../types';
import {
  GraphSink,
  discoverFiles,
  sha1,
  toPathname,
  type Provider,
  type ProviderOptions,
  type ProviderOutput,
} from './provider';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const MAX_FILES = 5_000;
/** Above this fraction of dirty files a full rebuild is cheaper than incremental. */
const INCREMENTAL_MAX_RATIO = 0.4;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

interface FileSymbols {
  /** component name → node id */
  components: Map<string, string>;
  /** hook name (useX) → node id */
  hooks: Map<string, string>;
  /** context variable name → node id */
  contexts: Map<string, string>;
  /** node id → declaration size in lines */
  loc: Map<string, number>;
  /** node id → 1-based declaration line */
  line: Map<string, number>;
  /** component node id → normalized JSX-shape fingerprint */
  shape: Map<string, string>;
  defaultId?: string;
}

/**
 * Frontend provider: React/Next.js (and generic TS/JS) extraction via
 * ts-morph. Supports incremental re-indexing through the per-file symbol
 * cache persisted in the previous graph.
 */
export const frontendProvider: Provider = {
  name: 'frontend',
  extract(root: string, prev: ProjectGraph | null, opts: ProviderOptions): ProviderOutput | null {
    const warnings: string[] = [];

    let discovered = discoverFiles(root, TS_EXTENSIONS, {
      skipFile: (name) => name.endsWith('.d.ts') || /\.(test|spec)\./.test(name),
    });
    if (discovered.length === 0) return null;
    if (discovered.length > MAX_FILES) {
      warnings.push(
        `Project has ${discovered.length} source files; indexing only the first ${MAX_FILES}.`,
      );
      discovered = discovered.slice(0, MAX_FILES);
    }
    const currentRels = new Set(discovered.map((f) => f.rel));

    // ---- context memory: decide what actually needs re-parsing -------------
    const usable = !opts.force && prev?.symbols ? prev : null;
    let mode: 'full' | 'incremental' = 'full';
    let parseSet = currentRels;
    if (usable?.symbols) {
      const dirty = new Set<string>();
      const invalidTargets = new Set<string>();
      for (const f of discovered) {
        const before = usable.files[f.rel];
        if (!before) {
          dirty.add(f.rel); // new file
        } else if (before.hash !== f.hash) {
          dirty.add(f.rel);
          invalidTargets.add(f.rel);
        }
      }
      for (const rel of Object.keys(usable.files)) {
        if (!rel.endsWith('.dart') && !currentRels.has(rel)) invalidTargets.add(rel); // deleted
      }
      // A changed/deleted file invalidates every file that imports it: their
      // renders/uses resolution depends on the target's symbol table.
      for (const e of usable.edges) {
        if (e.kind === 'imports' && invalidTargets.has(e.to) && currentRels.has(e.from)) {
          dirty.add(e.from);
        }
      }
      if (dirty.size <= discovered.length * INCREMENTAL_MAX_RATIO) {
        mode = 'incremental';
        parseSet = dirty;
      }
    }
    const keep = new Set([...currentRels].filter((r) => !parseSet.has(r)));

    const sink = new GraphSink();
    const files: ProjectGraph['files'] = {};
    const symbolsOut: Record<string, StoredFileSymbols> = {};
    for (const f of discovered) files[f.rel] = { hash: f.hash };

    // ---- carry over everything owned by clean files -------------------------
    // Kept nodes/edges may include ones produced by other providers over the
    // same TS files (e.g. NestJS): harmless — those providers run in full and
    // re-emit identical output, deduped by the orchestrator's sink.
    if (mode === 'incremental' && usable) {
      const prevById = new Map(usable.nodes.map((n) => [n.id, n]));
      for (const n of usable.nodes) {
        const owner = nodeOwnerFile(n);
        if (owner && keep.has(owner)) sink.addNode(n);
      }
      for (const e of usable.edges) {
        const owner = edgeOwnerFile(e, prevById);
        if (owner && keep.has(owner)) sink.addEdge(e);
      }
      for (const rel of keep) {
        if (usable.symbols![rel]) symbolsOut[rel] = usable.symbols![rel];
      }
    }

    // ---- parse the dirty set -------------------------------------------------
    const freshSymbols = new Map<string, FileSymbols>();
    const parsed: { sf: SourceFile; rel: string }[] = [];
    if (parseSet.size > 0) {
      const tsConfigPath = path.join(root, 'tsconfig.json');
      const project = new Project({
        ...(existsSync(tsConfigPath) ? { tsConfigFilePath: tsConfigPath } : {}),
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true },
      });
      for (const f of discovered) {
        if (parseSet.has(f.rel)) {
          parsed.push({ sf: project.addSourceFileAtPath(f.abs), rel: f.rel });
        }
      }
    }

    const lookupSymbols = (rel: string): FileSymbols | undefined => {
      const fresh = freshSymbols.get(rel);
      if (fresh) return fresh;
      const stored = symbolsOut[rel];
      return stored ? thawSymbols(stored) : undefined;
    };

    // Phase 1: symbol declarations, routes, API route handlers.
    for (const { sf, rel } of parsed) {
      sink.addNode({ id: rel, type: 'file', name: path.basename(rel), file: rel });

      const symbols = collectSymbols(sf, rel);
      freshSymbols.set(rel, symbols);
      symbolsOut[rel] = freezeSymbols(symbols);

      const declLine = (id: string) => symbols.line.get(id) ?? 1;
      for (const [name, id] of symbols.components) {
        sink.addNode({
          id,
          type: 'component',
          name,
          file: rel,
          ...(symbols.defaultId === id ? { isDefaultExport: true } : {}),
          ...(symbols.loc.has(id) ? { loc: symbols.loc.get(id) } : {}),
          ...(symbols.shape.has(id) ? { shape: symbols.shape.get(id) } : {}),
        });
        sink.addEdge({ from: rel, to: id, kind: 'defines', source: { file: rel, line: declLine(id) } });
      }
      for (const [name, id] of symbols.hooks) {
        sink.addNode({
          id,
          type: 'hook',
          name,
          file: rel,
          ...(symbols.loc.has(id) ? { loc: symbols.loc.get(id) } : {}),
        });
        sink.addEdge({ from: rel, to: id, kind: 'defines', source: { file: rel, line: declLine(id) } });
      }
      for (const [name, id] of symbols.contexts) {
        sink.addNode({ id, type: 'context', name, file: rel });
        sink.addEdge({ from: rel, to: id, kind: 'defines', source: { file: rel, line: declLine(id) } });
      }

      const route = routeForFile(rel);
      if (route) {
        const routeId = `route:${route}`;
        sink.addNode({ id: routeId, type: 'route', name: route, file: rel });
        sink.addEdge({
          from: routeId,
          to: symbols.defaultId ?? rel,
          kind: 'routes_to',
          source: { file: rel, line: 1 },
        });
      }

      const apiRoute = apiRouteForFile(rel);
      if (apiRoute) {
        const apiId = `api:ROUTE ${apiRoute}`;
        sink.addNode({ id: apiId, type: 'api', name: apiRoute, file: rel, declared: true });
        sink.addEdge({ from: rel, to: apiId, kind: 'defines', source: { file: rel, line: 1 } });
      }
    }

    // Declared routes (kept + fresh) drive nav-target canonicalization.
    const declaredRoutes = [...sink.nodes.values()]
      .filter((n) => n.type === 'route' && n.file)
      .map((n) => n.name);
    const canonicalRoute = (nav: string): { path: string; fuzzy: boolean } => {
      if (declaredRoutes.includes(nav)) return { path: nav, fuzzy: false };
      const navSegs = nav.split('/').filter(Boolean);
      const candidates = declaredRoutes.filter((declared) => {
        const segs = declared.split('/').filter(Boolean);
        return (
          segs.length === navSegs.length &&
          segs.every((s, i) => s === navSegs[i] || s.startsWith(':') || navSegs[i].startsWith(':'))
        );
      });
      return candidates.length === 1 ? { path: candidates[0], fuzzy: true } : { path: nav, fuzzy: false };
    };
    /** Confidence metadata for heuristically resolved route/api targets. */
    const heuristic = (fuzzy: boolean, raw: string) =>
      fuzzy
        ? { confidence: 0.8, reason: 'matched dynamic route pattern' }
        : raw.includes(':param')
          ? { confidence: 0.7, reason: 'normalized template literal' }
          : {};

    // Phase 2: imports, renders, navigation, hook/context usage, API calls.
    for (const { sf, rel } of parsed) {
      const importMap = buildImportMap(sf, root);

      for (const [target, line] of importMap.fileTargets) {
        if (currentRels.has(target)) {
          sink.addEdge({ from: rel, to: target, kind: 'imports', source: { file: rel, line } });
        }
      }

      const own = freshSymbols.get(rel)!;
      const resolveTag = (tag: string): string | undefined => {
        const head = tag.split('.')[0];
        if (!/^[A-Z]/.test(head)) return undefined;
        const imported = importMap.locals.get(head);
        if (imported) {
          const target = lookupSymbols(imported.fromFile);
          if (!target) return undefined;
          return imported.name === 'default'
            ? target.defaultId
            : target.components.get(imported.name);
        }
        return own.components.get(head);
      };

      const resolveSymbol = (name: string, table: 'hooks' | 'contexts'): string | undefined => {
        const imported = importMap.locals.get(name);
        if (imported && imported.name !== 'default') {
          return lookupSymbols(imported.fromFile)?.[table].get(imported.name);
        }
        return own[table].get(name);
      };

      // Attribute every reference to the enclosing component or hook, else the file.
      const declRanges: { id: string; start: number; end: number }[] = [];
      for (const [name, id] of [...own.components, ...own.hooks]) {
        const decl = sf.getFunction(name) ?? sf.getVariableDeclaration(name);
        if (decl) declRanges.push({ id, start: decl.getPos(), end: decl.getEnd() });
      }
      const enclosingId = (node: Node): string => {
        const pos = node.getPos();
        const hit = declRanges.find((r) => pos >= r.start && pos < r.end);
        return hit?.id ?? rel;
      };
      const at = (node: Node) => ({ file: rel, line: node.getStartLineNumber() });

      for (const jsx of [
        ...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
        ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ] as (JsxOpeningElement | JsxSelfClosingElement)[]) {
        const tag = jsx.getTagNameNode().getText();
        const from = enclosingId(jsx);

        const targetId = resolveTag(tag);
        if (targetId && targetId !== from) {
          sink.addEdge({ from, to: targetId, kind: 'renders', source: at(jsx) });
        }

        if (tag.split('.')[0] === 'Link') {
          const href = literalAttr(jsx, 'href');
          if (href?.startsWith('/')) {
            const { path: routePath, fuzzy } = canonicalRoute(normalizeRoutePath(href));
            sink.addNode({ id: `route:${routePath}`, type: 'route', name: routePath });
            sink.addEdge({
              from,
              to: `route:${routePath}`,
              kind: 'navigates_to',
              source: at(jsx),
              ...heuristic(fuzzy, href),
            });
          }
        }
      }

      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (Node.isIdentifier(callee) && /^use[A-Z]/.test(callee.getText())) {
          const from = enclosingId(call);
          if (callee.getText() === 'useContext') {
            const arg = call.getArguments()[0];
            const ctxId =
              arg && Node.isIdentifier(arg) ? resolveSymbol(arg.getText(), 'contexts') : undefined;
            if (ctxId) sink.addEdge({ from, to: ctxId, kind: 'uses', source: at(call) });
            continue;
          }
          const hookId = resolveSymbol(callee.getText(), 'hooks');
          if (hookId && hookId !== from) {
            sink.addEdge({ from, to: hookId, kind: 'uses', source: at(call) });
            continue;
          }
        }

        const nav = navigationTarget(call);
        if (nav?.startsWith('/')) {
          const { path: routePath, fuzzy } = canonicalRoute(normalizeRoutePath(nav));
          sink.addNode({ id: `route:${routePath}`, type: 'route', name: routePath });
          sink.addEdge({
            from: enclosingId(call),
            to: `route:${routePath}`,
            kind: 'navigates_to',
            source: at(call),
            ...heuristic(fuzzy, nav),
          });
          continue;
        }
        const api = apiCall(call);
        if (api) {
          const apiId = `api:${api.method} ${api.url}`;
          sink.addNode({ id: apiId, type: 'api', name: `${api.method} ${api.url}` });
          sink.addEdge({
            from: enclosingId(call),
            to: apiId,
            kind: 'calls',
            source: at(call),
            ...heuristic(false, api.url),
          });
        }
      }
    }

    return {
      files,
      nodes: [...sink.nodes.values()],
      edges: sink.edges,
      warnings,
      symbols: symbolsOut,
      mode,
      reparsed: parseSet.size,
      reused: keep.size,
    };
  },
};

/** The file whose re-parse would regenerate this node (undefined = synthesized). */
function nodeOwnerFile(n: GraphNode): string | undefined {
  return n.type === 'file' ? n.id : n.file;
}

/** The file whose re-parse would regenerate this edge. */
function edgeOwnerFile(
  e: { from: string },
  byId: Map<string, GraphNode>,
): string | undefined {
  const from = e.from;
  if (from.includes('#')) return from.split('#')[0];
  if (from.startsWith('route:')) return byId.get(from)?.file;
  if (from.startsWith('api:')) return undefined;
  return from; // plain file id
}

function freezeSymbols(s: FileSymbols): StoredFileSymbols {
  return {
    components: Object.fromEntries(s.components),
    hooks: Object.fromEntries(s.hooks),
    contexts: Object.fromEntries(s.contexts),
    loc: Object.fromEntries(s.loc),
    line: Object.fromEntries(s.line),
    ...(s.defaultId ? { defaultId: s.defaultId } : {}),
  };
}

function thawSymbols(s: StoredFileSymbols): FileSymbols {
  return {
    components: new Map(Object.entries(s.components)),
    hooks: new Map(Object.entries(s.hooks)),
    contexts: new Map(Object.entries(s.contexts)),
    loc: new Map(Object.entries(s.loc)),
    line: new Map(Object.entries(s.line ?? {})),
    // Shapes ride on the carried-over nodes themselves; the thawed table is
    // only used for cross-file symbol resolution, which never needs them.
    shape: new Map(),
    defaultId: s.defaultId,
  };
}

/**
 * Top-level symbols of a file:
 * - components: uppercase-named functions/consts containing JSX
 * - hooks: functions/consts named use[A-Z]…
 * - contexts: consts initialized with createContext(...)
 */
function collectSymbols(sf: SourceFile, relPath: string): FileSymbols {
  const components = new Map<string, string>();
  const hooks = new Map<string, string>();
  const contexts = new Map<string, string>();
  const loc = new Map<string, number>();
  const line = new Map<string, number>();
  const shape = new Map<string, string>();
  let defaultId: string | undefined;

  const register = (name: string, node: Node, isDefault: boolean, initText?: string) => {
    if (!name) return;
    const id = `${relPath}#${name}`;
    if (/^use[A-Z]/.test(name)) {
      hooks.set(name, id);
      loc.set(id, node.getEndLineNumber() - node.getStartLineNumber() + 1);
      line.set(id, node.getStartLineNumber());
    } else if (initText?.includes('createContext')) {
      contexts.set(name, id);
      line.set(id, node.getStartLineNumber());
    } else if (/^[A-Z]/.test(name) && containsJsx(node)) {
      components.set(name, id);
      loc.set(id, node.getEndLineNumber() - node.getStartLineNumber() + 1);
      line.set(id, node.getStartLineNumber());
      const fp = jsxShape(node);
      if (fp) shape.set(id, fp);
      if (isDefault) defaultId = id;
    }
  };

  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? defaultFunctionName(relPath, fn.isDefaultExport());
    register(name, fn, fn.isDefaultExport());
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init) continue;
    if (
      Node.isArrowFunction(init) ||
      Node.isFunctionExpression(init) ||
      Node.isCallExpression(init) // memo(...), forwardRef(...), createContext(...)
    ) {
      register(v.getName(), init, false, init.getText().slice(0, 80));
    }
  }
  // `export default Foo;`
  for (const ea of sf.getExportAssignments()) {
    const expr = ea.getExpression();
    if (Node.isIdentifier(expr)) {
      const id = components.get(expr.getText());
      if (id) defaultId = id;
    }
  }
  return { components, hooks, contexts, loc, line, shape, defaultId };
}

/** Fewer JSX elements than this and a shape match means nothing. */
const MIN_SHAPE_ELEMENTS = 4;

/**
 * Normalized JSX-shape fingerprint: the source-ordered element sequence with
 * host tags kept, component tags collapsed to `C`, and attribute names
 * (sorted, values dropped). A copy-pasted-then-renamed component keeps its
 * shape; unrelated markup collides only by genuine structural coincidence.
 */
function jsxShape(node: Node): string | undefined {
  const elements = (
    [
      ...node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ] as (JsxOpeningElement | JsxSelfClosingElement)[]
  ).sort((a, b) => a.getPos() - b.getPos());
  if (elements.length < MIN_SHAPE_ELEMENTS) return undefined;
  const tokens = elements.map((el) => {
    const tag = el.getTagNameNode().getText();
    const norm = /^[a-z]/.test(tag) ? tag : 'C';
    const attrs = el
      .getAttributes()
      .map((a) => (Node.isJsxAttribute(a) ? a.getNameNode().getText() : '...'))
      .sort();
    return `${norm}[${attrs.join(',')}]`;
  });
  return sha1(tokens.join('>')).slice(0, 12);
}

function defaultFunctionName(relPath: string, isDefault: boolean): string {
  if (!isDefault) return '';
  const base = path.basename(relPath).replace(/\.[^.]+$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/[^A-Za-z0-9]/g, '');
}

function containsJsx(node: Node): boolean {
  return (
    node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement).length > 0 ||
    node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement).length > 0 ||
    node.getDescendantsOfKind(SyntaxKind.JsxFragment).length > 0
  );
}

interface ImportMap {
  /** local identifier → source of the import */
  locals: Map<string, { fromFile: string; name: string }>;
  /** target rel path → line of the import declaration */
  fileTargets: Map<string, number>;
}

function buildImportMap(sf: SourceFile, root: string): ImportMap {
  const locals = new Map<string, { fromFile: string; name: string }>();
  const fileTargets = new Map<string, number>();
  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile();
    if (!target || target.getFilePath().includes('/node_modules/')) continue;
    const fromFile = path
      .relative(root, target.getFilePath())
      .split(path.sep)
      .join('/');
    if (!fileTargets.has(fromFile)) fileTargets.set(fromFile, imp.getStartLineNumber());
    const def = imp.getDefaultImport();
    if (def) locals.set(def.getText(), { fromFile, name: 'default' });
    for (const named of imp.getNamedImports()) {
      locals.set(named.getAliasNode()?.getText() ?? named.getName(), {
        fromFile,
        name: named.getName(),
      });
    }
  }
  return { locals, fileTargets };
}

/** Next.js route derivation for app-router pages and pages-router files. */
export function routeForFile(relPath: string): string | undefined {
  const appMatch = relPath.match(/(?:^|\/)app\/(.*?)page\.(?:tsx|jsx|ts|js)$/);
  if (appMatch) {
    const segments = appMatch[1]
      .split('/')
      .filter(Boolean)
      .filter((s) => !s.startsWith('(') && !s.startsWith('@'))
      .map(segmentToRoute);
    return '/' + segments.join('/').replace(/\/+$/, '');
  }
  const pagesMatch = relPath.match(/(?:^|\/)pages\/(.*)\.(?:tsx|jsx|ts|js)$/);
  if (pagesMatch) {
    const p = pagesMatch[1];
    if (p.startsWith('api/') || p.startsWith('_')) return undefined;
    const withoutIndex = p.replace(/(^|\/)index$/, '');
    return '/' + withoutIndex.split('/').filter(Boolean).map(segmentToRoute).join('/');
  }
  return undefined;
}

/** API route handlers: app router route.ts files and pages/api files → endpoint path. */
export function apiRouteForFile(relPath: string): string | undefined {
  const appMatch = relPath.match(/(?:^|\/)app\/(.*?)route\.(?:ts|js|tsx|jsx)$/);
  if (appMatch) {
    const segments = appMatch[1]
      .split('/')
      .filter(Boolean)
      .filter((s) => !s.startsWith('(') && !s.startsWith('@'))
      .map(segmentToRoute);
    return '/' + segments.join('/').replace(/\/+$/, '');
  }
  const pagesMatch = relPath.match(/(?:^|\/)pages\/(api\/.*)\.(?:ts|js)$/);
  if (pagesMatch) {
    const withoutIndex = pagesMatch[1].replace(/(^|\/)index$/, '');
    return '/' + withoutIndex.split('/').filter(Boolean).map(segmentToRoute).join('/');
  }
  return undefined;
}

function segmentToRoute(segment: string): string {
  return segment
    .replace(/^\[\.\.\.(.+)\]$/, ':$1*')
    .replace(/^\[\[\.\.\.(.+)\]\]$/, ':$1*')
    .replace(/^\[(.+)\]$/, ':$1');
}

function normalizeRoutePath(href: string): string {
  const cleaned = href.split(/[?#]/)[0].replace(/\/+$/, '');
  return cleaned === '' ? '/' : cleaned;
}

function literalAttr(
  jsx: JsxOpeningElement | JsxSelfClosingElement,
  name: string,
): string | undefined {
  for (const attr of jsx.getAttributes()) {
    if (!Node.isJsxAttribute(attr) || attr.getNameNode().getText() !== name) continue;
    const init = attr.getInitializer();
    if (Node.isStringLiteral(init)) return init.getLiteralValue();
    if (Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (Node.isStringLiteral(expr)) return expr.getLiteralValue();
      if (expr && Node.isTemplateExpression(expr)) return templateToPattern(expr);
      if (expr && Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralValue();
    }
  }
  return undefined;
}

/** `/product/${id}` → `/product/:param` */
function templateToPattern(node: Node): string | undefined {
  if (!Node.isTemplateExpression(node)) return undefined;
  let text = node.getHead().getLiteralText();
  for (const span of node.getTemplateSpans()) {
    text += ':param' + span.getLiteral().getLiteralText();
  }
  return text;
}

function firstArgString(call: CallExpression): string | undefined {
  const arg = call.getArguments()[0];
  if (!arg) return undefined;
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralValue();
  }
  if (Node.isTemplateExpression(arg)) return templateToPattern(arg);
  return undefined;
}

/** router.push/replace('/x'), redirect('/x'), navigate('/x') */
function navigationTarget(call: CallExpression): string | undefined {
  const expr = call.getExpression().getText();
  const isNav =
    /(^|\.)(push|replace)$/.test(expr) || expr === 'redirect' || expr === 'navigate';
  if (!isNav) return undefined;
  return firstArgString(call);
}

/** fetch('/api/x', {method}), axios.get('/api/x'), axios('/api/x') */
function apiCall(call: CallExpression): { method: string; url: string } | undefined {
  const expr = call.getExpression();
  const exprText = expr.getText();
  let method: string | undefined;

  if (exprText === 'fetch') {
    method = fetchMethod(call) ?? 'GET';
  } else if (exprText === 'axios') {
    method = 'GET';
  } else if (Node.isPropertyAccessExpression(expr)) {
    const prop = expr.getName().toLowerCase();
    const objText = expr.getExpression().getText();
    if (
      (HTTP_METHODS as readonly string[]).includes(prop) &&
      /(axios|api|client|http)/i.test(objText)
    ) {
      method = prop.toUpperCase();
    }
  }
  if (!method) return undefined;

  const raw = firstArgString(call);
  if (!raw) return undefined;
  const url = toPathname(raw);
  if (!url) return undefined;
  return { method, url };
}

function fetchMethod(call: CallExpression): string | undefined {
  const opts = call.getArguments()[1];
  if (!opts || !Node.isObjectLiteralExpression(opts)) return undefined;
  const prop = opts.getProperty('method');
  if (prop && Node.isPropertyAssignment(prop)) {
    const init = prop.getInitializer();
    if (init && Node.isStringLiteral(init)) return init.getLiteralValue().toUpperCase();
  }
  return undefined;
}
