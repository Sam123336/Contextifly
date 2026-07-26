# SKILLS — the four bundled skills, for users and for maintainers

Contextifly ships **17 MCP tools** and **4 skills**. The tools give the AI *capability*;
the skills give it *method* — which tool to reach for, in what order, and what it is not
allowed to claim.

This document has two halves. **Part A** is for developers using the skills. **Part B** is
for anyone changing them.

> Related: [README.md](README.md) (what the product does) · [ARCHITECTURE.md](ARCHITECTURE.md)
> (design rules) · [CODE_ARC.md](CODE_ARC.md) (where the code lives).

---

# Part A — using the skills

## The four, at a glance

| Skill | Ask it when | You get back |
|---|---|---|
| **codegraph-copilot** | "explain this project", "how does checkout work", "why is X broken", "break this into tickets" | verified answers with file paths, Mermaid flows, task lists |
| **codegraph-refactor** | "what should I refactor", "split this component", "find dead code" | ≤6 ranked suggestions, each with a real blast radius |
| **codegraph-rosetta** | "I know NestJS but this is Django", "what's the equivalent of a guard here" | your codebase explained in the framework you already know |
| **codegraph-whatif** | "is this PR safe to merge", "if I change this service does the customer app break" | pre-merge blast radius, cross-repo, with a ship/no-ship verdict |

You don't have to name them. Each declares the phrasings it answers to, and the model
routes automatically. Typing `/contextifly:codegraph-copilot` forces one explicitly.

---

## 1. codegraph-copilot — the everyday copilot

**What it changes.** Without it, "how does checkout work?" makes the AI grep, then open
fifteen files — roughly 40k tokens, and half the answer is inference. With it, the first
move is mandated:

> Use `trace_flow` FIRST — it is the purpose-built, low-token answer… Only read source
> files afterwards, and read only the specific files the step list names, never search broadly.

One call returns a few hundred tokens of *verified* edges plus a Mermaid diagram. Source
reading is then allowed, but only for the files that call named — behavior the graph can't
see (validation rules, retry logic, error dialogs).

**Six playbooks**, each with a fixed tool sequence:

| You ask | It runs |
|---|---|
| explain this project / onboarding docs | `get_project_map` + `analyze_project` + read entry point & 2–3 highest-degree components |
| find the X flow | `trace_flow(from, to)` → then only the named files |
| visualize state management | `search_graph` per context → who `uses` each → ranked Mermaid |
| estimate complexity | `get_impact` → S (<5 dependents) / M (5–15) / L (>15 or 3+ routes) |
| break into tickets | complexity first, then tasks in dependency order: schema → API → state → UI → wiring → tests |
| why is X broken | graph **and** git: dependency chain → `graph_timeline`/`graph_diff` → `git log -S` → causal chain |

**Worth knowing about root-cause mode.** It treats a *missing* edge as evidence:

> Note any edge you'd **expect** that is missing — a missing `uses`/`calls` edge is often
> the symptom made visible.

And it reports as a chain — *symptom → changed dependency → the commit → why* — not a file
list. If it can't pin a cause to a commit, it says what it ruled out instead of guessing.

**Where it refuses to overreach.** For performance and security it opens by admitting the
graph doesn't detect either. It uses the graph to narrow to hot paths, reads those files,
and reports only what it verified, with `file:line`.

---

## 2. codegraph-refactor — the advisor that won't invent work

**What it changes.** A linter finds 40 things and ranks them by how easy they were to
detect. This ranks by value-to-risk, because it checks the blast radius of every candidate
*before* recommending it:

> a 200-line component with 1 dependent is a quick win; a duplicate shared by 6 routes is
> a project.

Same detection, opposite priority — and only the graph can tell them apart.

**The pipeline:**

```
1. index_project                       refresh — "stale advice is worse than no advice"
2. analyze_project + get_project_map   the evidence
3. get_impact on EVERY candidate       blast radius sets both risk and priority
4. read the source of the top 3–5      before finalizing
```

