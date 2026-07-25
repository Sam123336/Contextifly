import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  Node,
  Project,
  type ClassDeclaration,
  type Decorator,
  type SourceFile,
} from 'ts-morph';
import type { GraphNode, NodeType, ProjectGraph } from '../../types';
import {
  GraphSink,
  discoverFiles,
  type Provider,
  type ProviderOutput,
} from './provider';

/**
 * NestJS provider: compiles decorator-declared architecture — controllers,
 * services, modules, entities, HTTP routes, and constructor dependency
 * injection — into IR.
 *
 * Declared endpoints share the `api:METHOD /path` id scheme with the
 * frontend provider's detected calls, which is what merges a frontend
 * `fetch('/orders')` and a backend `@Post()` handler into one node.
 *
 * Resolution is by class name (NestJS DI is class-token based), not by the
 * type checker — fast, and correct for idiomatic Nest code. Always runs in
 * full (no incremental support).
 */

const TS_EXTENSIONS = new Set(['.ts']);
const MAX_FILES = 5_000;

/** Any of these class decorators marks a file as NestJS/ORM territory. */
const NEST_HINT = /@(Controller|Injectable|Module|Entity|Table)\s*\(/;

const HTTP_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ALL',
};

interface NestClass {
  id: string;
  name: string;
  rel: string;
  type: NodeType; // controller | service | module | entity
  cls: ClassDeclaration;
  /** Controller only: route prefix from @Controller('prefix'). */
  prefix?: string;
}

export const nestjsProvider: Provider = {
  name: 'nestjs',
  extract(root: string): ProviderOutput | null {
    const warnings: string[] = [];
    let discovered = discoverFiles(root, TS_EXTENSIONS, {
      skipFile: (name) => name.endsWith('.d.ts') || /\.(test|spec)\./.test(name),
    });
    if (discovered.length > MAX_FILES) discovered = discovered.slice(0, MAX_FILES);

    // Pre-filter by content so non-Nest projects cost one regex per file, not
    // an AST parse. Also pick up the app-level route prefix while we read.
    let globalPrefix = '';
    const matched: { rel: string; abs: string; hash: string }[] = [];
    for (const f of discovered) {
      const text = readFileSync(f.abs, 'utf8');
      const gp = text.match(/\.setGlobalPrefix\(\s*['"`]([^'"`]+)/);
      if (gp) globalPrefix = gp[1];
      if (NEST_HINT.test(text)) matched.push(f);
    }
    if (matched.length === 0) return null;

    const files: ProjectGraph['files'] = {};
    const sink = new GraphSink();
    const project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true },
    });

    // ---- pass 1: decorated class declarations --------------------------------
    const classes: NestClass[] = [];
    const byName = new Map<string, NestClass>();
    const sources: { sf: SourceFile; rel: string }[] = [];

    for (const f of matched) {
      files[f.rel] = { hash: f.hash };
      const sf = project.addSourceFileAtPath(f.abs);
      sources.push({ sf, rel: f.rel });
      sink.addNode({ id: f.rel, type: 'file', name: path.basename(f.rel), file: f.rel });

      for (const cls of sf.getClasses()) {
        const name = cls.getName();
        if (!name) continue;
        const type = classify(cls);
        if (!type) continue;

        const entry: NestClass = {
          id: `${f.rel}#${name}`,
          name,
          rel: f.rel,
          type,
          cls,
          ...(type === 'controller' ? { prefix: decoratorStringArg(cls.getDecorator('Controller')) ?? '' } : {}),
        };
        classes.push(entry);
        if (byName.has(name)) {
          warnings.push(`Duplicate NestJS class name "${name}" — DI edges use the first occurrence.`);
        } else {
          byName.set(name, entry);
        }

        sink.addNode({
          id: entry.id,
          type,
          name,
          file: f.rel,
          framework: 'nestjs',
          loc: cls.getEndLineNumber() - cls.getStartLineNumber() + 1,
        });
        sink.addEdge({
          from: f.rel,
          to: entry.id,
          kind: 'defines',
          source: { file: f.rel, line: cls.getStartLineNumber() },
        });
      }
    }
    if (classes.length === 0) return null;

    // ---- pass 2: routes, dependency injection, module wiring -----------------
    for (const c of classes) {
      // HTTP routes: @Get(':id') etc. on controller methods.
      if (c.type === 'controller') {
        for (const method of c.cls.getMethods()) {
          for (const dec of method.getDecorators()) {
            const verb = HTTP_DECORATORS[dec.getName()];
            if (!verb) continue;
            const route = joinRoute(globalPrefix, c.prefix ?? '', decoratorStringArg(dec) ?? '');
            const apiId = `api:${verb} ${route}`;
            sink.addNode({
              id: apiId,
              type: 'api',
              name: `${verb} ${route}`,
              file: c.rel,
              declared: true,
              framework: 'nestjs',
            });
            const source = { file: c.rel, line: method.getStartLineNumber() };
            sink.addEdge({ from: c.rel, to: apiId, kind: 'defines', source });
            sink.addEdge({ from: apiId, to: c.id, kind: 'routes_to', source });
            break; // one HTTP decorator per handler
          }
        }
      }

      // Constructor DI: parameter class types → injects; @InjectModel /
      // @InjectRepository(Entity) → uses.
      const ctor = c.cls.getConstructors()[0];
      if (ctor) {
        for (const param of ctor.getParameters()) {
          const line = param.getStartLineNumber();
          const modelDec =
            param.getDecorator('InjectModel') ?? param.getDecorator('InjectRepository');
          const modelArg = decoratorIdentifierArg(modelDec);
          const modelTarget = modelArg ? byName.get(modelArg) : undefined;
          if (modelTarget?.type === 'entity') {
            sink.addEdge({
              from: c.id,
              to: modelTarget.id,
              kind: 'uses',
              source: { file: c.rel, line },
            });
            continue;
          }
          const typeName = param.getTypeNode()?.getText().split('<')[0].trim();
          const target = typeName ? byName.get(typeName) : undefined;
          if (target && target.id !== c.id) {
            sink.addEdge({
              from: c.id,
              to: target.id,
              kind: target.type === 'entity' ? 'uses' : 'injects',
              source: { file: c.rel, line },
            });
          }
        }
      }

      // Module wiring: @Module({ imports, controllers, providers }).
      if (c.type === 'module') {
        const arg = c.cls.getDecorator('Module')?.getArguments()[0];
        if (arg && Node.isObjectLiteralExpression(arg)) {
          const line = arg.getStartLineNumber();
          for (const [prop, kind] of [
            ['controllers', 'contains'],
            ['providers', 'contains'],
            ['imports', 'imports'],
          ] as const) {
            for (const name of arrayIdentifiers(arg.getProperty(prop))) {
              const target = byName.get(name);
              if (target && target.id !== c.id) {
                sink.addEdge({
                  from: c.id,
                  to: target.id,
                  kind,
                  source: { file: c.rel, line },
                });
              }
            }
          }
        }
      }
    }

    return { files, nodes: [...sink.nodes.values()], edges: sink.edges, warnings };
  },
};

