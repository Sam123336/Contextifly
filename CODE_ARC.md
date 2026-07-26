# CODE_ARC — the developer's map of this codebase

> **ARCHITECTURE.md** says *why* the system is shaped this way and what the rules are.
> **This file** says *where the code is* and *what happens when*. Read this one first
> if you're about to change something.
> **SKILLS.md** covers the four bundled skills — how they work and how to add one.

---

## 1. What this repo actually is

One product — **the memory** — built around one idea:

| | **The memory** |
|---|---|
| Question | "how does this codebase fit together?" |
| Input | your source code |
| Work | static parsing → a graph |
| Output | deterministic answers about structure |
| Runs | 100% locally (no network at all) |
| Lives in | `packages/mcp-server/src/graph/` |

**Everything reaches the user through the MCP server.** It's the front door: Claude
Code (and any MCP client) talks to it over stdio, and the same binary doubles as a CLI.

---

## 2. Package map

```
packages/
├── mcp-server/     ← the product. MCP tools + CLI + the whole graph engine
│   ├── src/index.ts          stdio entry point (or hands off to the CLI)
│   ├── src/cli.ts            `contextifly map|analyze|impact|search|savings|feature|diff`
│   ├── src/server.ts         registers the tools; delegates to graph/mcp/tools.ts
│   ├── src/graph/            the graph engine — see its own README.md
│   └── skills/               4 bundled skills the AI loads (copilot, refactor, rosetta, whatif)
│
├── shared/         ← shared TypeScript types (MCP_TOOL_NAMES)
└── render/         ← R&D spike, not wired to the product (see §10)
```

Dependency direction, and it only goes one way:

```mermaid
flowchart LR
  MCP[mcp-server] --> G[graph engine<br/>local only]
  MCP --> SH[shared]
```

The graph engine depends on **nothing** — not the network, not an LLM. That's
deliberate: it's what makes every structural answer reproducible.

---

## 3. Flow A — code becomes answers

```mermaid
flowchart LR
  SRC[your source] --> P[extract/providers]
  P --> IR[ProjectGraph<br/>types.ts]
  IR --> ST[(.pixelcontextifly/<br/>graph.json)]
  ST --> AN[analyze/]
  AN --> RE[render/]
  RE --> T[mcp/tools.ts] --> AI[Claude]
```

`packages/mcp-server/src/graph/README.md` documents every folder. The short version:

| Folder | Job | Rule |
|---|---|---|
| `extract/` | parse source → nodes + edges | providers never import each other |
| `store/` | persist the graph; know where git is | the only filesystem/git access |
| `analyze/` | questions over the graph | pure: in a graph, out data — never renders |
| `render/` | data → markdown / mermaid / html | never traverses, never touches git |
| `mcp/` | expose it as tools | the only outward-facing surface |

A layer may only import from the ones above it. That single rule is why you can
answer "where does this go?" without asking anyone.

**Freshness is automatic.** `loadIndex()` (bottom of `mcp/tools.ts`) re-indexes when git
moved or a file changed, so no tool can answer from a stale graph. Re-indexing is
incremental — only dirty files and their importers get re-parsed.

**Cross-provider linking happens through node ids, not code.** A web `fetch('/orders')`
and a NestJS `@Get('/orders')` both produce the id `api:GET /orders`, so they connect
without either parser knowing the other exists. That id scheme is also what makes §4 possible.

## 4. Flow B — pre-merge blast radius

The newest piece, and the one that needs the most explaining because it works
differently from everything else: **it builds more than one graph.**

```mermaid
flowchart TD
  subgraph one[simulate_pr — inside one repo]
    B[graph at base] --> D{subtract}
    H[graph at PR head<br/>indexed in a throwaway worktree] --> D
    D --> N[edges ADDED = a path just went live]
    D --> R[edges REMOVED = a flow just broke]
  end
  N --> L[🕰 new edge + PR didn't touch it<br/>+ file is months old = reactivated legacy]
  one --> F
  subgraph F[impact_across_apps — across repos]
    BK[backend endpoints] --> J{match by path shape}
    CA[customer-app @ master] --> J
    DA[delivery-app @ master] --> J
    W[web @ master] --> J
    J --> S[affected screens + call sites<br/>+ proof of which apps are safe]
  end
```

