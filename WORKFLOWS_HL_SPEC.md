# Dynamic Workflows — High-Level Specification

**Perspective:** This document describes Claude Code's dynamic workflow feature from the
agent's point of view — what the orchestrating model sees, what contract it programs
against, and what guarantees the harness provides. It is a behavioral spec, not an
implementation guide.

---

## 1. Purpose

A workflow is a **deterministic orchestration script** that the main agent authors and
hands to the harness for execution. It inverts the usual control relationship:

- In normal operation, the *model* drives control flow turn by turn (decide → call tool
  → observe → decide again).
- In a workflow, control flow is **encoded once as JavaScript** and executed by the
  harness. The model's judgment is embedded in the prompts it writes for subagents;
  loops, fan-out, barriers, and conditionals run mechanically, without burning main-loop
  context or risking drift between iterations.

The feature exists for three structural reasons:

1. **Comprehensiveness** — decompose a task and cover the pieces in parallel.
2. **Confidence** — run independent perspectives and adversarial checks before
   committing to a conclusion.
3. **Scale** — take on work one context window can't hold (migrations, audits, broad
   sweeps) by distributing reading/writing across many agent contexts and keeping only
   conclusions in the main loop.

## 2. Invocation Model

### 2.1 Opt-in gate

Workflows can spawn dozens of agents and consume large token volumes, so they are
**explicitly opt-in**. The agent may only call the `Workflow` tool when one of:

- The user included the `ultracode` keyword (confirmed via system-reminder).
- Ultracode is toggled on for the session (standing opt-in: workflows become the
  default for every substantive task).
- The user asked for multi-agent orchestration *in their own words*.
- A skill/slash command the user invoked instructs the agent to call `Workflow`.
- The user asked to run a specific named/saved workflow.

A task that would merely *benefit* from orchestration does not qualify. Absent opt-in,
the agent either uses individual `Agent` calls or describes what a workflow could do
(with rough cost) and asks.

### 2.2 Inputs

The tool accepts one of three script sources, plus arguments:

| Field | Meaning |
|---|---|
| `script` | Inline self-contained script (the common case for ad-hoc orchestration). |
| `scriptPath` | Path to a script file on disk — used for iteration: every run persists its script under the session directory and returns the path; edit + re-invoke. |
| `name` | A predefined workflow (built-in or from `.claude/workflows/`). |
| `args` | Arbitrary JSON value exposed verbatim to the script as the global `args`. Arrays/objects are passed as real JSON values, never stringified. |
| `resumeFromRunId` | Resume a prior run (see §7). |

### 2.3 Execution lifecycle (as the agent experiences it)

1. The agent calls `Workflow`; the tool **returns immediately** with a task/run ID and
   the persisted script path.
2. The workflow runs **in the background**. The main loop is free to continue, or end
   its turn.
3. A `<task-notification>` re-invokes the agent when the workflow completes (or fails).
4. The script's `return` value becomes the result the agent reads and synthesizes from.
5. The user can watch live progress via `/workflows` (progress tree, phase groups,
   narrator lines from `log()`).

For multi-phase work (understand → design → implement → review), the intended shape is
**several workflows in sequence**, one per phase, with the agent reading each result and
deciding the next phase. The agent stays in the judgment loop; each workflow is one
well-scoped fan-out. A common refinement is the **hybrid pattern**: scout inline first
(list files, scope the diff, find the targets) to discover the work-list, then launch
the workflow to pipeline over it.

## 3. Script Contract

### 3.1 Language and environment

- Plain **JavaScript**, not TypeScript — type annotations fail to parse.
- The body runs in an async context; top-level `await` is used directly.
- Standard JS built-ins are available (`JSON`, `Math`, `Array`, …) **except**
  `Date.now()`, `Math.random()`, and argless `new Date()`, which throw — they would
  break deterministic resume (§7). Timestamps come in via `args`; randomness is
  simulated by varying prompts/labels per index.
- **No filesystem or Node.js APIs.** The script orchestrates agents; agents touch the
  world.

### 3.2 Mandatory metadata

Every script begins with a **pure-literal** `meta` export (no variables, calls,
spreads, or interpolation):

```js
export const meta = {
  name: 'review-changes',                      // required
  description: 'One-line, shown in permission dialog',  // required
  whenToUse: '...',                            // optional, shown in workflow list
  phases: [                                    // optional, matched by exact title
    { title: 'Review', detail: '...' },
    { title: 'Verify', detail: '...', model: 'haiku' },
  ],
}
```