/** Map a decorated class to its IR node type (undecorated classes → undefined). */
function classify(cls: ClassDeclaration): NodeType | undefined {
  if (cls.getDecorator('Controller')) return 'controller';
  if (cls.getDecorator('Module')) return 'module';
  if (cls.getDecorator('Entity') || cls.getDecorator('Table')) return 'entity';
  if (cls.getDecorator('Injectable')) return 'service';
  return undefined;
}

/** First string-literal argument of a decorator, e.g. @Controller('orders'). */
function decoratorStringArg(dec: Decorator | undefined): string | undefined {
  const arg = dec?.getArguments()[0];
  if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
    return arg.getLiteralValue();
  }
  return undefined;
}

/** First identifier argument of a decorator, e.g. @InjectModel(Screenshot). */
function decoratorIdentifierArg(dec: Decorator | undefined): string | undefined {
  const arg = dec?.getArguments()[0];
  return arg && Node.isIdentifier(arg) ? arg.getText() : undefined;
}

/**
 * Identifier names inside an object property whose value is an array, e.g.
 * `controllers: [HealthController]`. Dynamic-module calls like
 * `ConfigModule.forRoot(...)` resolve to their head identifier.
 */
function arrayIdentifiers(prop: Node | undefined): string[] {
  if (!prop || !Node.isPropertyAssignment(prop)) return [];
  const init = prop.getInitializer();
  if (!init || !Node.isArrayLiteralExpression(init)) return [];
  const out: string[] = [];
  for (const el of init.getElements()) {
    if (Node.isIdentifier(el)) out.push(el.getText());
    else if (Node.isCallExpression(el)) {
      const head = el.getExpression().getText().split('.')[0];
      if (/^[A-Z]/.test(head)) out.push(head);
    }
  }
  return out;
}

/** Join global prefix + controller prefix + method path into a normalized route. */
function joinRoute(...parts: string[]): string {
  const segments = parts
    .flatMap((p) => p.split('/'))
    .map((s) => s.trim())
    .filter(Boolean);
  return '/' + segments.join('/');
}