- `analyze/pr-simulation.ts` — the two-graph diff and the four analyzers
- `analyze/fleet.ts` — indexes each consumer app at **its master branch**, cached by sha
- `analyze/endpoints.ts` — how `/orders/:id`, `/orders/$id` and `/orders/${id}` become
  the same endpoint, with a confidence when the match isn't exact
- `store/git.ts` → `withWorktree()` — checks a ref out into a temp dir so we can index
  another commit without touching your working tree. Both flows above depend on it.

Configured by `contextifly.workspace.json` in the backend repo (the tool scaffolds one).

## 5. The IR — the one contract everything agrees on

`graph/types.ts` (161 lines) is the whole data model. Read it before anything else.
Providers write it, analyzers read it, nothing else crosses the boundary.

**12 node types**, syntax-level, emitted by providers:

| Group | Types |
|---|---|
| frontend | `file` · `component` · `route` · `api` · `hook` · `context` |
| backend | `controller` · `service` · `module` · `entity` |
| native bridge | `channel` (a named Flutter platform channel) · `native` (the Kotlin/Java/Swift file handling it) |

**6 semantic roles**, framework-agnostic, assigned by the normalizer — never by a
provider. An analyzer that wants *meaning* reads `role`; one that needs syntax precision
reads `type`. Both always coexist; the role never replaces the type.

`route`/`controller` → `entry-point` · `api` → `http-boundary` · `service` →
`business-logic` · `module` → `composition-root` · `entity` → `data-model` ·
`context` → `state`. Anything not derivable with certainty is left unset rather than
guessed — a wrong role misleads every downstream consumer.

**11 edge kinds**, each with a fixed direction:

| Kind | From → To |
|---|---|
| `imports` | file → file, module → module |
| `defines` | file → component / hook / context / controller / service / module / entity / api |
| `renders` | component → component |
| `routes_to` | route → component, api → controller (a thing resolves to its handler) |
| `navigates_to` | component / file → route |
| `uses` | component / hook / file / service → hook / context / entity |
| `calls` | component / file → api |
| `injects` | controller / service / module → service (constructor DI) |
| `contains` | module → controller / service |
| `invokes` | component / file → channel (Dart side calls a platform channel) |
| `handles` | native → channel (native code implements one) |

**Node ids are the load-bearing detail.** They are deterministic and content-free:

```
file       relPath                    src/checkout/CartPage.tsx
symbol     relPath#Name               src/checkout/CartPage.tsx#CartPage
route      route:/path                route:/cart
api        api:METHOD /path           api:POST /orders
```

That last one is why cross-provider linking needs no code: the frontend provider seeing
`fetch('/orders')` and the NestJS provider seeing `@Post()` both emit `api:POST /orders`,
so they land on the same node without either parser knowing the other exists. It is also
what §4 joins repos on.

**Every AST-derived edge carries provenance** (`source: { file, line }`). `confidence` is
omitted for deterministic facts (meaning 1.0) and set below 1.0 *only* alongside a
human-readable `reason` — heuristic matches are never allowed to look like facts.

**Versioning is deletion, not migration.** `ProjectGraph.version` is `2`; `loadGraph()`
returns `null` for anything else and the caller re-indexes. The graph is derived data, so
a schema change costs one rebuild and zero migration code.

## 6. The extraction layer — four providers, one sink

A provider compiles one slice of the project into IR. The contract
(`extract/providers/provider.ts`) is three lines wide:

```ts
extract(root, prev, opts): ProviderOutput | null   // null = nothing here for me
```