Phase titles in `meta.phases` are matched exactly against `phase()` calls / `phase`
options to group progress display.

### 3.3 Runtime API (globals available to the script body)

| Primitive | Semantics |
|---|---|
| `agent(prompt, opts?) → Promise<any>` | Spawn a subagent. Without `schema`, resolves to its final text. With `schema` (JSON Schema), the subagent is forced through a `StructuredOutput` tool and the call resolves to the **validated object** — validation happens at the tool-call layer, so schema mismatches trigger model retries, not parse errors in the script. Resolves to `null` if the user skips the agent or it dies on a terminal error. |
| `pipeline(items, ...stages) → Promise<any[]>` | Run each item through all stages **independently, with no barrier** — item A can be in stage 3 while item B is in stage 1. Each stage callback receives `(prevResult, originalItem, index)`. A throwing stage drops that item to `null` and skips its remaining stages. **This is the default composition primitive.** |
| `parallel(thunks) → Promise<any[]>` | Run thunks concurrently with a **barrier**: awaits all before returning. A failing thunk resolves to `null`; the call itself never rejects (`.filter(Boolean)` before use). |
| `phase(title)` | Start a progress group; subsequent `agent()` calls render under it. Inside concurrent stages, the per-call `opts.phase` is preferred (global `phase()` state races). |
| `log(message)` | Narrator line shown to the user above the progress tree. |
| `args` | The invocation's `args` value, verbatim. |
| `budget` | `{ total, spent(), remaining() }` — see §6. |
| `workflow(nameOrRef, args?)` | Run another workflow inline as a sub-step (§8). |

`agent()` options: `label` (display), `phase` (progress group), `schema` (structured
output), `model` (override; default is to omit and inherit the session model),
`isolation: 'worktree'` (fresh git worktree — expensive, only for parallel file
mutation), `agentType` (use a custom subagent type from the same registry as the
`Agent` tool; composes with `schema`).

### 3.4 Subagent contract

Workflow subagents are told their final text **is the return value**, not a
human-facing message — they return raw data, not prose wrapped in pleasantries. They
can reach all session-connected MCP tools via `ToolSearch` (schemas load on demand),
with the caveat that interactively-authenticated MCP servers may be absent in
headless/cron runs.

## 4. Composition Semantics — Pipeline vs. Barrier

The spec's central design opinion: **default to `pipeline()`**; a barrier is justified
only when stage N genuinely needs cross-item context from *all* of stage N−1:

- Dedup/merge across the full result set before expensive downstream work.
- Early-exit on aggregate conditions ("0 findings → skip verification").
- Stage N's prompt references "the other findings."

Not justified by: "I need to flatten/map/filter first" (do it inside a pipeline stage),
"the stages are conceptually separate," or "it's cleaner." Barrier latency is real —
with heterogeneous agent durations, a barrier wastes the fast agents' idle time; a
pipeline's wall-clock is the slowest single-item *chain*, not the sum of
slowest-per-stage.

Smell test: `parallel → pure transform → parallel` with no cross-item dependency in the
transform is a pipeline wearing a barrier costume.

## 5. Concurrency Model and Caps

| Limit | Value | Behavior at limit |
|---|---|---|
| Concurrent `agent()` calls per workflow | `min(16, cores − 2)` | Excess calls queue; all eventually run. |
| Lifetime agent count per workflow | 1,000 | Runaway-loop backstop. |
| Items per single `pipeline()`/`parallel()` call | 4,096 | Explicit error, never silent truncation. |

A child workflow (§8) **shares** the parent's concurrency cap, agent counter, abort
signal, and token budget.

## 6. Budgeting

The user can set a hard token target for the turn (e.g. "+500k"). The script sees it as:

- `budget.total` — the target, or `null` if none set.
- `budget.spent()` — output tokens spent this turn **across the main loop and all
  workflows** (shared pool, not per-workflow).
- `budget.remaining()` — `max(0, total − spent())`, or `Infinity` with no target.

The target is a **hard ceiling**: once spent ≥ total, further `agent()` calls throw.
This enables two scaling idioms:

```js
// Dynamic: loop until the budget is nearly dry (guard on total — else Infinity loops to the 1000-agent cap)
while (budget.total && budget.remaining() > 50_000) { ... }

// Static: size the fleet up front
const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5
```

