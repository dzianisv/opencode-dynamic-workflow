# opencode-drawers — Prior-Art Analysis & Design Rationale

> **SUPERSEDED as a plan** by `2026-06-06-opencode-drawers.md` (canonical
> rolling-wave plan). This document remains the analysis record: steal/avoid
> tables, file:line references into `.references/`, and design rationale.

**Date:** 2026-06-06
**Target:** A set of focused OpenCode plugins culminating in a port of Claude Code's
dynamic Workflows (`WORKFLOWS_HL_SPEC.md`). Background agents are Layer 1 (the
`agent()` substrate); the deterministic workflow engine is Layer 2.

**Prior art analyzed** (clones in `.references/`, git-ignored):
- `better-opencode-async-agents` v0.10.0 — correct architectural spine, weak execution
- `oh-my-opencode` v4.7.5 — two gems (ConcurrencyManager, factory-DI), one cautionary tale (3,087-line god-manager + 24-file prompt-gate workaround)
- `opencode` upstream source — ground truth for plugin API

---

## 1. What the prior art settles (decisions inherited, not reinvented)

### The correct OpenCode-native spine (from better-async-agents)
- **Background unit = child session**: `client.session.create({ body: { parentID, title } })` then `client.session.promptAsync(...)` fire-and-forget. The session *is* the durable task; persist only metadata keyed by sessionID.
- **`noReply: true` prompts** for context injection without triggering a turn.
- **Recursion guard**: per-launch `tools` override disabling our spawn tools in children, plus a depth counter.
- **Synthetic hint part** (`synthetic: true` text part) for model-only instructions invisible to the user.
- Collision-free git-style short IDs for task ergonomics.

### Completion detection (from oh-my-opencode, corrected)
- **Event-primary**: `session.idle` gated by (a) min-idle grace (~5s), (b) output validation (≥1 non-empty assistant/tool message), (c) incomplete-todos veto.
- **`tryCompleteTask` mutex**: synchronous `status !== "running" → return` check-and-flip **before any await**. JS single-threadedness is the lock. All completion paths (idle event, safety poll, timeout, session.error) funnel through it; first wins.
- **Safety-net polling only**: sparse (≥5s), re-entrancy-guarded, `unref()`d. NOT the engine. `client.session.status()` treated as best-effort (it is guarded-private in OMO for a reason).
- Stale-task interruption with the "do NOT create a replacement task" worded error (prompt-injection defense against retry storms).

### Concurrency (lift nearly verbatim)
- OMO's `ConcurrencyManager` (`.references/oh-my-opencode/src/features/background-agent/concurrency.ts`, 175 lines): model > provider > default limit resolution, per-key FIFO queue, **slot-handoff on release** (no thundering herd), settled-flag against double-resolution. Clean-room reimplement with tests; the design is the steal, line-for-line copying is not (SUL-1.0 license).

