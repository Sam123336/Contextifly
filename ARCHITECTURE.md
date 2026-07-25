# Architecture

**Contextifly is a compiler for software architecture.** It compiles source
code, UI, APIs, and infrastructure into a stable intermediate representation
that powers deterministic software intelligence.

## The pipeline

_Code-level map of where all of this lives: [CODE_ARC.md](CODE_ARC.md)._

```
Providers → Versioned IR → Normalizer → Algorithms → AI
```

| Stage | What it does | Where it lives |
| ----- | ------------ | -------------- |
| **Providers** | Compile one slice of the project (a framework, a spec format, a config file) into IR nodes and edges | `packages/mcp-server/src/graph/extract/providers/` |
| **IR** | The versioned node/edge schema — the stable contract everything else is written against | `packages/mcp-server/src/graph/types.ts`, spec in `docs/GRAPH-SPEC.md` |
| **Normalizer** | Assigns framework-agnostic semantic roles (`entry-point`, `business-logic`, `data-model`, …) on top of syntax-level types | `packages/mcp-server/src/graph/extract/normalizer.ts` |
| **Algorithms** | Impact analysis, traces, diffs, architecture scoring, project maps — pure graph computation, provider-agnostic | `packages/mcp-server/src/graph/analyze/` |
| **Rendering** | Turns analyzer output into markdown, Mermaid, HTML | `packages/mcp-server/src/graph/render/` |
| **AI** | Explains, summarizes, plans — always the last step | `packages/mcp-server/src/graph/mcp/tools.ts` + `skills/` |

## The three rules

1. **Providers never know each other.** Cross-provider linking happens only
   through shared deterministic node ids (e.g. a frontend `fetch` and a NestJS
   `@Post()` handler both emitting `api:POST /orders`). The orchestrator merges;
   providers stay independent.

2. **Algorithms consume only the IR.** No algorithm may import a parser, read
   source code, or special-case a framework. If an algorithm needs a fact, a
   provider must put that fact in the graph.

3. **AI never discovers architecture.** Discovery is the compiler's job. The AI
   may read source files the graph localizes for it, but every structural claim
   it makes must be backed by graph edges — and every edge carries provenance
   (`file:line`) and a confidence, so answers cite evidence instead of guessing.

## Division of responsibilities

```
Compiler responsibilities          AI responsibilities
✓ Discover symbols                 ✓ Explain
✓ Build relationships              ✓ Summarize
✓ Produce deterministic facts      ✓ Teach
✓ Attach provenance                ✓ Plan
✓ Normalize semantics              ✓ Answer questions

AI must never create architectural facts that are not backed by the graph.
```

## Governance

Every new feature must be implementable as one of:

- a **Provider** (new input: framework, spec, config, ownership data, tests, …),
- a **Normalizer** rule (new semantic role, deterministically derivable),
- an **Algorithm** (new graph computation), or
- an **AI Skill** (new way of explaining what the graph already knows).

If a feature doesn't fit one of those four shapes, the architecture is drifting —
stop and redesign before building it.

The IR schema is versioned (`ProjectGraph.version`). Providers change freely;
the IR changes deliberately. Old graphs are derived data: they are re-indexed,
never migrated.

## Current providers

| Provider | Input | Status |
| -------- | ----- | ------ |
| `frontend` | React / Next.js / generic TS via ts-morph | ✅ incremental re-indexing |
| `nestjs` | NestJS decorators (controllers, services, modules, entities, routes, DI) via ts-morph | ✅ full-scan |
| `dart` | Dart / Flutter via structural scanner | ✅ full-scan (beta) |

Planned, in order: OpenAPI/Swagger (HTTP provider — breadth across any backend
language + cross-repo linking), Prisma (data layer), ownership
(CODEOWNERS + git history), tests (Vitest/Jest coverage edges), docker-compose
(infra-to-code stitching). Runtime providers (OpenTelemetry) come later — only
then does "digital twin" become an honest description; until then this is
static software intelligence.

## Claims discipline

- The graph knows **structure**, not **behavior**. Don't promise runtime answers
  (latency, cache hit rates, row counts) until a runtime provider exists.
- A heuristic edge is marked with `confidence < 1` and a `reason` — surfacing
  uncertainty is a feature, not an apology.
- The moat is extraction correctness across messy real-world codebases.
  Algorithms are the showcase; the graph people trust is the asset.