## 7. Determinism and Resume

Every run journals its `agent()` calls. Resuming with
`Workflow({ scriptPath, resumeFromRunId })` replays the script: the **longest unchanged
prefix** of `agent()` calls (matched on `(prompt, opts)`) returns cached results
instantly; the first edited/new call and everything after runs live. Same script + same
args → 100% cache hit.

This is *why* nondeterministic built-ins are banned in scripts: `Date.now()` in a prompt
would change every replayed `(prompt, opts)` pair and void the cache. Consequences:

- Stamp timestamps on results *after* the workflow returns, or pass them in via `args`.
- Resume is same-session only; the prior run must be stopped first.
- Fallback without a journal: read the `agent-<id>.jsonl` transcripts and hand-author a
  continuation script.

## 8. Sub-workflows

`workflow(nameOrRef, args?)` runs another workflow inline — a saved name or a
`{scriptPath}` — and returns its return value. The child appears as a nested group in
`/workflows`, and its agents/tokens count against the parent's caps and budget.
**Nesting is one level deep**: `workflow()` inside a child throws. Unknown names,
unreadable paths, and child syntax errors throw synchronously (catchable).

## 9. Failure Semantics

The design philosophy is **degrade, don't detonate**:

- A skipped or terminally-failed agent → `null` result (filter, don't crash).
- A throwing pipeline stage → that *item* drops to `null`; other items proceed.
- A throwing `parallel()` thunk → `null` in the result array; the call never rejects.
- Budget exhaustion and the 1000-agent cap → thrown errors (these *are* meant to stop
  the run).
- The 4096-item limit → explicit error at call time.

Corollary for script authors: `.filter(Boolean)` is part of the idiom, and any
deliberate coverage bound (top-N, sampling, no-retry) must be `log()`ed — silent
truncation reads as "covered everything."

## 10. Quality Patterns (the intended idiom library)

These are compositional shapes the orchestrator is expected to pick from and combine —
not an exhaustive menu:

| Pattern | Shape | When |
|---|---|---|
| **Adversarial verify** | N independent skeptics per finding, each prompted to *refute*; kill on majority refutation | Prevents plausible-but-wrong findings surviving |
| **Perspective-diverse verify** | Verifiers get distinct lenses (correctness / security / repro) instead of N identical refuters | A finding can fail in more than one way |
| **Judge panel** | N independent attempts from different angles → parallel judges score → synthesize from winner, graft best ideas from runners-up | Wide solution spaces; beats one-attempt-iterated |
| **Loop-until-dry** | Keep spawning finders until K consecutive rounds surface nothing new; dedup against *all seen* (not just confirmed) or it never converges | Unknown-size discovery (bugs, edge cases) |
| **Multi-modal sweep** | Parallel agents, each searching a *different way* (by-container, by-content, by-entity, by-time) | One search angle won't find everything |
| **Completeness critic** | Final agent asks "what's missing?"; its findings seed the next round | Closing coverage gaps |
| **Loop-until-budget** | Discovery loop bounded by `budget.remaining()` | User priced the depth explicitly |

Effort scales with the ask: "find any bugs" → few finders, single-vote verify;
"thoroughly audit" → large finder pool, 3–5-vote adversarial pass, synthesis stage.

## 11. Ultracode Mode

When ultracode is on, the opt-in becomes **standing policy**: author and run a workflow
for every substantive task by default, optimizing for the most exhaustive correct
answer with token cost explicitly not a constraint. Multi-phase work becomes several
sequential workflows with the main agent synthesizing between them. Solo execution
remains correct only for conversational turns, trivial mechanical edits — or cases
where orchestration is a category error (e.g. the source of truth lives only in the
main agent's context).

## 12. Boundaries and Non-Goals

- **Not a replacement for `Agent`**: single independent tasks, or work needing the main
  conversation's live context, still go through direct agent dispatch.
- **Not model-driven control flow**: the value proposition is that loops and fan-out are
  deterministic. If the next step genuinely depends on judgment over intermediate
  results, end the workflow and decide in the main loop.
- **Not a sandbox for computation**: no filesystem, no network, no Node — the script is
  pure orchestration glue.
- **Not free**: worktree isolation costs ~200–500 ms + disk per agent; barriers cost
  idle wall-clock; every agent costs tokens from a shared pool.
