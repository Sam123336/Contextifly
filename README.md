<div align="center">

<img src="docs/images//Users/sambit/gemini-svg.svg" alt="Contextifly — See it. Understand it. Build better." width="320">

# Contextifly

### A persistent context engine for AI coding assistants

*Your AI re-discovers your project in every conversation. Contextifly gives it a memory.*

[![Version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/Sam123336/Contextifly)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-8A2BE2)](https://modelcontextprotocol.io)
[![React](https://img.shields.io/badge/React%20%2F%20Next.js-full-61DAFB?logo=react&logoColor=white)](#-tools)
[![NestJS](https://img.shields.io/badge/NestJS-full--stack-E0234E?logo=nestjs&logoColor=white)](#-tools)
[![Flutter](https://img.shields.io/badge/Flutter-beta-02569B?logo=flutter&logoColor=white)](#-tools)

**[Quick start](#-quick-start-60-seconds) · [Setup](#-setup) · [Your own API key](#-use-your-own-api-key-for-image-reading) · [Tools](#-tools) · [Self-hosting](#-self-hosting)**

</div>

---

## 🤔 What is Contextifly?

Every AI assistant has the same problem: **it forgets your project between conversations.** Each time you ask a question, it searches dozens of files, re-reads the same code, re-analyzes the same screenshots, and guesses at dependencies. You pay in **time, tokens, and wrong answers**.

Contextifly fixes this with two engines feeding one **Software Knowledge Graph**:

| | 📸 Screenshot Engine | 🕸️ Code Engine |
|---|---|---|
| **Input** | UI screenshots (PNG/JPEG/WebP) | Your React/Next.js, NestJS, or Flutter code |
| **Output** | Structured markdown — screen type, components, layout, design issues | A live graph — components, routes, state, API calls, controllers, services, entities — and how they connect, **frontend to backend**: a `fetch('/orders')` links straight to the controller that handles it |
| **Saves** | ~95% of vision tokens per screenshot (measured) | Repeated code exploration — a ~25–40-file search becomes one graph query (est. ~90% fewer exploration tokens) |
| **Runs** | Free hosted backend (or your own key/server) | **100% on your machine — code never leaves it** |

```
Without Contextifly                      With Contextifly

"How does checkout work?"               "How does checkout work?"
  → Claude searches 40+ files             → Claude asks the graph
  → reads 15–20 of them                   → gets the traced flow + file paths
  → guesses the rest                      → reads only 2–3 files for detail

~45 s · ~60,000 tokens · guesses        ~2 s · a few hundred tokens · verified
```

---

## ⚡ Quick start (60 seconds)

**1.** Install the plugin (no account, no API key needed):

```bash
claude plugin marketplace add Sam123336/Contextifly
claude plugin install contextifly@contextifly
```

**2.** Open a new Claude Code session inside your project and ask:

> index this project with contextifly

**3.** That's it. Now try:

> show me the project map
> what breaks if I change ProductCard?
> trace the flow from /cart to /orders
> analyze this screenshot with contextifly: /path/to/screenshot.png

💡 Bonus: open `.pixelcontextifly/graph.html` in any browser — an interactive map of your whole app.

---

## 📦 Setup

Pick the one that matches how you work:

<details>
<summary><b>🖥️ Claude Code (CLI or VS Code extension) — recommended</b></summary>

<br>

If you don't have Claude Code yet:

```bash
npm install -g @anthropic-ai/claude-code
```

Then install the plugin (from any terminal):

```bash
claude plugin marketplace add Sam123336/Contextifly
claude plugin install contextifly@contextifly
```

Or from *inside* a Claude Code session:

```
/plugin marketplace add Sam123336/Contextifly
/plugin install contextifly@contextifly
```

Start a **new** session and the 14 tools + 2 skills are available automatically. Updating later: `claude plugin update contextifly`.

</details>

<details>
<summary><b>🖱️ Claude Desktop app</b></summary>

<br>

Claude Desktop uses an MCP config file instead of the plugin marketplace.

**1.** Clone this repo somewhere permanent:

```bash
git clone https://github.com/Sam123336/Contextifly.git ~/contextifly
```

**2.** Open your Claude Desktop config:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

**3.** Add Contextifly to `mcpServers` (use your real absolute path):

```json
{
  "mcpServers": {
    "contextifly": {
      "command": "node",
      "args": ["/Users/you/contextifly/packages/mcp-server/bundle/index.cjs"],
      "env": {
        "CONTEXTIFLY_BACKEND_URL": "https://contextifly-backend-gukt.onrender.com"
      }
    }
  }
}
```

**4.** Restart Claude Desktop. Ask Claude to *"index the project at /path/to/my/app with contextifly"* (Desktop needs absolute paths since it has no working directory).

</details>

<details>
<summary><b>🎯 Cursor / any other MCP client</b></summary>

<br>

Any MCP-capable client works the same way as Claude Desktop: run the server over stdio.

```json
{
  "mcpServers": {
    "contextifly": {
      "command": "node",
      "args": ["/absolute/path/to/Contextifly/packages/mcp-server/bundle/index.cjs"]
    }
  }
}
```

</details>

<details>
<summary><b>⌨️ CLI only (no AI at all — terminals, scripts, CI)</b></summary>

<br>

The same binary is a standalone CLI — with its own terminal branding (blue→purple gradient on real TTYs, plain when piped, respects `NO_COLOR`):

```
 ▄▄▄▄▄ ▄▄▄▄▄ ▄   ▄ ▄▄▄▄▄ ▄▄▄▄▄ ▄   ▄ ▄▄▄▄▄ ▄▄▄ ▄▄▄▄▄ ▄   ▄
 █     █   █ ██  █   █   █      ▀▄▀    █    █  █      ▀▄▀
 █     █   █ █ █ █   █   █▄▄▄  ▄▀ ▀▄   █    █  █▄▄▄    █
 █▄▄▄▄ █▄▄▄█ █  ██   █   █▄▄▄▄ █   █   █   ▄█▄ █       █
 see it · understand it · build better
```

```bash
node packages/mcp-server/bundle/index.cjs index .              # build graph + graph.html
node packages/mcp-server/bundle/index.cjs map .                # routes, components, nav flow
node packages/mcp-server/bundle/index.cjs analyze .            # architecture score
node packages/mcp-server/bundle/index.cjs impact . ProductCard # blast radius + risk
node packages/mcp-server/bundle/index.cjs feature . Checkout   # feature dossier
node packages/mcp-server/bundle/index.cjs diff .               # what changed
```

The graph itself is plain JSON at `.pixelcontextifly/graph.json` — the format is documented in [docs/GRAPH-SPEC.md](docs/GRAPH-SPEC.md), so any tool can consume it.

</details>

---

## 🔑 Use your own API key for image reading

Screenshot analysis works **out of the box** with the free hosted backend — no key needed. But you can plug in your own LLM key for faster/better/private image reading. Your key is sent per request and **never stored server-side**.

Set these environment variables where Claude Code runs:

| Env var | What it does | Required? |
|---|---|---|
| `CONTEXTIFLY_LLM_PROVIDER` | `gemini`, `openai`, `anthropic`, or `openai-compatible` | yes (to enable) |
| `CONTEXTIFLY_LLM_API_KEY` | Your key for that provider | yes (to enable) |
| `CONTEXTIFLY_LLM_MODEL` | Model id | only for `openai-compatible` |
| `CONTEXTIFLY_LLM_BASE_URL` | Endpoint URL | only for `openai-compatible` |
| `CONTEXTIFLY_BACKEND_URL` | Your own backend instead of the hosted one | no |

<details>
<summary><b>Example: Google Gemini</b></summary>

```bash
export CONTEXTIFLY_LLM_PROVIDER=gemini
export CONTEXTIFLY_LLM_API_KEY=AIza...
```
</details>

<details>
<summary><b>Example: OpenAI</b></summary>

```bash
export CONTEXTIFLY_LLM_PROVIDER=openai
export CONTEXTIFLY_LLM_API_KEY=sk-...
```
</details>

<details>
<summary><b>Example: Anthropic Claude</b></summary>

```bash
export CONTEXTIFLY_LLM_PROVIDER=anthropic
export CONTEXTIFLY_LLM_API_KEY=sk-ant-...
```
</details>

<details>
<summary><b>Example: Groq / OpenRouter / Ollama / any OpenAI-compatible endpoint</b></summary>

```bash
export CONTEXTIFLY_LLM_PROVIDER=openai-compatible
export CONTEXTIFLY_LLM_API_KEY=gsk_...
export CONTEXTIFLY_LLM_MODEL=llama-3.2-90b-vision-preview
export CONTEXTIFLY_LLM_BASE_URL=https://api.groq.com/openai/v1
```

Works with any endpoint that speaks the OpenAI Chat Completions API and has a vision-capable model — Groq, OpenRouter, Together, Fireworks, vLLM, Ollama…
</details>

| Provider | `provider` value | Default model |
|---|---|---|
| Google Gemini | `gemini` | `gemini-2.5-flash-lite` |
| OpenAI | `openai` | `gpt-4o` |
| Anthropic Claude | `anthropic` | `claude-3-5-sonnet-latest` |
| OpenAI-compatible | `openai-compatible` | *(you specify)* |

> 🗒️ **Note:** the key is only for the **screenshot** engine. The code graph never uses any LLM — it's a compiler-style parser that runs entirely on your machine.

---

## 🧰 Tools

14 MCP tools, available the moment the plugin is installed:

### 📸 Screenshots

| Tool | What it does |
|---|---|
| `analyze_screenshot` | Screenshot → structured developer markdown (~95% fewer vision tokens), with token-savings stats |
| `get_screenshot` | Fetch a previous analysis by id |

### 🕸️ Software Knowledge Graph

| Tool | What it does |
|---|---|
| `index_project` | Build/refresh the graph (100% local, incremental — milliseconds after first run). Also writes the interactive `graph.html` visualization |
| `get_project_map` | Every route with its component tree + API calls, plus a Mermaid navigation diagram |
| `trace_flow` | 🔥 User journeys as styled flow diagrams: cart → screens → API calls → order tracking, with numbered steps and file paths. A whole checkout flow ≈ 200–500 tokens instead of reading dozens of files |
| `get_impact` | "What breaks if I change X?" — affected components/routes/contexts, APIs in the blast radius, Low/Med/High regression risk. Also answers reverse queries: "where does GET /products appear visually?" |
| `what_if` | 🔥 Digital twin: simulate `remove` / `split` / `lazy_load` **before** touching code — what breaks, what stays safe, whether it's worth it |
| `simulate_pr` | 🔥 Digital twin of a whole PR: indexes the code **before and after** in a throwaway git worktree and subtracts the graphs. A text diff shows which lines changed; this shows what those lines are now *connected to* — 🕰 **reactivated legacy paths** (a new edge into code the PR doesn't touch and nobody has committed to in months: the classic "our change quietly switched execution onto stale code that returns null and crashed the frontend"), flows left pointing at something deleted, contract risk with unguarded dereferences flagged at the call site, and a ranked test scope. Your checkout is never touched |
| `impact_across_apps` | 🔥 One backend, many apps: "if I change `OrdersService`, which app breaks and on which screen?" Joins repos on the only symbol they share — the endpoint — so a NestJS controller links to a Flutter `http.get` and a web `fetch()`. Every consumer app is analysed at **two** versions — its **master** (what users are running) and the branch it currently has checked out, uncommitted edits included — because those disagree: a frontend branch that already migrated reports clean while production is still one merge away from crashing. Reports affected screens, the ordering constraint between the two changes, *and* proves which apps are untouched. Mobile breaks are escalated automatically: shipped builds can't be hotfixed |
| `explain_visually` | Multi-diagram Mermaid dossier for any node: how users reach it, what it's made of, where its data flows, and a state-placement decision tree with *your project's* branch highlighted (speaks React *and* Flutter) |
| `analyze_project` | Architecture score 0–100: circular imports, dead code, unused API routes, oversized components, duplicate component names, **structural duplicates** (copy-pasted-then-renamed components caught by JSX-shape fingerprint), usage heatmap, state fan-out |
| `get_feature` | Think in features, not files: "explain Authentication" → its routes, components, state, APIs, and entry points |
| `match_screenshot` | "Orange Checkout Button" → the component that implements it + the screens it appears on |
| `blueprint_screenshot` | 🔥 The full "eye" loop: screenshot analysis (with its ASCII Screen Sketch) → every sketched element mapped to its component/file/screen → the code-side render tree → a brief for 3 design-variant sketches, generated from the tiny ASCII instead of re-reading the image |
| `search_graph` | Find any component/route/API by name with its full relationship neighborhood |
| `graph_diff` | What changed architecturally between two snapshots |
| `graph_timeline` | The whole architecture's evolution, dated and git-commit-tagged |
| `token_savings` | 📊 Exploration-avoided report: how many files the AI *didn't* have to read (estimated, per-question baseline), measured answer sizes + latency, estimated reduction %, and real measured screenshot-compression savings — every number labeled measured or estimated. Also available as `contextifly savings .` in the CLI |

### 🤖 Bundled skills (zero setup)

- **codegraph-copilot** — "explain this project", "find the payment flow", "estimate this feature", "break it into tickets", root-cause analysis via graph + git history
- **codegraph-refactor** — prioritized refactoring plans where every suggestion is impact-checked first; finds duplicate and structurally identical components and plans the merge with the verified call-site list
- **codegraph-rosetta** — framework translator: know NestJS but landed in a Django / Spring Boot / FastAPI / Flask / Go / Rust codebase? It detects the stack, translates every concept into the framework you know (controllers ↔ views, DI ↔ `Depends()`, guards ↔ permission classes…), and walks you through *this* repo's real files — mental-model gotchas included
- **codegraph-whatif** — 🆕 pre-merge blast radius: "is this PR safe?", "if I change this service, does the customer app break?" Drives `simulate_pr` and `impact_across_apps`, and reads their output in order of danger — because the incidents come from the code you *didn't* change and therefore never thought to test

---

## ✨ Why it's different

- 🧠 **Compiler, not chatbot** — the graph is built by real parsers organized as pluggable providers (TypeScript compiler for React/Next.js and NestJS decorators, structural scanner for Flutter) emitting one versioned IR. The AI only *queries*; it never guesses structure. Every edge carries provenance (`file:line`) and a confidence, so answers cite evidence. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design rules, and [CODE_ARC.md](CODE_ARC.md) for the developer's map of where every part of the code lives.
- 🔗 **Full-stack tracing** — frontend `fetch`/`axios` calls and backend `@Get`/`@Post` handlers merge into the same endpoint node: checkout button → `POST /orders` → `OrderController` → `OrderService` → entity, in one traced path.
- ⚡ **Live context** — every answer hash-checks your files first and auto-refreshes if code changed. No manual re-indexing, ever.
- 🚀 **Incremental indexing** — only changed files (plus their importers) are re-parsed. No-op re-index: **~17ms**, verified byte-identical to a full rebuild.
- 🗺️ **Interactive visualization** — `.pixelcontextifly/graph.html`: force-directed map, color-coded types, search, filters, click any node for its relationships. Works offline, zero dependencies.
- 🕰️ **Temporal graph** — snapshots on every change, tagged with git commits. Ask "what changed this month?"
- 🔓 **Open format** — the graph is documented JSON ([spec](docs/GRAPH-SPEC.md)); any MCP client or plain script can use it.
- 🔒 **Private by design** — source code never leaves your machine. Only screenshots touch a server (and you can self-host that too).

---

## 🌐 HTTP API (screenshot backend)

Use the backend without any plugin:

| Method | Path | Description |
|---|---|---|
| POST | `/screenshots` | Multipart upload (`file`); enqueues analysis |
| GET | `/screenshots/:id` | Status + markdown + token savings |
| GET | `/health` | Liveness check |

Per-request key override headers (key lives only on the in-flight job):

```bash
curl -X POST https://<backend-url>/screenshots \
  -H "x-llm-provider: openai" \
  -H "x-llm-api-key: sk-..." \
  -F "file=@./screenshot.png"
```

Headers: `x-llm-provider`, `x-llm-api-key`, `x-llm-model` (optional), `x-llm-base-url` (openai-compatible only).

---

## 🏠 Self-hosting

<details>
<summary><b>Run locally</b></summary>

<br>

Prerequisites: Node.js 20+, pnpm 9+, Docker.

```bash
pnpm install
docker compose up -d postgres redis
cp .env.example packages/backend/.env   # set LLM_API_KEY
pnpm dev                                # API on http://localhost:3000
```

Point the plugin at it with `CONTEXTIFLY_BACKEND_URL=http://localhost:3000`.

Server-default LLM config (`packages/backend/.env`):

```bash
LLM_PROVIDER=gemini   # gemini | openai | anthropic | openai-compatible
LLM_API_KEY=          # key for the chosen provider
LLM_MODEL=            # blank → provider default; required for openai-compatible
LLM_BASE_URL=         # only for openai-compatible
```
</details>

<details>
<summary><b>Deploy on Render (free tier)</b></summary>

<br>

[`render.yaml`](render.yaml) is a ready-made blueprint. Create a free Postgres database ([Neon](https://neon.tech)) and Redis ([Upstash](https://upstash.com)), then on [Render](https://render.com): **New → Blueprint** → pick your fork → fill in `DATABASE_URL`, `REDIS_URL`, and `LLM_API_KEY`. Free-plan note: the service sleeps after ~15 idle minutes and takes ~30–60s to wake.
</details>

<details>
<summary><b>Deploy on Azure</b></summary>

<br>

[`deploy/azure.sh`](deploy/azure.sh) provisions Container Apps + managed Postgres + Redis and prints the public URL:

```bash
az login
PG_PASSWORD='<strong-pw>' LLM_API_KEY='<your-key>' ./deploy/azure.sh
```

Redeploys are a button press via the [manual GitHub Actions workflow](.github/workflows/deploy-azure.yml) once the repo secrets/variables documented in that file are set.

Notes for any host: schema is created automatically on boot (Sequelize `synchronize`); single replica by default — uploads are written to local disk and read by the in-process worker. To scale out, mount shared storage at `UPLOAD_DIR`.
</details>

---

## 🗂️ Repository layout

<details>
<summary>pnpm workspace monorepo</summary>

<br>

| Package | Purpose |
|---|---|
| `packages/backend` | NestJS API + BullMQ worker + multi-provider LLM pipeline |
| `packages/mcp-server` | MCP server + CLI + graph engine (the plugin) |
| `packages/shared` | Shared TypeScript types |
| `packages/vscode-extension` | VS Code clipboard / drag-drop integration |

Rebuild the plugin bundle after changing `packages/mcp-server`:

```bash
pnpm --filter @contextifly/mcp-server run bundle:plugin   # → bundle/index.cjs
```

**VS Code extension:** drop or paste a screenshot into any editor, or run **"Contextifly: Analyze Image File…"** from the Command Palette; markdown is inserted at the cursor. Configure via `contextifly.*` settings. Package with `cd packages/vscode-extension && pnpm run package`.
</details>

---

## ❓ FAQ

<details>
<summary><b>Does my code get uploaded anywhere?</b></summary>
<br>
No. The code graph is built entirely on your machine by a local parser and stored in your project folder (auto-gitignored). Only <em>screenshots</em> are sent to the analysis backend — and you can self-host that or bring your own key.
</details>

<details>
<summary><b>Which frameworks are supported?</b></summary>
<br>
React and Next.js (app router + pages router) with full TypeScript-compiler fidelity. NestJS with the same fidelity: controllers, services, modules, entities (TypeORM + sequelize-typescript), routes with global-prefix resolution, and constructor DI — and it links to the frontend graph, so a <code>fetch('/orders')</code> resolves to the controller that handles it. Flutter/Dart in beta: widgets, GoRouter + named routes, http/dio, Riverpod/Provider/Bloc. Mixed monorepos merge into one graph. For frameworks without a parser yet (Django, Spring Boot, FastAPI, Flask, Go, Rust), the bundled <b>codegraph-rosetta</b> skill still onboards you by translating their concepts into a framework you know. OpenAPI/Swagger import and Prisma are next on the roadmap.
</details>

<details>
<summary><b>Do I need to re-index after every change?</b></summary>
<br>
No. Every graph tool checks file hashes before answering and auto-refreshes if anything changed. Re-indexing is incremental — milliseconds, not seconds.
</details>

<details>
<summary><b>The first screenshot call is slow — why?</b></summary>
<br>
The free-tier backend sleeps when idle and takes ~30–60s to wake. Subsequent calls are fast. Self-host or bring your own key to avoid it.
</details>

---

<div align="center">

**MIT License** · Built by [Contextifly](https://github.com/Sam123336/Contextifly) · Issues and PRs welcome 🙌

</div>