Step 4 exists because the graph tells you *where*, only the code tells you *whether the
split is natural*. The skill forbids recommending a split boundary it hasn't looked at.

**Evidence → suggestion**, so nothing is a vibe:

| Suggestion | What justifies it |
|---|---|
| split component | `loc > 150` + many outgoing `renders`/`calls` edges |
| merge duplicates | same JSX-shape fingerprint under different names |
| extract shared logic | same hook/API called from 3+ components in different folders |
| fix architecture | circular imports, cross-feature-boundary imports |
| remove dead code | possibly-dead list — *plus* a mandatory grep-to-verify caveat |
| reduce bundle | heavy subtree under one route — framed as *measure this with your bundler*, since the graph has no byte sizes |

**Three guardrails you can rely on:**

- **It never applies changes.** Plan only; you execute.
- **Max 6 suggestions**, or the important ones drown.
- **It will tell you there's nothing to do**: *"If `analyze_project` returns a clean bill
  (score ≥ 90, no findings), say so and stop — do not fabricate busywork refactors."*

---

## 3. codegraph-rosetta — the framework translator

**What it changes.** You know NestJS. The repo is Go. Generic Go tutorials don't help,
because your problem isn't Go — it's *this repo*. Rosetta explains this repo's real files
in the vocabulary you already have.

**How it works, from your side:**

1. It figures out both frameworks — *home* from your words, *target* **detected from marker
   files, never asked** (`manage.py` → Django, `go.mod` → Go, `Cargo.toml` + axum → Rust, …).
2. It loads exactly one reference file for the target — 4.5 KB, not the whole 48 KB library.
3. It tells you honestly what's verified. If Contextifly has no parser for the target:
   *"no compiler provider for Django yet — this walkthrough is from reading the code
   directly, not from the verified graph."*
4. It delivers four things: the map in your framework's terms; the 3–5 mental-model shifts
   that actually apply *here*, each with a `file:line`; one real request narrated end to end
   naming every stage in **both** frameworks; and a side-by-side cheat sheet for the five
   most common tasks (add endpoint, add model field, migration, background job, test).

**Two rules that keep it from being glib:**

- **Translation ≠ equivalence.** Django has no DI container, Go has no decorators. It says
  *"no equivalent — here's the idiom that fills the role"* instead of forcing a false mapping.
- **It matches your repo's dialect, not the textbook.** If this Django project uses fat
  models instead of a service layer, that's what it translates — and it says so.

For a one-off ("what's the equivalent of a guard here?") it answers from the table, shows
the closest real example in your repo, and stops. No onboarding dump.

---

## 4. codegraph-whatif — pre-merge blast radius

**What it changes.** The incident this exists for:

> We changed one thing. We tested that change end to end. The change activated a legacy
> code path nobody had touched in a year, that path returned a stale shape, the API sent
> null, and the frontend crashed.

Testing can't catch that, because the failure is in **the code you didn't change and
therefore never thought to test**. This skill's whole premise:

> You already know what you changed. Its job is to tell you what changed *around* you.

**Which tool for which question:**

| The question | Tool |
|---|---|
| "is this PR safe to merge?" | `simulate_pr` |
| "I'm about to change `OrdersService` — who breaks?" | `impact_across_apps` |
| "what if I delete / split / lazy-load this?" | `what_if` |
| "what depends on this?" (one repo, no verdict) | `get_impact` |

**`simulate_pr`** indexes the code **before and after** the change — in a throwaway git
worktree, so your checkout is never touched — and subtracts the two graphs. That's the
point: a text diff shows which *lines* changed; the graph delta shows what those lines are
now **connected to**. An added edge is a path that just went live. A removed edge is a flow
that just broke. Neither is visible in a diff.

You read its output in order of danger:

1. **🕰 Reactivated legacy paths** — a new edge into code the PR doesn't touch and nobody
   has committed to in months. Your incident, caught before merge.