| Provider | Lines | Emits |
|---|---|---|
| `frontend.ts` | 675 | React/Next.js: components, routes (app + pages router), hooks, contexts, `fetch`/`axios` calls. The only provider with incremental support |
| `nestjs.ts` | 276 | Controllers, services, modules, entities (TypeORM + sequelize-typescript), routes with global-prefix resolution, constructor DI. The smallest complete provider — read this one first |
| `dart.ts` | 355 | Flutter: widgets, GoRouter + named routes, `http`/`dio`, Riverpod/Provider/Bloc, `MethodChannel`/`EventChannel` |
| `native.ts` | 119 | Kotlin/Java/Swift/Obj-C channel handlers, linked to `dart.ts`'s channels by channel name |

`extract/indexer.ts` orchestrates them in that fixed order and does five things after:

1. **Merge through `GraphSink`.** Nodes dedup by id, and when two producers emit the same
   id the *richer* one wins — a node backed by a declaration (`declared`, or an owning
   `file`) beats a synthesized reference regardless of which provider ran first. Edges
   dedup on `from|kind|to`.
2. **Repair pass.** Carried-over incremental edges can reference `route:`/`api:` nodes
   whose owning file wasn't re-parsed; they're recreated deterministically from the id.
3. **Normalize** — assign semantic roles.
4. **Sort** nodes by id and edges by `from|kind|to`, so an incremental rebuild is
   byte-identical to a full one. This is what makes the ~17ms no-op verifiable.
5. **Stamp** git HEAD, provider list, per-file sha1 hashes, and `IndexStats`.

File discovery (`discoverFiles`) hashes as it walks, skips hidden dirs and
`node_modules`/`dist`/`build`/`out`/`coverage`, and never parses — so staleness checks
cost a read, not a compile.

## 7. Tool catalogue — all 15

Every tool is registered in `graph/mcp/tools.ts` through the same wrapper, which does
three things before you ever see a handler:

- **`assertKnownTool(name)`** — a tool missing from `src/tool-manifest.ts` throws at
  startup. The manifest carries the trust class that `contextifly permissions` generates
  its allowlist from, so a tool added without one would silently go un-allowlisted and
  users would get surprise prompts on upgrade. It fails loudly in development instead.
- **`loadIndex(projectDir)`** — auto-refresh (§3). Every answer is hash- and git-checked
  first; a stale graph is re-indexed transparently and the answer is prefixed with
  `♻️ …graph auto-refreshed`.
- **`recordUsage(...)`** — appends to the local ledger on success only. Best-effort:
  bookkeeping never breaks an answer.

`src/tool-manifest.ts` is the registry of record for trust classes; the tools below are
the ones this map covers. All are `local` — repo in, `.pixelcontextifly/` out.

Every handler below therefore starts from the same two boxes, which are drawn once here
and left implicit in the per-tool diagrams:

```mermaid
flowchart LR
  A["MCP call"] --> B["assertKnownTool(name)"]
  B --> C["loadIndex(projectDir)"]
  C --> D{"staleReason?"}
  D -->|"git moved or hashes differ"| E["indexProject + saveGraph<br/>prefix the answer with auto-refreshed"]
  D -->|"clean"| F["new GraphIndex(graph)"]
  E --> F
  F --> G["handler: analyze then render"]
  G --> H["recordUsage — best effort, success only"]
```

### `index_project`

`projectDir` — build or refresh the graph. The one tool that writes the graph.

```mermaid
flowchart TD
  A["index_project(projectDir)"] --> B{"graphIsFresh?<br/>branch + HEAD + main-head unmoved<br/>and zero changed hashes"}
  B -->|"yes"| C["renderReuse — no rebuild, no file write"]
  B -->|"no"| D["extract/indexer.ts : indexProject"]
  D --> E["frontend + nestjs + dart + native providers"]
  E --> F["GraphSink dedup, richer node wins"]
  F --> G["repair pass, then normalize roles"]
  G --> H["sort nodes and edges deterministically"]
  H --> I["store/graph-store.ts : saveGraph<br/>archives previous to history if contentKey differs"]
  I --> J["render/graph-html.ts : saveGraphHtml"]
  J --> K["store/git.ts : saveGitState"]
  K --> L["per-type counts plus reparsed and reused"]
```

