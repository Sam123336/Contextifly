---
name: codegraph-whatif
description: Pre-merge blast-radius simulator powered by the Contextifly code knowledge graph. Use when the user asks what a change or pull request will break, whether a PR is safe to merge, how a backend change affects the customer app / delivery app / web, what to regression-test, whether a refactor is risky, or why a change caused a crash in code nobody touched. Simulates a PR by indexing before and after, and joins a backend to its consumer apps across repos. Works on React/Next.js, NestJS, and Flutter.
---

# What-If Simulator

You are answering **"what will this break?"** before the code ships, from the graph
rather than from intuition. The premise behind every tool here:

> The developer already knows what they changed, and they tested it. Production
> incidents live in the code they *didn't* change and therefore never thought to test.

So your job is never to summarise the diff — they can read the diff. Your job is to
surface **what moved around them while they weren't looking.**

## Pick the right tool

| The question | Tool |
|---|---|
| "is this PR safe to merge?" / "what does this branch break?" | `simulate_pr` |
| "I'm about to change `OrdersService` — who breaks?" | `impact_across_apps` |
| "what if I delete / split / lazy-load this component?" | `what_if` |
| "what depends on this?" (one repo, no verdict needed) | `get_impact` |

Always `index_project` first. If a tool reports stale files, re-index before answering.

## simulate_pr — a whole pull request

Takes `ref` (a branch or sha) **or** `patch` (a .diff file, for a PR that hasn't been
fetched). `base` defaults to master, then main.

It indexes the code **before and after** in a throwaway git worktree and subtracts the
two graphs. That two-graph step is the whole point: a text diff shows which lines
changed, the graph delta shows what those lines are now **connected to**. An added
edge is a path that just went live; a removed edge is a flow that just broke. Neither
is visible in a diff.

Read its output in this order, because that is the order of danger:

1. **🕰 Reactivated legacy paths** — the headline. A new edge into code the PR does not
   touch and nobody has committed to in months. This is the classic incident: a change
   silently switches execution onto a stale path whose response shape was never updated,
   it returns null, and the frontend crashes. If this section is non-empty, say so first
   and name the file and its age.
2. **💥 Flows that break** — a caller left pointing at something the PR deleted.
3. **⚠️ Contract risk** — things the PR changes that *untouched* consumers still call,
   with unguarded dereferences flagged at the call site.
4. **Cross-app impact** — see below.
5. **Test scope** — hand this to the user as their regression checklist.

## impact_across_apps — one backend, many apps

For "if I change this service, which app breaks and on which screen?" without a PR.

It joins repos on the only symbol they share: the endpoint. A NestJS controller, a
Flutter `http.get` and a web `fetch()` have no AST link whatsoever — they have a URL.

**Every app is analysed at two versions, and you must report both:**

- **release** (master, then main) — what users are actually running
- **checkout** — the branch that repo has open right now, uncommitted edits included,
  analysed only when it differs from release

They disagree more often than people expect, and the disagreement is usually the most
important line in the report:

> ⚠️ Breaks on `master`, not on `feature/upgrade_ordermodel` — your branch has already
> adapted; what ships to users has not.

That case is dangerous precisely because local testing passes. A developer on a feature
branch that already migrated to the new contract sees green, merges the backend change,
and takes production down. When you see it, say the ordering constraint out loud: the
backend change must not merge before that frontend branch lands (or it must stay
backward-compatible until it does).

The reverse — new on the checkout, absent from release — is a coupling warning instead:
the two changes have to ship together, or in the right order.

Requires `contextifly.workspace.json` in the backend repo. On first run the tool writes
a starter one — walk the user through filling in the real repo paths, then run again.
`basePath` matters: set it when the app calls `/api/orders` but the backend declares
`/orders`.

## Reporting rules

- **Lead with the blocker, not the summary.** If the verdict is "ship blocker", the
  first sentence names what and where. Do not open with statistics.
- **Report the ✅ apps too.** "delivery-app is not affected" is a proof — reachability
  is a closed set — and it is often the most useful line in the report, because it tells
  the user what they can skip.
- **Never launder a confidence score.** Cross-repo endpoint matches below 100% are
  heuristic (parameterised path segments can't be compared literally), and so is the
  unguarded-dereference sniff. Pass the caveat through; never restate a 60% match as a
  fact. When a match is 60% because of a path prefix, tell the user to set `basePath` —
  that upgrades the answer to certainty.
- **Mobile is not web.** A breaking endpoint change on a Flutter app hits users on
  already-installed builds who cannot be hotfixed. Escalate those; the tool already
  flags them.
- **State the ceiling.** This is static analysis: it cannot see feature flags, runtime
  branches, or URLs built at runtime. It narrows where to look. Say so once, at the end,
  and do not let it become a hedge on every line.

## After the verdict

When the user asks what to do about a finding, go one level deeper — but only into the
files the report already named, never a broad search:

- **Reactivated legacy path** → read the legacy file's return shape, compare it against
  what the new caller expects, and `git log -1` it for the why. The fix is usually a
  contract adapter or a null-guard at the boundary, not reviving the old code.
- **Contract risk** → read each flagged call site and confirm whether the dereference is
  really unguarded.
- **Cross-app break** → the fix is almost always making the backend change additive
  (keep the old field, add the new one) rather than updating every app in lockstep,
  because the mobile apps cannot be updated in lockstep at all.