2. **💥 Flows that break** — a caller left pointing at something deleted.
3. **⚠️ Contract risk** — things you changed that untouched consumers still call, with
   unguarded dereferences flagged at the call site.
4. **Cross-app impact** — see below.
5. **Test scope** — your regression checklist.

**`impact_across_apps`** answers the fleet question. Backend and Flutter app share zero
symbols — no AST link exists. They share a URL, so endpoints are the join. Configure your
apps once in `contextifly.workspace.json` (the tool scaffolds it on first run) and you get,
per app: affected endpoints, exact call sites, the screens behind them — and proof of which
apps are **not** affected.

**Every app is analysed at two versions**, and this is the part that saves you:

```
🚨 master — what ships to users
   GET /orders/:id → OrderTrackingScreen (lib/order_tracking.dart:6)

✅ feature/upgrade_ordermodel — your checkout
   calls none of these endpoints

⚠️ Breaks on master, not on feature/upgrade_ordermodel. Your branch has already
   adapted; what ships to users has not. Merging the backend change before that
   branch lands breaks production, and your local testing will not show it.
```

The reverse is flagged too: a dependency new on your branch and absent from master means
the two changes have to ship together, or in a specific order.

**Mobile is escalated automatically.** A breaking endpoint change on a Flutter app hits
users on already-installed builds who cannot be hotfixed. Web you redeploy; mobile you wait
for the old versions to drain.

**What it can't see:** feature flags, runtime branches, URLs built at runtime. It narrows
where to look. It doesn't replace looking.

---

# Part B — architecture

## A skill is not code

It never executes. It is a directory containing one markdown file:

```
skills/codegraph-copilot/
└── SKILL.md            ← YAML frontmatter + markdown body
```

```yaml
---
name: codegraph-copilot
description: Developer copilot over the Contextifly code knowledge graph. Use when the
  user asks to explain this project, generate onboarding docs, find flows…
---

# body: instructions the model follows in place of its default approach
```

Skills, tools and MCP are three different things and it's worth being precise:

| | What it is | Who executes it |
|---|---|---|
| **MCP server** | a process exposing tools over stdio | Node, locally |
| **Tool** | a function with a JSON schema (`simulate_pr`, `trace_flow`) | the MCP server |
| **Skill** | markdown instructions on how to use those tools | the model |

A skill can't compute anything. Its entire power is deciding *which tool runs, in what
order, and what may be claimed about the result.*

## Two-stage loading, and why it matters

| Stage | Loaded | Cost | Role |
|---|---|---|---|
| Always in context | `description` only | 316–500 B per skill | the **routing surface** |
| On invocation | the full body | 3.5–6.4 KB | the **playbook** |

Measured:

| Skill | description | SKILL.md | extra |
|---|---|---|---|
| codegraph-copilot | 366 B | 5.5 KB | — |
| codegraph-refactor | 316 B | 3.5 KB | — |
| codegraph-rosetta | 495 B | 4.7 KB | 48 KB of references |
| codegraph-whatif | 500 B | 6.4 KB | — |

All four cost **~1.7 KB of permanent context**. Claude Code budgets roughly 1% of the
window for the skill listing, so the descriptions must earn their bytes. The 20 KB of
actual instruction only materializes when a skill fires.

**Consequence for authors:** the `description` is the highest-leverage line in the file.
It is the *only* thing the model sees when deciding whether to invoke. Write it as a
matching surface — the literal phrasings a developer types — not as a summary. Compare:

```
✗ "Advanced graph-powered analysis capabilities for modern codebases."
✓ "Use when the user asks what a change or pull request will break, whether a PR is safe
   to merge, how a backend change affects the customer app / delivery app / web…"
```

## Progressive disclosure — the rosetta pattern

Rosetta is the only skill with a third stage:

```
codegraph-rosetta/
├── SKILL.md                4.7 KB   always loaded when invoked
└── references/             48 KB    exactly ONE file loaded, ever
    ├── django.md   spring-boot.md   fastapi.md
    └── flask.md    go.md            rust.md
```