The fast path is the point: a no-op re-index writes nothing at all.

### `get_project_map`

`projectDir` — the table of contents for everything else.

```mermaid
flowchart LR
  A["get_project_map(projectDir)"] --> B["index.routes"]
  B --> C["index.routeSubtree per route<br/>renders plus defines, depth 10"]
  C --> D["outEdges kind calls, the APIs each screen hits"]
  D --> E["render/project-map.ts : renderProjectMap"]
  E --> F["route list with component trees"]
  E --> G["Mermaid route-to-route nav diagram"]
```

### `search_graph`

`projectDir`, `query` — find a node when you do not know its exact name.

```mermaid
flowchart LR
  A["search_graph(projectDir, query)"] --> B["analyze/search.ts : searchNodes"]
  B --> C["exact name or id, score 100"]
  B --> D["name starts with, score 80"]
  B --> E["name contains, score 60"]
  B --> F["id contains, score 40"]
  C --> G["sort, take 20"]
  D --> G
  E --> G
  F --> G
  G --> H["describeRelations, up to 6 in and out edges each"]
```

### `get_impact`

`projectDir`, `target` — what breaks if I change this, inside one repo.

The only tool with no separate analyzer: the handler in `tools.ts` composes two
`GraphIndex` traversals directly. The thresholds are policy, not math.

```mermaid
flowchart TD
  A["get_impact(projectDir, target)"] --> B["index.resolve(target)"]
  B --> C["top 3 matches, rest reported as omitted"]
  C --> D["index.dependents — reverse walk, every edge kind"]
  D --> E["group by type: components, files, routes, hooks"]
  D --> F["blast radius over all affected ids"]
  F --> G["outEdges calls, the APIs"]
  F --> H["outEdges uses to context, the state"]
  F --> I["outEdges invokes, the native channels"]
  E --> J{"regression risk"}
  J -->|"3 or more routes, or 20 or more dependents"| K["High"]
  J -->|"1 or more route, or 6 or more dependents"| L["Medium"]
  J -->|"otherwise"| M["Low"]
  E --> N["dependent list capped at 40 plus an and-N-more tail"]
```

### `what_if`

`projectDir`, `action` (`remove` | `split` | `lazy_load`), `target` — single-node digital twin.

```mermaid
flowchart TD
  A["what_if(projectDir, action, target)"] --> B["index.resolve, best match only"]
  B --> C{"action"}
  C -->|"remove"| D["simulateRemove"]
  D --> D1["direct in-edges, excluding defines and imports<br/>those are mechanical, not breakage"]
  D --> D2["transitive dependents, routes that stay safe, files to touch"]
  C -->|"split"| E["simulateSplit"]
  E --> E1["call sites to update"]
  E --> E2["natural boundaries from child and state clusters"]
  C -->|"lazy_load"| F["simulateLazyLoad"]
  F --> F1["exclusive versus shared subtree"]
  F --> F2["loading boundaries needed, and whether it is worth it"]
```

### `simulate_pr`

`projectDir`, `ref?`, `base?`, `patch?` — the whole-PR digital twin. Builds two graphs.

```mermaid
flowchart TD
  A["simulate_pr(projectDir, ref, base, patch)"] --> B["resolveBase: master then main"]
  B --> C{"stored graph commit equals target sha?"}
  C -->|"yes"| D["reuse the stored graph, skip the worktree"]
  C -->|"no"| E["store/git.ts : withWorktree<br/>temp dir, your checkout is never touched"]
  E --> F["applyPatch when a diff file was passed"]
  F --> G["indexProject with force true"]
  D --> H{"subtract edge sets"}
  G --> H
  H -->|"edges ADDED"| I["a path just went live"]
  H -->|"edges REMOVED"| J["a flow just broke"]
  I --> K["1. userSurface — routes the user sees change"]
  I --> L["2. reactivatedLegacy — new edge into untouched code<br/>older than 180 days, at most 40 git probes"]
  I --> M["3. contractRisks — changed contract types<br/>still called by untouched consumers"]
  M --> M1["firstUnguardedChain scans 12 lines past the call site"]
  J --> N["4. brokenFlows — caller left pointing at something deleted"]
  I --> O["5. renderCrossApp — delegates to fleet, see below"]
  K --> P["verdict plus ranked test scope<br/>each section capped at 12 rows"]
  L --> P
  M --> P
  N --> P
  O --> P
```