### Notification delivery (the big simplification vs OMO)
- **Passive injection via `chat.message` hook** (OMO's "Channel B"): flush pending completion notices into the parent's next user message. ~5 lines, zero race surface.
- **TUI toast** on completion (typed `client.tui` surface only; no `as any`).
- **NO active parent-wake in v1.** OMO's synthetic-prompt parent-wake costs 24+ files of deferral/dedup/reservation machinery fighting host crashes (`@parcel/watcher` TSFN, SIGABRT, issue #4120) because OpenCode doesn't serialize concurrent session prompts. The Workflow engine doesn't need it (see §3) and interactive background tasks degrade gracefully to passive + toast. Active wake is a later opt-in if the product demands it.

### What we explicitly avoid
| Anti-pattern | Source | Why |
|---|---|---|
| 100ms global polling driving spinners | better-async | CPU/IPC hog; events are primary |
| Full-file read-modify-write persistence, no locking | better-async | corruption under concurrent writers |
| `(client as any).tui` / `session.fork` / private SDK | both | breaks on SDK churn; typed surface only |
| Task lifetime coupled to TUI events (ESC wipes tasks) | better-async | durable work must survive navigation |
| 3,087-line god-manager, 30 mutable Maps | OMO | split launch/complete/notify/concurrency into modules with interfaces from day one |
| Two overlapping tool families with separate completion heuristics | OMO | one tool family, one resume path |
| HTTP server + React dashboard inside the plugin | better-async | scope creep; presentation stays out of the engine |
| Char-based "token" budgeting (200k chars ≈ 50k tokens) | better-async | token units or honest char units, not a lie |
| Trusting in-repo AGENTS.md docs | OMO | their docs describe abandoned algorithms; code is truth |

---

## 2. Repository structure

Bun workspaces monorepo. Each plugin independently publishable to npm; shared engine
is a library package (plugins must be self-contained — OpenCode installs each npm
plugin independently, so cross-plugin runtime coupling is forbidden).

```
opencode-drawers/
  package.json                 # workspaces root, bun
  tsconfig.base.json
  packages/
    core/                      # @drawers/core — shared engine (library, not a plugin)
      src/
        session-runner.ts      # launch / complete / cancel / resume on child sessions
        concurrency.ts         # ConcurrencyManager (clean-room from OMO design)
        completion.ts          # tryCompleteTask mutex + idle gate + safety poll
        persistence.ts         # atomic per-task JSON (tmp+rename), write queue
        notify.ts              # pending-notice queue + chat.message flusher + toast
        ids.ts                 # short-ID generation
        types.ts
    background-agents/         # plugin: opencode-drawer-agents
      src/index.ts             # Plugin fn → tools + hooks, factory-DI bootstrap
      src/tools/               # task / output / cancel / list
    workflows/                 # plugin: opencode-drawer-workflows
      src/index.ts
      src/runtime/             # script parse, sandboxed eval, primitives
      src/journal.ts           # resume journaling
      src/tools/               # workflow tool (+ workflows list/stop)
  docs/plans/
  .references/                 # git-ignored prior art
```

Conventions (from the local `opencode-plugin-dev` skill — gate before coding):
- Refresh `references/hooks.md` / `events.md` via `scripts/extract-plugin-api.ts` before any hook code.
- One async function export returning `Hooks`; classes never exported from plugin entry (loader calls all exports as functions — better-async hit this).
- All diagnostics via `client.app.log({ body: {...} })`; `console.log` corrupts the TUI.
- Subagent tracking: `session.created` → `event.properties.info.parentID` Set (the `isSubagent` field on `session.idle` is undefined).
- Factory dependency injection throughout (OMO's `PluginModuleDeps` pattern) — every manager/tool/hook takes overridable deps. This is what makes their 876-test suite feasible; adopt from commit one.
- `bun test`, Biome, typecheck in CI.

---

## 3. Layer 1 — `opencode-drawer-agents`

Claude Code-shaped background agent tools.

### Tool surface (one family, minimal)
| Tool | Args | Behavior |
|---|---|---|
| `bg_task` | `description, prompt, agent, run_in_background?=true, task_id?` (resume), `fork?` | Launch (or resume via `task_id`). Returns short ID + "wait for notification" steering. Sync mode blocks via in-process promise, not message polling. |
| `bg_output` | `task_id, block?, timeout?, full_session?, since_message_id?` | Pull results; incremental fetch; records consumption. |
| `bg_cancel` | `task_id?, all?` | Abort session(s); "Continue Instructions" pointing at resume. |
| `bg_list` | `status?` | Children of current session, markdown table. |

### Mechanics
- Launch: reserve depth → create record (`pending`) → per-key concurrency queue →
  `session.create` (re-check cancel around the await) → `promptAsync` with tool
  overrides disabling `bg_*` in the child.
- Completion: idle gate → `tryCompleteTask` → release slot before async ops →
  enqueue passive notification + toast.
- Persistence: per-task JSON file, atomic tmp+rename, serialized write queue.
  Persist EVERYTHING needed to notify/resume after restart (better-async drops
  `parentSessionID` context fields and breaks resume — don't).
- Context fork (`fork: true`): reimplement better-async's *concept* against the
  current message schema — compaction-boundary slice, graduated recency-tiered
  tool-result truncation, head+tail preservation for error outputs, never-truncate
  list for Q&A tools. Their implementation has schema drift (`tool_result` vs
  `tool` part types) and O(n²) trimming; ours validates part types against the
  generated refs first.

### Definition of done
- e2e against a real `opencode` headless run: launch → idle → notification on next
  user message → output retrieval → resume → cancel.
- Restart survival: kill plugin process mid-task, reload, `bg_list` shows the task,
  `bg_output` recovers the result from the session store.

---

## 4. Layer 2 — `opencode-drawer-workflows`

Port of the `WORKFLOWS_HL_SPEC.md` contract. The spec is the requirements doc; this
section maps each contract item to a mechanism.

### Tool surface
- `workflow({ script?, scriptPath?, name?, args?, resumeFromRunId? })` — returns
  immediately with runId + persisted script path; completion arrives as a passive
  notification carrying the script's return value (or pointer to it on disk if large).
- `workflow_status({ runId? })` — progress tree snapshot (the `/workflows` analog,
  until a TUI pane exists).
- `workflow_stop({ runId })`.

### Script runtime
- **Meta extraction**: parse `export const meta = {...}` as a pure literal (AST via
  Bun's transpiler or a strict JSON5-ish parser on the object literal). Reject
  computed values. Strip the export, wrap the body in
  `async (agent, pipeline, parallel, phase, log, args, budget, workflow) => {...}`.
- **Execution**: in-process `new Function` with an explicit global allowlist.
  Shadow `Date.now`, `Math.random`, argless `Date` with throwing stubs
  (determinism, not security — the script author is the same model that already
  holds bash; the threat model is resume-cache poisoning, not sandbox escape).
  No `require`/`import`/`process`/`fs` bindings provided.
- **Primitives**:
  - `agent(prompt, opts)` → calls core session-runner **in-process** (this is why
    no parent-wake is needed: the workflow runner awaits its own promises).
    `opts.agentType` maps to OpenCode agent names; `opts.model` override;
    `isolation: 'worktree'` via `git worktree add` + cleanup-if-unchanged.
  - `schema` support: register one global `structured_output` tool in the plugin;
    per-session expected schema held in manager state; child is steered via
    injected instruction + tool override allowing it; validation at tool-execute,
    mismatch returns an error so the model retries. (The spec's "validation at the
    tool-call layer" reproduced with OpenCode's own tool plumbing.)
  - `pipeline(items, ...stages)` — no barrier, per-item chains, stage throws → item
    `null`; `parallel(thunks)` — barrier, thunk throws → `null`, never rejects.
  - Caps: `min(16, cores−2)` concurrent (delegated to ConcurrencyManager with a
    workflow-scoped key), 1,000 lifetime agents, 4,096 items per call.
  - `phase()`/`log()` → progress journal + toasts.
  - `workflow()` sub-workflows: one level, shared counters/abort/budget.
- **Budget**: `budget.spent()` from token usage on session messages (assistant
  message metadata carries usage in the SDK — **needs verification against
  generated refs**; fallback: estimate from char counts, honestly labeled).
- **Journal & resume**: append-only JSONL per run — `(callIndex, promptHash(prompt+opts), result)`.
  Resume replays the script; longest unchanged prefix returns cached results;
  first divergence runs live. Same mechanism the spec describes; the banned
  nondeterministic builtins make it sound.

### Failure semantics (spec §9)
Degrade-don't-detonate: skipped/dead agent → `null`; budget exhaustion and agent
cap → throw; 4096-item → throw at call time. `.filter(Boolean)` documented as idiom.

---

## 5. Phasing

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **0 — Scaffold** | Workspaces, tsconfig, Biome, bun test, CI, `extract-plugin-api` refresh, `@drawers/core` types | `bun test` green on a hello-world plugin loaded by a local opencode |
| **1 — Core engine** | session-runner, ConcurrencyManager, completion mutex + idle gate + safety poll, atomic persistence, notify queue | unit tests incl. race tests (event vs poll vs cancel), restart-recovery test |
| **2 — Agents plugin** | `bg_*` tools, passive notification + toast, recursion guard, fork pipeline | e2e definition-of-done from §3 |
| **3 — Workflow runtime** | meta parser, sandboxed eval, `agent/pipeline/parallel/phase/log/args`, caps | spec-conformance test suite scripted from `WORKFLOWS_HL_SPEC.md` examples |
| **4 — Workflow plugin** | `workflow*` tools, journal+resume, budget, sub-workflows, structured output | resume cache-hit test (same script+args → 100% cached); review-changes canonical workflow runs end-to-end |
| **5 — Ship** | docs, npm publish (`opencode-drawer-agents`, `opencode-drawer-workflows`), saved workflows dir (`.opencode/workflows/`) | installable via `"plugin": [...]` in a clean project |

Phase 1+2 are independently shippable value (the background-agents plugin alone
matches the best of the ecosystem). Phases 3-4 are the differentiator — nothing in
the OpenCode ecosystem has deterministic resume-able orchestration scripts.

---

## 6. Open decisions (defaults declared; override anytime)

1. **Naming** — default: npm `opencode-drawer-agents` / `opencode-drawer-workflows`,
   tool prefixes `bg_` / `workflow`. Pure branding; zero structural cost to change
   before first publish.
2. **License** — default MIT (personal repo, ecosystem norm; OMO's SUL-1.0 is why we
   clean-room their designs rather than copy).
3. **Active parent-wake** — deferred entirely. Revisit only if passive notification
   proves insufficient in real use.
4. **Minimum supported opencode version** — pin to current (`@opencode-ai/plugin`
   ^1.x at scaffold time) and support narrow. OMO's worst complexity is
   cross-version idle-event normalization; we refuse that tax.
5. **Budget token accounting** — needs a spike against the SDK message-usage surface
   in Phase 3; plan assumes available, fallback is labeled estimation.

## 7. Risks

- **Host doesn't serialize concurrent session prompts** — the root cause of OMO's
  worst code. Mitigated by: workflows await in-process (never prompt-inject the
  parent), notifications are passive. Residual risk only if active wake is added.
- **`session.idle` reliability across opencode versions** — mitigated by narrow
  version pin + the sparse safety poll + stale timeout.
- **SDK churn on typed surfaces** (`tui`, `session.status`) — mitigated by the
  extract-plugin-api gate at every phase start and refusing untyped calls.
- **Workflow scripts are model-authored code running in-process** — accepted: same
  trust level as the bash tool the model already holds. Shadowed globals are for
  determinism, not containment.