The body detects the target framework from marker files, then instructs: *"Load exactly one
reference file… Do not load the others."* A Django repo costs 4.5 KB, not 48 KB.

This is the pattern to copy whenever a skill's knowledge grows past a few KB: **a decision
tree over its own knowledge base**, not one enormous prompt.

## The five invariants

Every skill body ends in a `Rules` section, and every one of them is about restraint.
These five hold across all four:

1. **Cite or don't claim.** Every structural statement carries a graph node/edge or a
   `file:line` that was actually read.
2. **Code beats graph.** If they disagree, trust the code and report the discrepancy — the
   graph is derived data and can be stale or wrong.
3. **Re-index when stale.** `loadIndex()` refreshes automatically, but a skill that sees a
   staleness warning must act on it. Stale advice is worse than none.
4. **State the ceiling once.** Say plainly what the analysis cannot see — then stop
   hedging. A caveat on every line is noise; one honest paragraph is information.
5. **Don't manufacture work.** Clean bill of health → say so and stop.

Two more are specific but load-bearing:

6. **Never launder a confidence score.** A 60% cross-repo endpoint match is reported as
   60%, with the reason and the fix (`set basePath`).
7. **Bounded reading.** After a graph answer, read *only* the files the answer named. This
   is what protects the token savings the graph just produced.

## How the skills compose

```
                    index_project  (every skill starts here)
                          │
      ┌──────────────┬────┴─────┬───────────────────┐
   copilot        refactor    rosetta            whatif
  "what is it"  "what to fix" "translate it"  "what will break"
      │              │            │                 │
  trace_flow    analyze_project  1 reference    simulate_pr
  project_map   get_impact       + graph if     impact_across_apps
  get_impact    (per candidate)    covered      (+ get_impact)
      └──────────────┴────────────┴─────────────────┘
                          │
              same graph, same citations
```

They overlap deliberately: `get_impact` appears in three of them, at different altitudes —
copilot uses it to size an estimate, refactor to rank a suggestion, whatif to seed a
fleet-wide blast radius. The tool is neutral; the skill supplies the intent.

**Routing when several could match:** the descriptions are written to be disjoint on
phrasing. "What breaks if…" → whatif. "What should I clean up" → refactor. "How does X
work" → copilot. "What's the equivalent of X" → rosetta. Overlap in a new skill's
description is the main way skill routing degrades — check for it before shipping one.

## Adding a fifth skill

1. `mkdir packages/mcp-server/skills/<name>/` and write `SKILL.md`.
2. **Frontmatter:** `name` matches the directory. `description` names the trigger phrasings
   and, in the last sentence, the stacks it applies to. Check it doesn't collide with the
   existing four.
3. **Body:** a routing table (when several tools could serve), the mandated tool sequence,
   the output shape, then a `Rules` section carrying invariants 1–7 as they apply.
4. **Put big knowledge in `references/`** and load exactly one file, rosetta-style.
5. Update: `.claude-plugin/marketplace.json` (the plugin description), the bundled-skills
   list in [README.md](README.md), and this file.
6. Rebuild and reinstall the plugin — the cache is a copy, so a new skill does not appear
   until you do.

**The test of a good skill body:** would a competent developer, handed only this file and
the tool list, do the job the same way? If it reads like marketing, it's not a skill. If it
reads like a runbook, it is.

## Why this shape at all

The MCP tools already work without any skill. A skill exists to fix the three ways an AI
degrades a good tool:

- **Wrong first move** — grepping when one `trace_flow` would answer it. (Fixed by mandated
  sequences.)
- **Unbounded reading** — "while I'm here, let me look at 30 more files." (Fixed by
  bounded reading.)
- **Confident overreach** — reporting a heuristic as a fact, or inventing refactors to look
  useful. (Fixed by the citation and honesty rules.)

That maps directly onto the governance rule in [ARCHITECTURE.md](ARCHITECTURE.md): *the
compiler discovers architecture; the AI explains it.* A skill is where that division is
enforced in practice.