Contract types are `api`, `service`, `controller`, `entity`, `hook`, `context`, `channel` —
change one and you have changed somebody else's contract. `reactivatedLegacy` is the
incident this tool exists for: a change silently switches execution onto a stale path whose
response shape was never updated, it returns null, the frontend crashes.

### `impact_across_apps`

`projectDir`, `target` — one backend, many apps, no PR required.

```mermaid
flowchart TD
  A["impact_across_apps(projectDir, target)"] --> B{"contextifly.workspace.json present?"}
  B -->|"no"| C["scaffoldFleetConfig — starter file, never overwrites"]
  B -->|"yes"| D["for each declared app"]
  D --> E["role release: master then main, via withWorktree<br/>what users are actually running"]
  D --> F["role checkout: the branch that repo has open<br/>working tree included, only when it differs"]
  E --> G["cache at .pixelcontextifly/fleet, keyed by sha<br/>a dirty tree is never cached"]
  F --> G
  G --> H["analyze/endpoints.ts : endpointMatch"]
  H -->|"identical shape"| I["confidence 1.0"]
  H -->|"same depth, parameter meets literal"| J["confidence 0.8"]
  H -->|"segment-aligned suffix"| K["confidence 0.6 — set basePath to confirm"]
  I --> L["per app: affected endpoints, up to 6 call sites,<br/>the screens behind them"]
  J --> L
  K --> L
  L --> M["apps proven NOT affected"]
  L --> N["mobile breaks escalated — shipped builds cannot be hotfixed"]
```

When `release` and `checkout` disagree, that disagreement is the answer: a feature branch
that already migrated reports clean while production is one merge from crashing.

### `trace_flow`

`projectDir`, `from`, `to?` — a user journey, in a few hundred tokens.

```mermaid
flowchart LR
  A["trace_flow(projectDir, from, to)"] --> B{"was to supplied?"}
  B -->|"yes"| C["shortest path over navigates_to, renders, calls"]
  C --> D["decorate each step with its API calls and alternative branches"]
  B -->|"no"| E["forward journey tree from that entry point"]
  D --> F["render/visual.ts : traceFlow"]
  E --> F
  F --> G["styled Mermaid diagram"]
  F --> H["numbered step list with file paths"]
```

### `explain_visually`

`projectDir`, `target` — a multi-diagram dossier for one node.

```mermaid
flowchart TD
  A["explain_visually(projectDir, target)"] --> B["render/visual.ts : renderExplainVisually"]
  B --> C["navigation-in: how users reach it"]
  B --> D["render tree: what it is composed of"]
  B --> E["data flow: API to hook to state to UI"]
  B --> F["state-placement decision tree<br/>with this project's branch highlighted"]
  C --> G["bounded at 22 nodes per diagram, depth 3"]
  D --> G
  E --> G
  F --> G
```

Every box is a real node from the codebase — it speaks React and Flutter both.

### `get_feature`

`projectDir`, `feature?` — reason in features, not files.

```mermaid
flowchart TD
  A["get_feature(projectDir, feature)"] --> B{"config file?"}
  B -->|"contextifly.features.json or .pixelcontextifly/features.json"| C["loadFeatureConfig<br/>patterns: route path, file glob, symbol fragment"]
  B -->|"none"| D["deriveFeatures — auto, from top-level route segments"]
  C --> E{"feature name given?"}
  D --> E
  E -->|"no"| F["renderFeatureList — all features, member counts,<br/>cross-feature shared nodes"]
  E -->|"yes"| G["renderFeature — routes, components, state, APIs,<br/>entry points from outside the feature"]
```

