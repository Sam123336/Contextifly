# The graph engine — where everything lives

Read this file first. Every folder here is **one stage of one pipeline**:

```
  your source code
        │
        ▼
   extract/     parse it            ──►  nodes + edges
        │
        ▼
    types.ts    the contract        ──►  ProjectGraph (the IR)
        │
        ├──►  store/     save it, and know when it went stale
        │
        ├──►  analyze/   ask questions of it   (pure — in: graph, out: data)
        │
        └──►  render/    turn answers into markdown / mermaid / html
                  │
                  ▼
              mcp/       expose it to the AI as tools
```

**The rule that keeps it readable:** each layer may only import from the layers
*above* it in that list. `analyze/` never renders. `render/` never traverses git.
`mcp/` is the only place that talks to the outside world. If you find yourself
wanting to break that, the code is telling you it belongs in a different folder.

---

## `types.ts` — the contract

The IR: `GraphNode`, `GraphEdge`, `ProjectGraph`. Every other file speaks this and
nothing else. **Start here** — 160 lines, and once you know it the rest is obvious.

A node is a component, route, api, service, controller, entity, hook, context,
widget or file. An edge is how two of them relate (`renders`, `calls`, `injects`,
`uses`, `navigates_to`…). That is the whole model.

## `extract/` — source code → graph

| File | Job |
|---|---|
| `indexer.ts` | Orchestrator. Runs every provider, merges their output, assembles the `ProjectGraph`. **The entry point of the whole engine.** |
| `normalizer.ts` | Tags each node with a framework-agnostic `role` (entry-point, http-boundary, state…) so analyzers don't need per-framework branches |
| `providers/frontend.ts` | React / Next.js, via the TypeScript compiler |
| `providers/nestjs.ts` | NestJS: controllers, services, modules, entities, DI |
| `providers/dart.ts` | Flutter: widgets, routes, http/dio, Riverpod/Provider/Bloc |
| `providers/native.ts` | Android/iOS side of Flutter platform channels |
| `providers/provider.ts` | The `Provider` interface + shared helpers all four use |

Providers never import each other. They only emit IR, and link up through
deterministic node ids — which is why a `fetch('/orders')` in the web app finds
the NestJS controller that handles it without either parser knowing the other exists.

**Adding a framework = adding one file here.** Nothing else changes.

## `store/` — persistence and git position

| File | Job |
|---|---|
| `graph-store.ts` | Read/write `.pixelcontextifly/graph.json`, archive snapshots, detect stale files by hash |
| `git.ts` | Where the repo is (branch, HEAD), plus the PR primitives: `withWorktree`, `changedFiles`, `lastCommitDays`, `applyPatch` |
| `usage-ledger.ts` | Records every tool answer and computes the token-savings report |

`withWorktree` is the one worth knowing: it checks a ref out into a throwaway
directory so we can index *another* commit without touching your working tree.
Both PR simulation and cross-app analysis are built on it.

## `analyze/` — the questions

Pure functions over the IR. In: a graph. Out: data. No markdown, no files.

| File | Answers |
|---|---|
| `graph-index.ts` | **Read this second.** The index every other analyzer runs on: `resolve` (name → node), `routeSubtree` (what a screen renders), `dependents` (what breaks if this changes) |
| `search.ts` | "find X by name", and screenshot-element → component matching |
| `health.ts` | Architecture score: cycles, dead code, unused endpoints, oversized components |
| `features.ts` | Group the graph into features instead of files |
| `what-if.ts` | One node: what if I `remove` / `split` / `lazy_load` it? |
| `endpoints.ts` | Endpoint identity — the join key **across repos** |
| `fleet.ts` | One backend, many apps: which app breaks, on which screen? |
| `pr-simulation.ts` | A whole PR: index before *and* after, subtract, report what moved |

The last three are the newest and go together: `endpoints.ts` defines how a NestJS
`/orders/:id` matches a Flutter `/orders/$id`, `fleet.ts` uses that to reach into
other repos, and `pr-simulation.ts` calls `fleet.ts` for the cross-app section of
its report.

## `render/` — answers → output

| File | Produces |
|---|---|
| `project-map.ts` | The route map + navigation Mermaid diagram |
| `history.ts` | Snapshot diff and the architecture timeline |
| `visual.ts` | Flow traces, screenshot blueprints, the "explain visually" dossier |
| `graph-html.ts` | The interactive `graph.html` |
| `savings-html.ts` | The token-savings dashboard |

## `mcp/tools.ts` — the outside world

Every MCP tool the AI can call. Each one is thin on purpose: load the graph,
call one analyzer, render, return. Business logic does not live here — if a tool
handler is getting long, what it's doing belongs in `analyze/`.

`loadIndex()` at the bottom is the piece to know: it transparently re-indexes when
git moved or a file changed, so no tool ever answers from a stale graph.

## `selfcheck.ts`

`npm test`. Covers the two genuinely heuristic parts — cross-repo endpoint matching
and the unguarded-dereference sniff. Everything else is deterministic traversal and
doesn't need pinning.

---

## Where do I put a new thing?

- **New framework to parse?** → `extract/providers/<name>.ts`
- **New question about the code?** → `analyze/`, as a pure function taking `GraphIndex`
- **New way of showing an existing answer?** → `render/`
- **New tool for the AI?** → `mcp/tools.ts`, wiring the two above together
- **Needs to read git or the filesystem?** → `store/`, then call it from `analyze/`