### `match_screenshot`

`projectDir`, `element?` or `markdown?` — UI element to component. Text in, no upload.

```mermaid
flowchart LR
  A["match_screenshot(projectDir, element, markdown)"] --> B{"which input?"}
  B -->|"element"| C["one query"]
  B -->|"markdown"| D["extractUiCandidates — bold, quoted, code, headings<br/>capped at 20"]
  C --> E["analyze/search.ts : matchUiElement"]
  D --> E
  E --> F["whole phrase, weight 2"]
  E --> G["each token of 3 or more chars, weight 1"]
  F --> H["sum scores, drop files, threshold 60, top 5"]
  G --> H
  H --> I["per match: the node plus the routes<br/>whose render tree contains it"]
```

### `analyze_project`

`projectDir` — architecture score 0 to 100, no LLM involved.

```mermaid
flowchart TD
  A["analyze_project(projectDir)"] --> B["analyze/health.ts : analyzeProject"]
  B --> C["circular imports"]
  B --> D["possibly-dead components and hooks"]
  B --> E["API routes never called from the UI"]
  B --> F["oversized components, by loc"]
  B --> G["duplicate component names"]
  B --> H["structural duplicates — same JSX shape fingerprint,<br/>copy-pasted then renamed"]
  D --> I["FRAMEWORK_ENTRY exemption:<br/>page, layout, template, error, loading, not-found,<br/>global-error, default, middleware, app, document"]
  C --> J["score plus debt lists"]
  E --> J
  F --> J
  G --> J
  H --> J
  I --> J
```

The exemption matters: Next.js invokes those files itself, so no import edge exists and a
naive dead-code check would flag every page in the app.

### `graph_diff` and `graph_timeline`

`projectDir`, `snapshot?` — and `projectDir`. Both read history, neither writes it.

```mermaid
flowchart TD
  A["saveGraph, during index_project"] --> B{"contentKey differs?<br/>files plus nodes plus edges, ignoring indexedAt"}
  B -->|"no"| C["no snapshot — no-op re-indexes never pile up history"]
  B -->|"yes"| D["archive previous to history, keep the newest 20"]
  D --> E["graph_diff: newest snapshot, or the one you name"]
  E --> F["render/history.ts : renderGraphDiff<br/>added and removed routes, components, hooks,<br/>contexts, APIs, plus coupling changes"]
  D --> G["graph_timeline: every snapshot oldest first, plus current"]
  G --> H["render/history.ts : renderTimeline<br/>dated and git-commit tagged"]
```

### `token_savings`

`projectDir` — the exploration-avoided report.

```mermaid
flowchart LR
  A["token_savings(projectDir)"] --> B["registered directly, NOT through the wrapper"]
  B --> C["so the report never counts itself"]
  A --> D["store/usage-ledger.ts : renderSavingsReport"]
  D --> E["measured: answer sizes, latency"]
  D --> F["estimated: files not read, tokens avoided"]
  E --> G["render/savings-html.ts : saveSavingsHtml"]
  F --> G
  G --> H["markdown report plus offline styled dashboard"]
```

Primary claim is work avoided, not tokens. Every derived figure is badged estimated; the
skill prompt forbids calling this proactively.

## 8. Skill catalogue — all 4

Skills are **instructions, not code**: markdown under `packages/mcp-server/skills/<name>/`,
loaded by the AI, telling it which tool to reach for, in what order, and what it may claim
about the result. They ship with the plugin and need no setup. Full treatment, including
how to add one: [SKILLS.md](SKILLS.md).

### `codegraph-copilot`

Triggers on: "explain this project", onboarding docs, "find the payment flow", complexity
estimates, ticket breakdown, "why is X broken".

```mermaid
flowchart TD
  A["project-level question"] --> B["index_project"]
  B --> C["get_project_map — always, it is the table of contents"]
  C --> D{"which playbook"}
  D -->|"explain this project"| E["analyze_project plus highest-degree search_graph<br/>then read the entry point and 2 or 3 central components"]
  D -->|"find the X flow"| F["trace_flow(from, to)<br/>then read only the files the step list names"]
  D -->|"visualize state management"| G["search_graph per context<br/>then who uses each, ranked Mermaid"]
  D -->|"estimate complexity"| H["get_impact<br/>S under 5 dependents, M 5 to 15, L over 15 or 3 plus routes"]
  D -->|"break into tickets"| I["complexity first, then dependency order:<br/>schema, API, state, UI, wiring, tests"]
  D -->|"why is X broken"| J["dependency chain, then graph_timeline or graph_diff,<br/>then git log -S — graph AND git"]
  J --> K["a missing edge is evidence too:<br/>the expected uses or calls edge that is not there"]
```

### `codegraph-refactor`

Triggers on: "what should I refactor", split or merge, extract shared logic, dead code,
bundle size. Produces a plan and never applies it.

```mermaid
flowchart TD
  A["refactoring request"] --> B["index_project — stale advice is worse than none"]
  B --> C["analyze_project: score plus debt lists"]
  B --> D["get_project_map: route and component structure"]
  C --> E["candidates"]
  D --> E
  E --> F["get_impact on EVERY candidate before recommending it"]
  F --> G["blast radius sets both risk label and priority"]
  G --> H["read the source of the top 3 to 5<br/>the graph says where, only the code says whether"]
  H --> I["max 6 suggestions, ranked by value to risk"]
  I --> J["dead-code items carry the barrel and dynamic-import caveat<br/>plus the grep that verifies them"]
  I --> K["clean bill at score 90 or above: say so and stop,<br/>never fabricate busywork"]
```

### `codegraph-whatif`

Triggers on: "is this PR safe to merge?", "who breaks if I change this service?", "what do
I regression-test?", "why did untouched code crash?"

```mermaid
flowchart TD
  A["blast-radius question"] --> B["index_project first, re-index if stale"]
  B --> C{"what is being asked"}
  C -->|"is this PR safe"| D["simulate_pr with ref, or patch for an unfetched PR"]
  C -->|"I am about to change OrdersService"| E["impact_across_apps"]
  C -->|"delete, split or lazy-load one node"| F["what_if"]
  C -->|"what depends on this, no verdict needed"| G["get_impact"]
  D --> H["read the output in order of DANGER, not order of output"]
  H --> H1["1. reactivated legacy paths — the headline"]
  H --> H2["2. flows that break"]
  H --> H3["3. contract risk with unguarded dereferences"]
  H --> H4["4. cross-app impact"]
  H --> H5["5. test scope, hand this over as the checklist"]
  E --> I["report BOTH versions of every app"]
  I --> I1["release: what users run"]
  I --> I2["checkout: the branch that repo has open"]
  I1 --> J["when they disagree, state the ordering constraint out loud"]
  I2 --> J
```

The reporting rules are the skill's real content: lead with the blocker not the summary,
report the unaffected apps too because reachability is a closed set, escalate mobile
because shipped builds cannot be hotfixed, and state the static-analysis ceiling once at
the end rather than hedging every line.

### `codegraph-rosetta`

Triggers on: "explain this like I'm a NestJS dev", or landing in a backend framework you
do not know.

```mermaid
flowchart TD
  A["unfamiliar codebase"] --> B["home framework: from their words, else one short question"]
  A --> C["target framework: detect from marker files, never ask"]
  C --> C1["manage.py or settings.py, INSTALLED_APPS: Django"]
  C --> C2["pom.xml or build.gradle plus SpringBootApplication: Spring Boot"]
  C --> C3["fastapi or flask in requirements: FastAPI or Flask"]
  C --> C4["go.mod: Go — Cargo.toml with axum or actix: Rust"]
  C --> C5["nestjs/core in package.json: NestJS"]
  B --> D["load skills/codegraph-rosetta/references/framework.md"]
  C1 --> D
  C2 --> D
  C3 --> D
  C4 --> D
  C5 --> D
  D --> E["translate concepts both ways:<br/>controllers, DI, modules, entities, guards, middleware"]
  E --> F["anchor every concept to a REAL file in this repo<br/>never explain the framework in the abstract"]
  F --> G["walk the reading order, mental-model gotchas included"]
```

Two rules run through all of them, and they're the reason the skills exist at all:

- **Query the graph first, read code second.** The graph gives the verified skeleton;
  source files are only for behaviour the graph can't see — validation rules, retry logic,
  error dialogs — and only the files the tool output already named.
- **Never launder a confidence score.** Cross-repo matches below 100% and the
  unguarded-dereference sniff are heuristic. The caveat is passed through, once, not
  hedged on every line. `codegraph-whatif` additionally requires reporting the *unaffected*
  apps — reachability is a closed set, so "delivery-app is fine" is a proof, not a
  guess — and escalating mobile breaks, because shipped builds can't be hotfixed.

## 9. Where state lives

| What | Where | Notes |
|---|---|---|
| The graph | `<project>/.pixelcontextifly/graph.json` | derived data, self-ignoring, never committed |
| Snapshots | `.pixelcontextifly/history/*.json` | last 20; powers `graph_diff` / `graph_timeline` |
| Git position | `.pixelcontextifly/git-state.json` | staleness check without re-parsing anything |
| Consumer app graphs | `.pixelcontextifly/fleet/<app>.json` | keyed by that app's master sha |
| Usage ledger | written by `store/usage-ledger.ts` | powers `token_savings` |

Everything in `.pixelcontextifly/` is disposable: delete it and the next `index_project`
rebuilds it.

## 10. `packages/render` — read this before you touch it

An R&D spike: compiling declarative UI into a measurable execution model
(React IR → Runtime IR → Execution Plan → Scene Frames), validated against React itself.
Plain `.cjs` scripts, run by hand, **not imported by any shipped package**, and its npm
scripts point at a hard-coded path on one developer's machine. Treat it as a lab
notebook, not as part of the product — and don't wire it in without deciding it graduated.

## 11. Reading order for a new developer

1. `packages/mcp-server/src/graph/types.ts` — 160 lines. The whole data model. Nothing
   else makes sense before this.
2. `packages/mcp-server/src/graph/README.md` — the engine's own map.
3. `packages/mcp-server/src/graph/analyze/graph-index.ts` — the three traversals every
   feature is built from: `resolve`, `routeSubtree`, `dependents`.
4. `packages/mcp-server/src/graph/mcp/tools.ts` — read **one** tool handler end to end.
   They're all the same shape: load index → call analyzer → render → return.
5. `packages/mcp-server/src/graph/extract/providers/nestjs.ts` — the smallest complete
   provider (276 lines). Now you know how source becomes graph.
6. `ARCHITECTURE.md` — the rules, now that you can see what they're protecting.

## 12. Where does my change go?

| I want to… | Put it in |
|---|---|
| support a new framework | `graph/extract/providers/<name>.ts` — nothing else changes |
| answer a new question about the code | `graph/analyze/`, as a pure function taking `GraphIndex` |
| show an existing answer differently | `graph/render/` |
| give the AI a new tool | `graph/mcp/tools.ts` — wire an analyzer to a renderer |
| read git or the filesystem | `graph/store/`, then call it from `analyze/` |
| add a shared type | `packages/shared/src/index.ts` |
| teach the AI a workflow, not a capability | `packages/mcp-server/skills/<name>/SKILL.md` — see [SKILLS.md](SKILLS.md) |

If your change doesn't fit any row, that's a signal worth taking seriously — see the
governance section of `ARCHITECTURE.md` before building it.

## 13. Verifying a change

```bash
pnpm build                       # typecheck + emit, whole workspace
pnpm --filter @contextifly/mcp-server test   # graph self-checks
```

The self-check covers the two genuinely heuristic pieces (cross-repo endpoint matching
and the unguarded-dereference sniff). Everything else in the engine is deterministic
traversal — if it breaks, the typechecker or a tool answer will say so loudly.
