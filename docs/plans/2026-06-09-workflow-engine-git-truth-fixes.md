# Workflow Engine Git-Truth & Checkpoint Fidelity — Implementation Plan

> **For implementers:** Use ring:executing-plans (rolling wave: implement the
> detailed phase → user checkpoint → detail the next phase → implement → repeat),
> or ring:running-dev-cycle for the full subagent-orchestrated workflow.
> This document is the living source of truth — task elaboration for later
> phases is written back into it during execution.

**Goal:** Make the workflow engine's checkpoint commits faithful to the working tree and make `workflow_status` / result payloads report git truth instead of agent self-report, across the seven issues recorded in `ISSUES.md`.

**Architecture:** The engine already owns a privileged git checkpointer (`git-checkpoint.ts`) that commits each live agent's edits, but (a) its staging loop silently drops already-staged deletions, and (b) the git truth it produces (`sha`, `paths`) is written only to the run feed and never reconciled into the `RunRecord` or any operator-facing surface — so results are derived entirely from what agents *claim*. This plan first repairs checkpoint fidelity (the data those surfaces will read), then threads engine-computed git truth through `RunRecord` → `workflow_status`, then isolates the parallel-mode `verifyDiff` race, then resolves abandoned-run checkpoint residue.

**Tech Stack:** TypeScript, Bun (`bun test`, BunShell tagged-template `$`), opencode plugin SDK, Biome (lint), `tsc` (typecheck). Git plumbing via fenced `shell.cwd(dir).nothrow()...quiet()`.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Checkpoints faithfully capture staged deletions; a post-checkpoint restart never resurrects deleted files | 1.1 | Detailed |
| 2 | `workflow_status` and results report engine-computed git truth (files changed, checkpoint commits, mode flips) + ignored-path diagnostics | 2.1, 2.2, 2.3, 2.4 | Detailed |
| 3 | `verifyDiff` evaluates each agent against its own isolated changes; parallel-mode false negatives and the default-mode false positive are gone | 3.1, 3.2 | Epic-level |
| 4 | Abandoned/failed runs no longer leave permanent checkpoint residue on the working branch | 4.1 | Detailed |

**Issue → Phase map** (from `ISSUES.md`): Issue 3 → Phase 1. Issues 4, 5, 7, and the `filesChanged` half of Issue 6 → Phase 2. Issue 2 → Phase 3. Issue 1 → Phase 4. The structural half of Issue 6 (isolated agents cannot see git-ignored untracked files) is a product decision, not a code default — addressed as the diagnostic in Epic 2.4, with the deeper "shared scratch artifact" question flagged for the user, not silently defaulted.

**Root-cause corrections baked into this plan** (the raw notes in `ISSUES.md` mis-attributed two causes; both were re-investigated and one was reproduced empirically):
- **Issue 3 is NOT a missing `git add -A`/`-u`.** Unstaged deletions (plain `rm`) already commit correctly. The bug is that *already-staged* deletions (from `git rm`/`git mv`, file absent from disk) make `git add -- <path>` return `fatal: pathspec did not match any files`, and the failure handler drops the path from the commit set. Reproduced: `git rm f1 f2 f3` fails every `git add`, yet `git commit -- f1 f2 f3` commits all three and leaves the tree clean.
- **Issue 6's `filesChanged` ghost is NOT a checkpoint-surface bug.** The checkpointer cannot even see ignored files (no `--ignored` flag). The ghost is the same agent-self-report defect as Issue 5, and disappears for free once Epic 2.1 sources `filesChanged` from git truth.

---

## Phase 1 — Checkpoint deletion fidelity (Issue 3)

Phase 1 is a prerequisite for Phase 2: Epic 2.1 derives `filesChanged` from the union of checkpoint `paths`, so checkpoints must capture deletions before that surface can be trusted.

### Epic 1.1: Checkpoint captures already-staged deletions

**Goal:** A checkpoint over a working tree containing already-staged deletions (e.g. an agent that ran `git rm` or `git mv`) commits those deletions, so the checkpoint is a faithful snapshot and a restart immediately afterward does not un-delete the files.
**Scope:** `packages/workflows/src/plugin/git-checkpoint.ts` (the staging loop only).
**Dependencies:** none.
**Done when:** a checkpoint over `git rm`-staged and `git mv`-staged deletions includes those paths in `CheckpointResult.paths`; `dirtyPaths()` is empty for those paths afterward; the operator-dirty refusal invariant is unchanged; bad pathspecs are still skipped-and-warned.

#### Task 1.1.1: Keep already-staged paths in the commit set when `git add` fails

- [ ] Done

**Context:** The staging loop at `packages/workflows/src/plugin/git-checkpoint.ts:342-359` runs `git add -- ${path}` once per workflow-touched path and pushes to `staged` only on `exitCode === 0` (`:344-346`); on a non-zero add it warns and skips the path (`:347-353`). The commit at `:371-373` is scoped to `commit ... -- ${staged}`, so any skipped path is omitted. A deletion that is *already staged* in the index (the file is gone from disk — the state `git rm` and `git mv` both produce, porcelain column-1 `D`) makes `git add -- <path>` fail with `fatal: pathspec did not match any files`, because `git add` matches its pathspec against working-tree or tracked-and-present files and an already-removed file matches neither. The path is dropped, the deletion is left staged-but-uncommitted, and `git status` shows a pending `D` after a "successful" run (the 21-`D` symptom in `ISSUES.md` Issue 3). Empirically: with `f1.ts f2.ts f3.ts` removed via `git rm`, all three `git add -- fN.ts` print `fatal: pathspec did not match`, yet `git commit --no-verify -- f1.ts f2.ts f3.ts` commits all three deletions and leaves the tree clean — the failed `git add` was a false blocker, the path was already in the index. Unstaged deletions (plain filesystem `rm`, porcelain ` D`) are unaffected: `git add -- <path>` stages those deletions fine and they already commit today. Note the `toCommit` set (`:313-320`) is already baseline-excluded, so the operator's pre-existing dirty paths (`preexistingDirty`, `:315-317`) are never in this loop — the refuse-don't-stomp guarantee at `:309-329` is upstream of this change and must remain intact.

**Implementation vision:** In the staging loop, when `git add -- ${path}` returns a non-zero exit code, do not immediately skip. First test whether the path is already present in the index via a fenced `git()` `git diff --cached --name-only -- ${path}` and inspect whether its trimmed `readText` output is non-empty (already staged). If already staged, push the path to `staged` anyway — the scoped `git commit -- ${staged}` will commit the staged deletion (proven above). If the add failed AND the path is not staged, retain the existing warn-and-skip behavior (a genuinely bad/raced pathspec). Reuse the existing `git()`, `.quiet()`, and `readText` patterns exactly (the host-fd / TUI-corruption reason for `.quiet()` is documented at `:215-228` — do not introduce an un-quieted call). Do not reach for `git add -A` or `git add -u`: the refuse-don't-stomp invariant (`:19-23`) forbids index-wide staging, and the per-path loop is the mechanism that enforces it.

Named edge cases and handling:
- Already-staged deletion (`git rm`/`git mv`, porcelain `D `): `git add` fails → `--cached` non-empty → included. (The fix.)
- Unstaged deletion (filesystem `rm`, porcelain ` D`): `git add` succeeds → included as today (unchanged).
- Already-staged add or modify (`A `/`M `): `git add` succeeds (no-op restage) → included as today (unchanged).
- Genuinely bad pathspec (typo, concurrently re-removed, never staged): `git add` fails AND `--cached` empty → skipped + warned (unchanged behavior, same warn at `:348-353`).
- Operator-dirty already-staged path: not reachable here — excluded into `refused` at `:315-317` before the loop, so the fix cannot sweep operator-staged content into an engine commit.
- Path with spaces/unicode: the `--cached -- ${path}` interpolation uses the same element-wise BunShell escaping that the existing `git add -- ${path}` relies on (`:369-370`).

**Files:**
- Modify: `packages/workflows/src/plugin/git-checkpoint.ts:342-359`
- Test: `packages/workflows/src/plugin/git-checkpoint.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/git-checkpoint.test.ts` — add cases that, in a temp repo: (1) `git rm` three tracked files then checkpoint → `CheckpointResult.committed === true`, `paths` contains all three, post-checkpoint `dirtyPaths()` excludes them; (2) `git mv` a tracked file then checkpoint → both the new path and the deleted old path are committed, tree clean; (3) a path that does not exist and was never staged → skipped, still warned, not in `paths`; (4) an operator-dirty staged deletion (staged before `baseline()`) → still in `refused`, never committed. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** staged deletions are committed by the checkpoint and reflected in `CheckpointResult.paths`; the tree is clean for those paths afterward; genuinely bad pathspecs are still skipped+warned; the operator-dirty refusal path is unchanged and covered by a test.

---

## Phase 2 — Git truth on `RunRecord` and in `workflow_status` (Issues 4, 5, 7, 6-filesChanged)

**Milestone:** After this phase, an operator reads engine-computed git truth directly from `workflow_status` — which files actually changed, which checkpoint commits a run created (with SHAs), and whether any change was mode-only — without dropping to `git log`/`git status` to reconcile. Agent self-report (`returnValue`) is still shown, but it is no longer the *only* source, and a "no commit" claim contradicted by real checkpoint commits is flagged.

**Shared root cause:** `CheckpointResult.sha`/`paths` (`git-checkpoint.ts:386-394`) are emitted only as `agent:checkpoint` feed lines (`engine.ts:1027-1036`); `RunRecord` (`engine.ts:147-179`) has no field for committed paths/SHAs, and `settleRecord` (`engine.ts:797-807`) copies the agent's `returnValue` verbatim, which `workflow-status.ts:209` renders raw. The fix is to accumulate the engine's existing git truth onto the record at the settle choke point and render it — not to repair a broken git read.

### Epic 2.1: `filesChanged` sourced from git truth

**Goal:** The run result carries an engine-computed `filesChanged` = the union of every checkpoint's committed `paths`, independent of whatever the synthesis agent put in `returnValue`.
**Scope:** `packages/workflows/src/plugin/engine.ts` (run-scoped accumulation in `enqueueCheckpoint`; new `RunRecord` field; settle wiring), `packages/workflows/src/plugin/tools/workflow-status.ts` (render).
**Dependencies:** Phase 1 (checkpoint `paths` must include deletions for the union to be complete — already landed; `checkpoint()` includes already-staged deletions at `git-checkpoint.ts:349-365`, so `CheckpointResult.paths` is complete).
**Done when:** a run whose agents touched N files reports all N in the engine-computed `filesChanged`, even when the agent's `returnValue.filesChanged` lists fewer or only a plan file; the agent's self-reported value is still shown separately, not overwritten.

**Design decision (locked, not re-opened):** `RunRecord` gets a single new git-truth field, `checkpoints?: CheckpointRecord[]` (introduced in Epic 2.1, see Task 2.1.1), where each `CheckpointRecord` is `{ sha?: string; paths: string[]; label: string; phase?: string }`. `filesChanged` is **derived** (the sorted, de-duplicated union of every `checkpoints[i].paths`), NOT a second stored field — one source of truth, no drift between the union and the ledger. Epic 2.2 reuses the same `checkpoints` array for its ledger block; Epic 2.3 tags mode flips onto the `paths` entries by widening `CheckpointRecord.paths` to a richer per-path shape *only in 2.3*. The agent's self-reported `returnValue.filesChanged` is rendered verbatim under the existing `result:` line (unchanged) and is never overwritten.

#### Task 2.1.1: Add `RunRecord.checkpoints` + accumulate committed paths in `enqueueCheckpoint`

- [ ] Done

**Context:** `enqueueCheckpoint` (`engine.ts:1014-1045`) already has the engine's git truth in hand: on `res.committed` it reads `res.sha` and `res.paths` and emits the `agent:checkpoint` feed line (`:1027-1036`). That truth is written ONLY to the feed — `RunRecord` (`engine.ts:147-179`) has no field for it, so `settleRecord` (`:797-807`) copies the agent's `returnValue` verbatim and `workflow-status.ts:208-224` renders it raw. The `enqueueCheckpoint` closure already closes over `record` (the same `record` `rollupAgent` mutates at `:1075-1080`), so it can append to a record field with no new plumbing. The `meta` passed into `enqueueCheckpoint` carries `label` and optional `phase` (`:1014-1018`); `res` carries `sha?`/`paths?`. Note `res.paths` is `string[] | undefined` on the `CheckpointResult` type (`git-checkpoint.ts:91`), but is always present when `committed:true` (`:404`).

**Implementation vision:** Add to `RunRecord` (after `agents?` at `engine.ts:178`) a new optional field `checkpoints?: CheckpointRecord[]`, and define and export `interface CheckpointRecord { sha?: string; paths: string[]; label: string; phase?: string }` beside `AgentSummary` (`engine.ts:106-125`) with a doc comment explaining it is the engine-computed per-checkpoint git truth (the union of all `paths` is the `filesChanged` surface; one entry per committed checkpoint). In `enqueueCheckpoint`, inside the existing `if (res.committed)` block (`:1027`), BEFORE or AFTER the `feed.append`, append a `CheckpointRecord` onto a lazily-created `record.checkpoints` (mirror `rollupAgent`'s lazy-create idiom at `:1075-1080`): push `{ ...(res.sha !== undefined ? { sha: res.sha } : {}), paths: res.paths ?? [], label: meta.label, ...(meta.phase !== undefined ? { phase: meta.phase } : {}) }`. Use a small local helper `recordCheckpoint(cp: CheckpointRecord)` next to `rollupAgent` for symmetry. Do NOT touch `settleRecord` — the field is mutated in-place on the same `record` object the settle sites persist, exactly as `record.agents` already is (the settle drains `checkpointTail` at `:1400` before `finalizeFeed`, so every checkpoint append has landed on `record.checkpoints` before persist).

Named edge cases and handling:
- Empty-diff / operator-refused checkpoint (`committed:false`): the `if (res.committed)` guard already skips it — no `CheckpointRecord`, no feed line (unchanged).
- Checkpoint with `committed:true` but no `sha` (rev-parse failed at `git-checkpoint.ts:398-399`): `sha` omitted from the record (the `paths` are still real and committed); the union is still complete.
- Cached/degraded agent end (no sessionID): never calls `enqueueCheckpoint` (`engine.ts:1277` is the live-end-only branch) — no record.
- A run with zero committed checkpoints: `record.checkpoints` stays `undefined` (lazy-create never fires), so `filesChanged` derivation yields `[]`/omitted — no empty array noise on disk.
- Cancelled run: aborted agents' ends still enqueue their checkpoints before `drainCheckpoints` (`:1396-1400`), so their committed paths land on the record — correct (they really did commit).

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts:106-125` (add `CheckpointRecord`), `:178` (add `checkpoints?` field), `:1027-1036` (append the record), `:1075-1080` (add `recordCheckpoint` helper beside `rollupAgent`)
- Test: `packages/workflows/src/plugin/engine.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/engine.test.ts` — drive a run whose agent ends produce two checkpoints with distinct path sets (via the existing engine test harness's fake checkpointer/shell) and assert the settled `record.checkpoints` has two entries carrying the right `sha`/`paths`/`label`/`phase`; a run with no committed checkpoints leaves `record.checkpoints` undefined. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** every committed checkpoint appends one `CheckpointRecord` to `record.checkpoints`; `committed:false` checkpoints add nothing; the field is undefined on a run with no commits; the settled record carries the full ledger.

#### Task 2.1.2: Derive and render engine-computed `filesChanged` in `workflow_status`

- [ ] Done

**Context:** `workflow-status.ts` renders the result via `renderResult` (`:208-224`) inside `render` (`:645-711`), appended only on `status === "completed"`/`"error"` (`:689-701`). The agent's `returnValue` (which carries the agent's self-reported `filesChanged`) is shown raw there. There is no engine-computed file surface today — Issue 5/6's ghost. Task 2.1.1 now puts the truth on `record.checkpoints`.

**Implementation vision:** Add a pure helper `engineFilesChanged(record: RunRecord): string[]` to `workflow-status.ts` (near `renderResult`) that returns the sorted, de-duplicated union of every `record.checkpoints?.[i].paths` (empty array when `checkpoints` is undefined). Add a `renderFilesChanged(record): string[]` that returns `[]` when the union is empty, else `["", "files changed (engine-computed, ${n}):", ...paths.map(p => "  " + p)]`. Call it in `render` immediately AFTER the `renderResult` line for BOTH terminal arms (`completed` at `:690` and `error` at `:697`) — a failed run still changed real files and the operator needs them. Show it regardless of `full` (it is compact and is the primary audit surface). Keep the existing `result:` line untouched so the agent's self-report stays visible and visibly SEPARATE — the contrast (agent said one file, engine says twelve) is the point.

Named edge cases and handling:
- Run with no checkpoints (`checkpoints` undefined or all `committed:false`): union empty → `renderFilesChanged` returns `[]` → no block (no misleading empty "files changed (0)" header).
- Same path committed by two agents (a later agent re-touches an earlier agent's file): de-duplicated in the union — reported once.
- Deletion paths (from Phase 1): present in `paths` and surfaced in the union like any other path (the executable-bit/mode tagging is Epic 2.3, not here — here a deleted path renders as the bare path).
- Running run: `render` only appends the result/files block on terminal status, so a live run shows no engine `filesChanged` yet (the checkpoints accrue but the audit surface is a completion artifact) — unchanged framing.
- Determinism: sort the union (e.g. `[...set].sort()`) so the rendered order is stable across runs and test-assertable.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts:208-224` (add `engineFilesChanged` + `renderFilesChanged` near `renderResult`), `:689-701` (call after `renderResult` in both terminal arms)
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow-status.test.ts` — a completed record whose `checkpoints` union is `["a.ts","b.ts","z.ts"]` while `returnValue.filesChanged` is `["docs/plans/x.md"]` renders BOTH: the agent's `["docs/plans/x.md"]` under `result:` AND an engine `files changed (engine-computed, 3): a.ts b.ts z.ts` block; a record with no checkpoints renders no engine files block; duplicate paths across two checkpoints appear once; the union is sorted. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** a terminal run renders the engine-computed union of checkpoint paths as a distinct `files changed (engine-computed, N)` block; the agent's self-reported `filesChanged` is still shown under `result:` and never overwritten; a no-checkpoint run shows no engine block.

### Epic 2.2: Checkpoint commit ledger + "no commit" reconciliation

**Goal:** `RunRecord` records every checkpoint commit (`sha`, `paths`, `label`, `phase`); `workflow_status` renders a checkpoints block; a synthesized "no commit was created" note is flagged when checkpoint commits exist for the run.
**Scope:** `packages/workflows/src/plugin/engine.ts` (record field + population in `enqueueCheckpoint`), `packages/workflows/src/plugin/tools/workflow-status.ts` (checkpoints block + contradiction flag), `packages/workflows/src/plugin/feed.ts` (recovery parity: `readFeedCounts` at `:380-431` must harvest `agent:checkpoint` lines it currently skips, so a rehydrated run keeps its ledger).
**Dependencies:** Epic 2.1 (shares the `RunRecord.checkpoints` git-truth surface introduced in Task 2.1.1 and the settle wiring).
**Done when:** `workflow_status` lists each checkpoint SHA + paths for a run; a "do not commit" workflow that nonetheless produced checkpoints surfaces a contradiction flag rather than a bare, false "no commit" line; the ledger survives a recovery/rehydrate cycle.

#### Task 2.2.1: Render the checkpoint ledger block in `workflow_status`

- [ ] Done

**Context:** Task 2.1.1 populated `record.checkpoints: CheckpointRecord[]` (`{ sha?, paths, label, phase? }`). Epic 2.1's render surfaces the *union* of paths; the operator also needs the per-commit ledger to reconcile against `git log` (Issue 4's symptom: eight `wf_mna7lden` checkpoint commits in `git log`, none surfaced in status). `workflow-status.ts` already has a precedent block for this shape — `renderDiagnostics` (`:226-247`) builds a `["", "diagnostics:", ...lines]` array shown under `full`.

**Implementation vision:** Add `renderCheckpoints(record: RunRecord): string[]` to `workflow-status.ts` near `renderDiagnostics`. Return `[]` when `record.checkpoints` is undefined or empty. Otherwise build `["", "checkpoints (N):"]` then one line per entry: `  <sha7> <label>[ phase=<phase>] (<paths.length> files)`, where `<sha7>` is `cp.sha?.slice(0, 7) ?? "(no sha)"`. Do NOT inline every path here (the union block from Task 2.1.2 already lists paths; the ledger maps commits→agents). Render the ledger under BOTH terminal arms, gated on `full` (it is a deeper forensic surface than the union, parity with `renderDiagnostics`'s `full`-only stance) — call it alongside the existing `renderDiagnostics(record)` calls at `:693-695` (completed) and `:698-700` (error).

Named edge cases and handling:
- No checkpoints: `[]` → no block (no empty "checkpoints (0):").
- Entry with no `sha` (rev-parse failed): renders `(no sha)` in the sha slot rather than `undefined`.
- Same label across two checkpoints (an agent re-run, or two agents sharing a label): each is its own ledger line (the ledger is per-commit, not per-agent) — correct, mirrors `git log`.
- Phase absent: the `phase=` segment is omitted for that line.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts:226-247` (add `renderCheckpoints` near `renderDiagnostics`), `:693-695` and `:698-700` (call under `full` in both terminal arms)
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow-status.test.ts` — a completed record with two checkpoints `[{sha:"abcdef1234", label:"agent-a", phase:"1", paths:["a.ts"]}, {sha undefined, label:"agent-b", paths:["b.ts","c.ts"]}]` under `full:true` renders `checkpoints (2):`, `  abcdef1 agent-a phase=1 (1 files)`, `  (no sha) agent-b (2 files)`; the same record WITHOUT `full` shows no checkpoint ledger; a no-checkpoint record shows no block. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** under `full`, a terminal run lists one ledger line per checkpoint commit (sha7, label, optional phase, file count); missing sha renders `(no sha)`; the default (non-full) view omits the ledger; a no-checkpoint run shows nothing.

#### Task 2.2.2: Flag a "no commit" claim contradicted by real checkpoints

- [ ] Done

**Context:** Issue 4: a workflow prompted "Do not commit" had its synthesis agent put `notes: ["No commit was created, per request."]` into `returnValue` while the engine had in fact created eight checkpoint commits. The status rendered the false note raw. Now `record.checkpoints` is the ground truth; the synthesized note lives in `record.returnValue` (an arbitrary unknown shape — the synthesis agent's structured output).

**Implementation vision:** Add a pure helper `noCommitContradiction(record: RunRecord): string | undefined` to `workflow-status.ts`. It returns a warning string ONLY when BOTH hold: (1) `record.checkpoints` is non-empty (real commits exist), AND (2) the agent's `returnValue` text claims no commit. For (2), detect conservatively: stringify `record.returnValue` (reuse `JSON.stringify`, guard `undefined`) and lower-case it, then test for the substring pattern `"no commit"` (covers "No commit was created", "no commit was made", "did not commit" is NOT matched — keep it to the literal "no commit" token to avoid false positives on legitimate prose like "no commits needed for the docs change" — accept that residual narrowness; a missed flag is degradation, a false flag erodes trust). When both hold, return: `⚠ result claims no commit, but the engine created ${n} checkpoint commit(s) — see the checkpoints block / git log`. Render it: in `render`, after the `result:`/files-changed lines on the `completed` arm (`:690`), push `["", contradiction]` when defined. Show it regardless of `full` (it is a safety claim, Issue 4's whole point — not a deep forensic detail).

Named edge cases and handling:
- No checkpoints, "no commit" note present: condition (1) false → no flag (the note is true).
- Checkpoints exist, no "no commit" claim: condition (2) false → no flag (nothing to contradict).
- `returnValue` undefined / not stringifiable to text: `JSON.stringify(undefined)` is `undefined` → treat as no claim → no flag (fenced; never throws).
- `returnValue` carries "no commit" inside an unrelated field but commits exist: flagged. Acceptable — a workflow that committed AND says "no commit" anywhere is worth a human glance; the flag points at evidence (git log) rather than asserting intent.
- Error-status run: the flag is only wired on the `completed` arm (a "no commit" claim is a synthesis-result claim; an errored run has no trustworthy synthesis to contradict) — keep it scoped to `completed`.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts` (add `noCommitContradiction` near `renderResult`; call in the `completed` arm at `:689-695`)
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow-status.test.ts` — a completed record with two `checkpoints` and `returnValue:{notes:["No commit was created, per request."]}` renders the `⚠ result claims no commit, but the engine created 2 checkpoint commit(s) …` line; the same `returnValue` with `checkpoints` undefined renders NO flag; checkpoints present with a `returnValue` that never says "no commit" renders NO flag; `returnValue` undefined renders no flag and does not throw. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** a completed run that produced checkpoints AND whose result claims "no commit" surfaces the contradiction warning pointing at the ledger/git log; the flag is absent when either condition fails; an undefined `returnValue` is handled without throwing.

#### Task 2.2.3: Recovery parity — harvest `agent:checkpoint` lines in `readFeedCounts`

- [ ] Done

**Context:** On a real crash, `record.checkpoints` (like `record.agents`) is empty because the record is persisted only at settle, never in `onProgress`. Recovery (`engine.ts:1565-1601`) re-reads the feed via `readFeedCounts` (`feed.ts:335-434`) to rehydrate `record.agents`/`record.agentCount` (`:1591-1596`). The feed DOES carry the truth: each committed checkpoint wrote an `agent:checkpoint` line (`engine.ts:1028-1035`; shape `{ type:"agent:checkpoint", label, sessionID, sha?, paths, at }` per `feed.ts:137-146`). But `readFeedCounts`'s loop (`:380-431`) only branches on `agent:start`/`agent:launched`/`agent:end` — it silently drops `agent:checkpoint` lines, so a rehydrated run loses its ledger and its engine `filesChanged`. The `agent:checkpoint` line carries `label`, `sha?`, `paths` but NOT `phase` (the feed line was never widened with it — `engine.ts:1028-1036`).

**Implementation vision:** Extend `FeedCounts` (`feed.ts:283-292`) with `checkpoints: FeedCheckpoint[]`, and define `interface FeedCheckpoint { sha?: string; paths: string[]; label: string }` (structurally a `CheckpointRecord` MINUS `phase`, since the feed line lacks it — documented; `phase` stays optional on the engine `CheckpointRecord`, so the omission is type-clean). Initialize `checkpoints: []` in the `empty` literal (`:339`). In the parse loop (`:380-431`), add an `else if (e.type === "agent:checkpoint")` arm that pushes `{ ...(e.sha !== undefined ? { sha: e.sha } : {}), paths: e.paths ?? [], label: e.label }`. In recovery (`engine.ts:1591-1596`), after the `record.agents` rehydrate, add: `if (counts.checkpoints.length > 0) { record.checkpoints = counts.checkpoints; }`. Because `FeedCheckpoint` is assignable to `CheckpointRecord` (phase optional), this is a direct assign — no mapping. The `AgentCheckpointLine` type is already a member of the `FeedEvent` union (`feed.ts:155-161`), so the narrow type-checks.

Named edge cases and handling:
- Truncated final `agent:checkpoint` line (crash mid-append): dropped by the existing JSON-parse fence (`:353-359`) — recovery still succeeds with the prior checkpoints (parity with `agent:end` handling).
- Interior corrupt `agent:checkpoint` line: dropped-and-continued by the same fence (documented `readFeedCounts` divergence from `journal.load`) — ledger missing that one entry, not poisoned.
- Feed with `agent:checkpoint` lines but zero `agent:end`: `agentCount` stays 0 (unchanged), `checkpoints` rehydrates — the two surfaces are independent, as they should be.
- A recovered run's checkpoints carry no `phase`: the ledger render (Task 2.2.1) omits the `phase=` segment for those lines — honest (the feed never recorded it).
- No `agent:checkpoint` lines: `counts.checkpoints` empty → recovery leaves `record.checkpoints` undefined (unchanged shape).

**Files:**
- Modify: `packages/workflows/src/plugin/feed.ts:283-292` (extend `FeedCounts` + add `FeedCheckpoint`), `:339` (init `checkpoints: []`), `:380-431` (add the `agent:checkpoint` arm), `packages/workflows/src/plugin/engine.ts:1591-1596` (rehydrate `record.checkpoints`)
- Test: `packages/workflows/src/plugin/feed.test.ts`, `packages/workflows/src/plugin/engine.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/feed.test.ts` — a feed containing two `agent:checkpoint` lines (one with sha, one without) plus `agent:end` lines yields `counts.checkpoints` of length 2 with the right `sha`/`paths`/`label`; a truncated final checkpoint line is dropped; a feed with no checkpoint lines yields `checkpoints: []`. `bun test packages/workflows/src/plugin/engine.test.ts` — a recovered (status flipped to error) run whose feed carried checkpoint lines rehydrates `record.checkpoints`. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** `readFeedCounts` returns the per-checkpoint ledger harvested from `agent:checkpoint` feed lines; recovery rehydrates `record.checkpoints` from it; truncated/corrupt lines are dropped without throwing; a recovered run's `workflow_status` shows its ledger and engine `filesChanged` exactly as a live-settled run would (minus `phase`, which the feed never recorded).

### Epic 2.3: Mode-aware change enumeration (chmod / executable bit)

**Goal:** A mode-only change (`100644 → 100755`) is distinguishable from a content change in the reported file list and surfaced as such.
**Scope:** `packages/workflows/src/plugin/git-checkpoint.ts` (retain the porcelain `XY` status currently discarded at `:158` `slice(3)`, or add a `git diff --name-status`/`--summary` read in `checkpoint()`; tag mode flips on the committed paths), propagate through the `agent:checkpoint` feed line and the `RunRecord` ledger from Epic 2.2.
**Dependencies:** Epic 2.2 (rides the same feed line + `CheckpointRecord` ledger field).
**Done when:** a `chmod +x` with no content change appears in the file surface tagged with its mode transition rather than as a bare `M path`.

**Design decision (locked, not re-opened):** Porcelain `XY` (the columns dropped at `git-checkpoint.ts:158` `slice(3)`) does NOT distinguish a mode-only change from a content change — both show status `M`. So retaining porcelain XY (the plan's first option) cannot answer "was this mode-only?". Reject it. Use the plan's second option: after the commit lands, read the mode transitions for the committed paths from the new commit with `git diff-tree --no-commit-id -r ${sha}` (or `git show --raw --no-renames ${sha}`), whose raw `:<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>` lines carry both modes. A path whose `oldmode !== newmode` AND whose blob shas are equal (`oldsha === newsha`) is a **mode-only** change; a path where the modes differ AND the blobs differ is a content+mode change; equal modes is plain content. Surface this as a per-path tag on the ledger. To carry it, widen `CheckpointResult.paths` (`git-checkpoint.ts:91-92`) is too invasive — instead add a SEPARATE optional `CheckpointResult.modeFlips?: Record<string, string>` mapping `path → "<oldmode>→<newmode>"` for the mode-only and mode+content paths, computed inside `checkpoint()` from the just-created commit (the sha is already read back at `:398-399`). The `CheckpointRecord` (Task 2.1.1) and the `agent:checkpoint` feed line gain the same optional `modeFlips?` map; the render tags those paths. A path with no entry in `modeFlips` renders as the bare path (today's behavior). This keeps `paths` a flat `string[]` (Epic 2.1/2.2 untouched) and isolates the mode data in an additive map.

#### Task 2.3.1: Compute mode transitions for committed paths in `checkpoint()`

- [ ] Done

**Context:** `checkpoint()` (`git-checkpoint.ts:302-407`) commits the staged pathspecs (`:384-385`) and reads back the new sha (`:398-399`). It returns `{ committed, sha?, paths, refused? }` (`:401-406`). Issue 7: a `chmod +x scripts/foo.sh` with no content change committed as a bare `M scripts/foo.sh`, so the reviewer could not see that the *mode* was the fix that unblocked the release gate. `git diff-tree -r <sha>` against the commit's parent emits raw lines encoding both file modes and both blob shas, which is exactly the mode-transition signal. All git plumbing here MUST go through the fenced `git()` + `.quiet()` pattern (the host-fd reason is documented at `git-checkpoint.ts:215-228`).

**Implementation vision:** Add `modeFlips?: Record<string, string>` to `CheckpointResult` (`git-checkpoint.ts:85-95`) with a doc comment: keys are committed paths whose file mode changed in this commit, values `"<oldmode>→<newmode>"` (e.g. `"100644→100755"`). After the sha read-back (`:398-399`), when `sha !== undefined`, run a fenced `git()`\``git diff-tree --no-commit-id --no-renames -r ${sha}`\`.quiet() and parse its stdout. Each raw line is `:<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>` (a leading colon, space-separated metadata, a TAB, then the path). Parse with a small pure helper `parseModeFlips(stdout: string): Record<string,string>` (exported for unit test, beside `parsePorcelain` at `:150`): split on `\n`, for each line starting with `:`, split the pre-TAB metadata on whitespace to read `oldmode`/`newmode`, take the post-TAB remainder as the path (unquote via the existing `unquotePath`), and record an entry ONLY when `oldmode !== newmode` (a content-only change has equal modes — no entry). Attach the map to the result: `...(Object.keys(modeFlips).length > 0 ? { modeFlips } : {})`. The blob-sha equality (`oldsha === newsha`) distinguishes mode-ONLY from mode+content, but for the surface we only need the transition string, so the render can note "(mode-only)" vs "(mode+content)" if desired — keep `parseModeFlips` returning just the transition; defer the mode-only-vs-both distinction to the value string if cheap (include it: value `"100644→100755"` plus, when `oldsha === newsha`, no content marker — the equal-blob case IS mode-only; expose a second map only if a test needs it. Decision: keep ONE map `path → "<oldmode>→<newmode>"`; mode-only-ness is derivable but not surfaced separately in v1).

Named edge cases and handling:
- `chmod +x`, no content change: one diff-tree line, `oldmode=100644 newmode=100755`, equal blob shas → entry `"100644→100755"`. (The fix.)
- Content edit, no mode change: modes equal → no entry → renders as bare path (unchanged).
- New file (add): diff-tree shows `oldmode=000000` → `oldmode !== newmode` → would record `"000000→100644"`. Guard against this: skip entries where `oldmode === "000000"` (a creation, not a chmod) OR where `newmode === "000000"` (a deletion). Only modes where BOTH are non-zero AND differ are real mode flips. Name this explicitly in the parser.
- Symlink/gitlink modes (`120000`/`160000`): a transition between two non-zero modes is recorded verbatim — rare, but honest; no special-casing.
- `sha === undefined` (rev-parse failed at `:398-399`): skip the diff-tree read entirely → no `modeFlips` (the paths are still committed and reported flat).
- Root commit (no parent): `git diff-tree -r <sha>` against a parentless commit lists every path as an addition (`000000→…`), all filtered by the creation guard → no spurious flips.
- Fenced: a non-zero diff-tree exit → empty stdout → empty map → omitted. Never throws into the chain.

**Files:**
- Modify: `packages/workflows/src/plugin/git-checkpoint.ts:85-95` (add `modeFlips?` to `CheckpointResult`), `:150` (add exported `parseModeFlips`), `:398-406` (compute + attach after sha read-back)
- Test: `packages/workflows/src/plugin/git-checkpoint.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/git-checkpoint.test.ts` — unit-test `parseModeFlips` directly: a `chmod` diff-tree line yields `{path:"100644→100755"}`; a creation line (`000000→100644`) yields `{}`; a deletion line (`100755→000000`) yields `{}`; a content-only line (equal modes) yields `{}`; a path with spaces (TAB-delimited) parses its path correctly. Then drive `checkpoint()` via the fake shell stubbing `git diff-tree …` to return a chmod line and assert `CheckpointResult.modeFlips` carries the transition; stub it to fail and assert `modeFlips` is omitted; assert the `git diff-tree` command was issued through `.quiet()`. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** `checkpoint()` returns a `modeFlips` map for committed paths whose file mode changed between non-zero modes; creations/deletions are excluded; a content-only commit yields no map; the diff-tree read is fenced and quieted; `parseModeFlips` is unit-tested across all five edge cases.

#### Task 2.3.2: Propagate `modeFlips` through the feed line, ledger, and render

- [ ] Done

**Context:** Task 2.3.1 puts `modeFlips` on `CheckpointResult`. It must reach the operator: through `engine.ts`'s `enqueueCheckpoint` onto both the `agent:checkpoint` feed line (`engine.ts:1028-1035`) and the `CheckpointRecord` (Task 2.1.1), through `readFeedCounts` recovery (Task 2.2.3), and into the `workflow-status.ts` render (the union block from Task 2.1.2 and/or the ledger from Task 2.2.1). The `AgentCheckpointLine` (`feed.ts:137-146`) and `CheckpointRecord`/`FeedCheckpoint` all need the optional field.

**Implementation vision:**
1. `feed.ts:137-146`: add `modeFlips?: Record<string, string>` to `AgentCheckpointLine`.
2. `engine.ts:1028-1035`: in the `feed.append({ type:"agent:checkpoint", … })`, add `...(res.modeFlips !== undefined ? { modeFlips: res.modeFlips } : {})`. In the Task 2.1.1 `recordCheckpoint` push, add the same spread onto the `CheckpointRecord`.
3. `engine.ts` `CheckpointRecord` (Task 2.1.1) and `feed.ts` `FeedCheckpoint` (Task 2.2.3): add `modeFlips?: Record<string, string>`.
4. `feed.ts` `readFeedCounts` checkpoint arm (Task 2.2.3): carry `...(e.modeFlips !== undefined ? { modeFlips: e.modeFlips } : {})` into the pushed `FeedCheckpoint`.
5. `workflow-status.ts`: in `renderFilesChanged` (Task 2.1.2), build a combined `path → transition?` view by merging every checkpoint's `modeFlips`; render a flagged path as `  <path>  (mode <old>→<new>)` and an unflagged path as the bare `  <path>`. (The union still de-duplicates; if the same path appears in two checkpoints with a flip in one, the flip is shown.)

Named edge cases and handling:
- A path that is mode-flipped in one checkpoint and content-changed in another: the merge keeps the mode transition annotation (the operator wants to see the mode event; it is the rarer, gate-relevant signal). Document the merge as "last-flip-wins / any-flip-shown".
- Recovered run (Task 2.2.3): if the feed carried `modeFlips`, it rehydrates and renders identically; if an OLD feed (pre-2.3) lacks the field, the path renders bare — backward-compatible.
- No mode flips anywhere: `renderFilesChanged` renders exactly as Task 2.1.2 (all bare paths) — zero behavior change for the common case.

**Files:**
- Modify: `packages/workflows/src/plugin/feed.ts:137-146` (feed line field) + `FeedCheckpoint` (Task 2.2.3 type) + `readFeedCounts` arm, `packages/workflows/src/plugin/engine.ts:1028-1035` (feed append + `recordCheckpoint`) + `CheckpointRecord` type, `packages/workflows/src/plugin/tools/workflow-status.ts` `renderFilesChanged` (annotate flagged paths)
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts`, `packages/workflows/src/plugin/feed.test.ts`, `packages/workflows/src/plugin/engine.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow-status.test.ts` — a completed record whose checkpoint carries `modeFlips:{"scripts/foo.sh":"100644→100755"}` renders `  scripts/foo.sh  (mode 100644→100755)` in the files-changed block while other paths render bare; a record with no `modeFlips` renders all paths bare. `bun test packages/workflows/src/plugin/feed.test.ts` — `readFeedCounts` carries `modeFlips` from an `agent:checkpoint` line into the `FeedCheckpoint`. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** a `chmod +x` checkpoint surfaces its path tagged `(mode 100644→100755)` in `workflow_status`, on both live-settled and recovered runs; paths with no mode change render bare; old (pre-2.3) feeds render bare without error.

### Epic 2.4: Ignored-path diagnostic (Issue 6, observability half)

**Goal:** When a workflow resolves a source/spec path, the engine classifies it (tracked / untracked / ignored / missing) and records the verdict in run diagnostics, so an operator is warned that a `docs/plans/`-style ignored file is a local ghost, not a saved artifact.
**Scope:** `packages/workflows/src/plugin/resolve-source.ts` (classify on `scriptPath` resolution, `:96-105`) using a fenced `git check-ignore -v -- <path>` via the existing `git()` shell; attach to the existing `RunRecord.diagnostics` surface.
**Dependencies:** none (independent of 2.1–2.3).
**Done when:** resolving an ignored path emits a diagnostic naming the matching `.gitignore` rule; a tracked path does not. **Flag for the user, do not default:** making an ignored scratch file visible to an `isolation:'worktree'` agent is structural (a fresh checkout cannot carry untracked content) — whether workflows should require a tracked path or commit scratch at run start is a product call, surfaced in the diagnostic, not silently enforced.

**Design corrections (locked, two deviations from the epic placeholder — both justified):**
1. **`RunRecord.diagnostics` is the WRONG surface.** It is typed `AgentDiagnostic[]` (`runtime/types.ts:223-237`), a per-`agent()`-call shape carrying `{label, index, reason: DiagnosticReason, rawText?, childSessionID?}` — there is no run-scoped slot, and the `DiagnosticReason` enum (`:202-214`) is a closed vocabulary of agent-degrade reasons with no path-classification member. Shoehorning a source-path verdict into it would lie about `index`/`reason`. Instead add a NEW, run-scoped field `RunRecord.sourceDiagnostics?: SourceDiagnostic[]` where `interface SourceDiagnostic { path: string; classification: "tracked" | "untracked" | "ignored" | "missing"; rule?: string }` (`rule` = the matching `.gitignore` line for `ignored`). This is the honest shape; it does not collide with the agent diagnostics surface and renders in its own block.
2. **`resolve-source.ts` has no `git()` shell.** The epic says "via the existing `git()` shell", but `createSourceResolver` (`resolve-source.ts:78-107`) takes only `{directory, fs, builtins}` — no `$`/BunShell. And resolve-source is the SUB-workflow resolver (spec §8); the user-facing entry path is the engine's `startRun` (`engine.ts:895-920`), which resolves source via `resolveResume` and knows the run's `scriptPath`/source ref. Classification belongs at the engine level, where `opts.shell` and `opts.directory` are already in hand (the same pair `createGitCheckpointer` is built from at `:611-625`). So Epic 2.4 classifies the run's referenced spec/source path in the engine at record creation, using a fenced `git()` built exactly like the checkpointer's, and attaches the verdict to `record.sourceDiagnostics`. The classification helper itself is a small pure-by-injection function (shell injected) co-located in a new `classify-path.ts` so it is unit-testable with the same fake-shell harness as `git-checkpoint.test.ts`, and reused if the sub-workflow resolver later wants it.

**Scope (corrected):** `packages/workflows/src/plugin/classify-path.ts` (NEW — `classifyPath(shell, directory, path)` via fenced `git check-ignore -v` + `git ls-files`), `packages/workflows/src/plugin/engine.ts` (call at record creation `:909-957`; add `RunRecord.sourceDiagnostics` field + `SourceDiagnostic` type), `packages/workflows/src/plugin/tools/workflow-status.ts` (render a `source diagnostics:` block). NOTE: this supersedes the placeholder's `resolve-source.ts:96-105` target.

#### Task 2.4.1: `classifyPath` — fenced tracked/untracked/ignored/missing classifier

- [ ] Done

**Context:** Issue 6: a plan written to `docs/plans/…md` was `.gitignore`d (`docs/plans/`), so it was a local ghost — `git status` never showed it, subagents in fresh checkouts could not see it, yet the workflow treated it as the source of truth. The engine needs to classify a referenced path so the operator is warned. `git check-ignore -v -- <path>` exits 0 and prints `<gitignore-file>:<line>:<pattern>\t<path>` when the path is ignored, exits 1 (no output) when NOT ignored; it does not tell tracked-vs-untracked. `git ls-files --error-unmatch -- <path>` exits 0 iff the path is tracked. File existence is an fs concern, but a pure git classifier can infer `missing` as "not tracked AND not on disk" — simpler to pass an `exists` boolean in (the engine knows via its `fs`), keeping `classifyPath` git-only. All git calls MUST use the fenced `git()` + `.quiet()` pattern (host-fd reason: `git-checkpoint.ts:215-228`).

**Implementation vision:** New file `packages/workflows/src/plugin/classify-path.ts`. Export `interface SourceDiagnostic { path: string; classification: "tracked" | "untracked" | "ignored" | "missing"; rule?: string }` (the single home for the type; `engine.ts` imports it for `RunRecord`). Export `async function classifyPath(shell: BunShell | undefined, directory: string, path: string, exists: boolean): Promise<SourceDiagnostic>`. Logic, all fenced (`git()` = `shell.cwd(directory).nothrow()`, every call `.quiet()`, reading `.exitCode`/`.text()` — reuse the exact idiom and the `BunShell` type from `git-checkpoint.ts:46`):
- No shell, or shell present but the dir is not a work tree: return `{ path, classification: exists ? "untracked" : "missing" }` — cannot consult git, so do not claim `ignored`/`tracked` (parity with the checkpointer's `available:false` honesty: never assert a git fact without git).
- `git ls-files --error-unmatch -- ${path}` exit 0 → `{ path, classification: "tracked" }` (tracked wins; a tracked file is never "ignored" even if a pattern would match).
- Else `git check-ignore -v -- ${path}` exit 0 → parse the first output line's leading `<file>:<line>:<pattern>` (split on the TAB; the metadata before it is the rule) → `{ path, classification: "ignored", rule: "<file>:<line>:<pattern>" }`.
- Else (not tracked, not ignored): `{ path, classification: exists ? "untracked" : "missing" }`.
Add a pure helper `parseCheckIgnoreRule(stdout: string): string | undefined` (exported for unit test) that returns the pre-TAB substring of the first non-empty line, or undefined.

Named edge cases and handling:
- Ignored AND on disk (the Issue 6 case): `ls-files` fails, `check-ignore` succeeds → `ignored` with the rule (e.g. `.gitignore:47:docs/plans/`). (The fix.)
- Tracked file that also matches an ignore pattern (force-added): `ls-files` exit 0 → `tracked` (correct precedence — it IS in the index).
- Path not tracked, not ignored, exists on disk: `untracked`.
- Path not tracked, not ignored, absent from disk: `missing`.
- No shell / non-git checkout: `untracked` (exists) or `missing` — never a fabricated `ignored`/`tracked`.
- `check-ignore` unavailable or errors (exit > 1): treated as "not ignored" (fenced; falls through to untracked/missing) — never throws.
- Path with spaces/unicode: element-wise BunShell interpolation (`-- ${path}`) escapes it, same as `git add -- ${path}` (`git-checkpoint.ts:344`); the TAB-split in `parseCheckIgnoreRule` handles git's quoted-path output by taking everything before the TAB as the rule (the path after the TAB is not needed — we already know it).

**Files:**
- Create: `packages/workflows/src/plugin/classify-path.ts`
- Test: `packages/workflows/src/plugin/classify-path.test.ts` (reuse the fake-BunShell harness from `git-checkpoint.test.ts:33-88`)

**Verification:** `bun test packages/workflows/src/plugin/classify-path.test.ts` — with a fake shell: `ls-files` exit 0 → `tracked`; `ls-files` exit 1 + `check-ignore` exit 0 returning `.gitignore:47:docs/plans/\tdocs/plans/x.md` → `ignored` with `rule:".gitignore:47:docs/plans/"`; both fail + `exists:true` → `untracked`; both fail + `exists:false` → `missing`; `shell:undefined` + `exists:true` → `untracked` (no git assertion); assert every git command went through `.quiet()`. Unit-test `parseCheckIgnoreRule` on a TAB-delimited line and an empty string. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** `classifyPath` returns the correct one of tracked/untracked/ignored/missing with the ignore rule when ignored; tracked beats ignored; no-shell never fabricates a git verdict; all calls are fenced+quieted; the two pure helpers are unit-tested.

#### Task 2.4.2: Classify the run's source path at record creation and render it

- [ ] Done

**Context:** `startRun` (`engine.ts:893-957`) resolves the run's source via `resolveResume` and builds the `record` at `:909-920`. The engine holds `opts.shell` and `opts.directory` (used to build the checkpointer at `:611-625`). The referenced spec/source path the operator cares about is the run's `scriptPath`-style input — but `scriptPath` here is the engine's OWN persisted copy under `workflow-scripts/<id>.js` (`:899`), which is NOT what Issue 6 is about. Issue 6 is about a path the WORKFLOW references (the `docs/plans/…md` it reads/writes). The honest, low-blast-radius v1: classify the path the caller passed as the workflow's source reference when it was a `{ scriptPath }` ref (the iterate/resume loop hands one back), since that is the only file path the engine actually receives. **Resolve the fork narrowly:** classify `args` only when the start carried an explicit on-disk source ref. The `StartRunArgs` (`engine.ts:217-245`) carries `source?: string` (inline source, no path to classify) — so v1 classifies the path ONLY when a future/explicit `scriptPath`-bearing arg is present; absent that, emit no source diagnostic. To avoid inventing arg surface, key off what exists: if `args` (the run invocation args, `record.args`) or the resolved ref carries a string path field the workflow declared as its plan/spec, classify it. **Concretely and without new arg surface:** scan `record.args` for a top-level string value that looks like a repo-relative file path ending in a known doc/spec extension (`.md`) — classify each such path. This is a heuristic, named as such; it catches the `docs/plans/…md` case (the plan path is passed as a workflow arg) without adding schema.

> **DECISION NEEDED FROM USER (do not silently default):** v1's trigger for *which* path to classify is the open question. Options: (a) heuristic scan of `record.args` for `.md`-suffixed string values [Recommended — zero new surface, catches the observed Issue 6 case]; (b) add an explicit `specPath?: string` to `StartRunArgs` that the `workflow` tool populates, classified verbatim [cleanest, but new public arg surface + tool-schema change spanning Phase 2's "no tool surface change" boundary noted in ISSUES Meta]; (c) classify every path the checkpointer commits that is `.gitignore`d [reuses Epic 2.1 truth, but fires post-hoc, after the ghost already misled the run]. The structural half (making an ignored file visible to a worktree-isolated agent) stays a flagged product question per the epic, NOT defaulted. Default if no answer: implement (a), the heuristic, behind the new `sourceDiagnostics` field so it is purely additive and reversible.

**Implementation vision (assuming default (a)):** Add `RunRecord.sourceDiagnostics?: SourceDiagnostic[]` (import `SourceDiagnostic` from `classify-path.ts`) after the Epic 2.1 `checkpoints?` field. In `startRun`, after building `record` (`:920`) and before firing the detached run, collect candidate paths from `record.args` (a fenced scan: if `args` is an object, take string values matching `/\.md$/`; if `args` is itself a `.md` string, take it), call `classifyPath(opts.shell, opts.directory, path, exists)` for each (exists via `fs.readFile` probe or a stat, fenced), and assign `record.sourceDiagnostics` when any verdict is `ignored` or `missing` (the operator-relevant ones — `tracked`/`untracked` are unremarkable and would be noise; record ALL of them only under a future verbose flag — v1 records just `ignored`/`missing`). Persist happens via the existing `persistRecord(record)` at `:957`. Render: add `renderSourceDiagnostics(record): string[]` to `workflow-status.ts` near `renderDiagnostics`, returning `["", "source diagnostics:", ...]` with one line per entry: `  ⚠ <path> is ${classification}${rule ? " (" + rule + ")" : ""} — not a tracked artifact; it will not travel with the branch and may be invisible to isolated agents`. Show it on every terminal arm regardless of `full` (it is a safety/reproducibility warning, Issue 6's point).

Named edge cases and handling:
- Plan path `docs/plans/x.md` ignored: classified `ignored` with rule → recorded → rendered with the warning. (The fix.)
- A tracked `.md` arg: classified `tracked` → NOT recorded (no noise).
- An arg `.md` path that does not exist: `missing` → recorded (the operator passed a path the engine cannot see).
- `args` undefined / not an object / no `.md` strings: no candidates → `sourceDiagnostics` undefined → no block.
- No shell / non-git: `classifyPath` returns `untracked`/`missing` — only `missing` is recorded, so an ignored ghost is NOT falsely flagged on a non-git checkout (honest: we cannot prove ignored without git).
- Classification must be fenced and must NOT delay or break the run: wrap the whole scan-and-classify in a try/catch that logs and continues (a classification failure never blocks `startRun`).

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts` (add `RunRecord.sourceDiagnostics?` field + import `SourceDiagnostic`; scan+classify after `:920`, before the detached fire), `packages/workflows/src/plugin/tools/workflow-status.ts` (add `renderSourceDiagnostics`; call on terminal arms at `:689-701`)
- Test: `packages/workflows/src/plugin/engine.test.ts`, `packages/workflows/src/plugin/tools/workflow-status.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/engine.test.ts` — a run started with `args:{plan:"docs/plans/x.md"}` and a fake shell where `x.md` classifies `ignored` lands `record.sourceDiagnostics` with one `ignored` entry carrying the rule; a tracked `.md` arg records nothing; a non-`.md` arg records nothing; a classifier throw does not break `startRun` (the run still settles). `bun test packages/workflows/src/plugin/tools/workflow-status.test.ts` — a record with an `ignored` source diagnostic renders the `⚠ … is ignored (.gitignore:47:docs/plans/) — not a tracked artifact …` warning; no diagnostics → no block. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** a run that references an ignored `.md` plan path records and renders a source diagnostic naming the `.gitignore` rule; tracked/untracked paths are not flagged (only `ignored`/`missing` recorded); classification never blocks or breaks `startRun`; a non-git checkout never fabricates an `ignored` verdict. The structural "should isolated agents see the ghost" question remains surfaced for the user, not silently enforced.

---

## Phase 3 — `verifyDiff` per-agent isolation (Issue 2)

**Milestone:** `verifyDiff` evaluates each agent against only that agent's own changes, so agents in the same `parallel()` group no longer fail (or pass) on siblings' mid-flight edits. Both observed failure modes are gone: the false negative (whole-repo `typecheck` seeing a sibling's half-written file) and the silent false positive (default `{}` mode asserting the *whole-tree* diff is non-empty, so an agent that changed nothing "passes" on a sibling's work).

**Root cause (confirmed):** `verifyResult` runs inside each agent body at `agent-call.ts:747-778`, between the agent's own completion and its gate release, with the only cross-agent barrier being the `Promise.all` in `compose.ts:106` — which is downstream of every agent's verify. Up to `min(16, cores-2)` agents mutate one shared working tree concurrently. The `{check}` command runs from the repo root (`engine.ts:1142,1158-1161`) and the default `{}` mode diffs the run-start baseline against the whole working tree (`engine.ts:1199-1200` → `git-checkpoint.ts:296`) — neither is scoped to the agent.

**Elaboration finding (verified against the current tree, supersedes the placeholder's "build it" framing):** The per-agent **worktree isolation machinery already exists and is fully wired** — the mint-point (`agent-call.ts:448-506`), the `serializeOnCheckpoint` merge ordering, the merge-back conflict tiers (`agent-call.ts:825-915`), and the engine's worktree manager (`git-worktree.ts`, constructed once at `engine.ts:709-713` and threaded through every run at `engine.ts:1220`). Crucially, the engine's `verifyResult` wiring **already re-roots BOTH verify modes to the worktree** when the runtime passes a `directory`: the `{check}` branch runs the command via `opts.shell.cwd(v.directory)` (`engine.ts:1279,1286-1288`), and the `{}`/`true` branch runs `git diff` (working-tree vs HEAD) bound to `v.directory` (`engine.ts:1311-1326`). The runtime already forwards the worktree dir into verify (`agent-call.ts:760-762`). **The single missing link is the trigger:** `verifyDiff` and `isolation:'worktree'` are independent opts today, so a script that sets only `verifyDiff` gets NO worktree — the mint-point gate is `if (opts.isolation === "worktree")` (`agent-call.ts:450`), verify then runs with no `directory`, and the `{}` branch falls through to `runCheckpointer.diff()` (whole-tree vs run-start baseline, `engine.ts:1327-1328`) — exactly the race (false negative) and the whole-tree false positive. Phase 3 therefore reduces to: **make `verifyDiff` imply worktree isolation** (Epic 3.1), which routes verify through the already-correct `v.directory` path and **fixes the `{}` false positive for free** on shell-available engines (Epic 3.2 becomes the assertion + the no-shell-inert guard, not new diff plumbing).

### Epic 3.1: Verify against an agent-isolated view

**Goal:** When `verifyDiff` is set, the agent runs in its own git worktree, so the check (git-diff or a real `tsc`/`lint` command reading disk) observes only that agent's edits, not the shared mutating tree.
**Scope:** `packages/workflows/src/runtime/agent-call.ts` (the mint-point gate at `:450` and the verify-inert guard at `:747-778`).
**Dependencies:** none in code (the worktree manager + verify re-rooting already exist); land after Phase 2 to avoid churn on shared engine surfaces.
**Done when:** three agents in one `parallel()` group, each with a whole-repo `verifyDiff:{check}`, each mint a distinct worktree, run their check in that worktree, and report truthful per-agent verdicts under concurrency — a sibling's mid-flight edit in the main tree (or another worktree) cannot flip a verdict.
**Design fork — RESOLVED (chosen approach, locked):** Option (a), worktree isolation per verified agent, reusing the existing mint/merge machinery. Option (b) (per-agent pre-launch baseline diff) is rejected: it cannot scope a real `{check}` command (`tsc`/`lint` read the whole on-disk tree regardless of a baseline ref), and the worktree path already solves both modes uniformly. Deferring verify to the phase barrier is rejected (loses per-agent attribution).

#### Task 3.1.1: Make `verifyDiff` imply worktree isolation, inert-not-detonating when isolation is unavailable

- [ ] Done

**Context:** The mint-point at `agent-call.ts:448-506` mints a worktree only when `opts.isolation === "worktree"` (`:450`). On a mint miss (no `worktreeManager`, or `create()` returns null) it **degrades the agent to null** with a loud `isolation_unsupported`/`worktree_mint_failed` diagnostic (`:472-503`) — correct for an EXPLICIT isolation request (the script asked for a guarantee the engine cannot provide). The verify post-condition runs later in the `try` (`:747-778`) and forwards the worktree dir into `verifyResult` only when `worktree !== undefined` (`:760-762`). The contract for `verifyDiff` (types.ts:60-66) is **INERT on a no-shell / non-git checkout — the result passes through unchanged, NEVER a fabricated failure and never a degrade-to-null**. So `verifyDiff` cannot reuse the explicit-isolation degrade-to-null behavior on a mint miss: a no-shell engine threads a `worktreeManager` whose `create()` returns null (`git-worktree.ts:220,270-272`), which would turn every `verifyDiff` agent into a spurious null. The fix must split "isolation was explicitly requested" (detonate-to-null on miss, unchanged) from "isolation was implied by verifyDiff" (fall back to running unisolated on miss, then verify against the shared tree exactly as today — no worse than the pre-fix baseline, and inert on no-shell).

**Implementation vision:** At the top of the mint-point, compute two booleans BEFORE the gate:
- `const explicitIsolation = opts.isolation === "worktree";`
- `const wantsIsolation = explicitIsolation || opts.verifyDiff !== undefined;`

Change the gate at `:450` from `if (opts.isolation === "worktree")` to `if (wantsIsolation)`. Inside, when `minted === null` (`:472`): keep the current loud degrade-to-null **only when `explicitIsolation` is true** (the script demanded the guarantee). When the mint miss is from an IMPLIED isolation (`!explicitIsolation`, i.e. `verifyDiff`-only), do NOT degrade: skip the warn/diagnostic/return-null block, leave `worktree` undefined and `launchDirectory` as the run-wide `directory`, and fall through to the normal launch. The agent then runs unisolated, and the later verify (`:747-778`) sees `worktree === undefined`, forwards no `directory`, and `verifyResult` evaluates against the shared tree / inert-on-no-shell path — identical to today's `verifyDiff` behavior. Concretely, wrap the existing `if (minted === null) { … return null; }` body in `if (explicitIsolation) { … return null; }` and `else { /* implied: fall through unisolated, no degrade */ }`. The `minted !== null` success path (`:504-505` set `worktree`/`launchDirectory`) is unchanged and applies to BOTH explicit and implied isolation — a successfully-minted verifyDiff agent gets the isolated verify.

Named edge cases and handling:
- `verifyDiff` set, manager mints successfully (shell-available engine, the common case): worktree minted, launch re-rooted, verify runs in the worktree via `v.directory`. (The fix — false negative gone.)
- `verifyDiff` set, NO `worktreeManager` (standalone library): `wantsIsolation` true, `minted` stays null (manager undefined), `explicitIsolation` false → fall through unisolated, verify runs as today. No spurious null.
- `verifyDiff` set, manager present but `create()` returns null (no-shell engine / non-repo / transient `git worktree add` failure): same as above — fall through unisolated, no degrade. (Honors the verifyDiff-is-inert-on-no-shell contract.)
- `isolation:'worktree'` set explicitly, mint miss: UNCHANGED — loud `isolation_unsupported`/`worktree_mint_failed` degrade-to-null (`explicitIsolation` true). The existing tests at `agent-call.test.ts:896,1048,1081` must still pass verbatim.
- BOTH `isolation:'worktree'` AND `verifyDiff` set, mint miss: `explicitIsolation` true wins → degrade-to-null (the explicit request is the stronger contract). Correct.
- `verifyDiff` set on a worktree agent that later hits a merge CONFLICT (Tier 1): unchanged — the conflict result supersedes per the existing finally (`:938-941`); verify already ran in the `try` against the worktree before the merge. The conflict path is independent of this gate change.
- `verifyDiff` undefined AND `isolation` undefined: `wantsIsolation` false → no mint, no behavior change (the `agent-call.test.ts:1195` "non-isolated agent never mints" test must still pass — it sets neither opt).
- Cost note (named, accepted per the locked fork): every `verifyDiff` agent now incurs a `git worktree add` + merge-back on a shell-available engine. This is the deliberate price of per-agent truth; the merge-conflict tiers (`:825-915`) now apply to verifyDiff agents, which is correct (their edits must merge back like any isolated agent's).

**Files:**
- Modify: `packages/workflows/src/runtime/agent-call.ts:448-506` (compute `explicitIsolation`/`wantsIsolation`; widen the gate; scope the degrade-to-null to `explicitIsolation`)
- Test: `packages/workflows/src/runtime/agent-call.test.ts` (reuse the `recordingWorktreeManager` / `FakeRunner` / `harness` helpers at `:937-1209`)

**Verification:** `bun test packages/workflows/src/runtime/agent-call.test.ts` — add cases: (1) `agent("p", { verifyDiff: true })` with a `recordingWorktreeManager` that mints a handle → exactly one `create`, the launch is re-rooted to the minted dir, and `verifyResult` is called with `directory` = the minted dir; (2) `agent("p", { verifyDiff: { check: "tsc" } })` with `worktreeManager` ABSENT → no mint, no degrade, the agent resolves to its result (NOT null), verify called with no `directory`; (3) `agent("p", { verifyDiff: true })` with a manager whose `create()` returns null → no degrade-to-null, resolves to result, no `worktree_mint_failed` diagnostic emitted; (4) regression: `agent("p", { isolation: "worktree" })` with `create()` null still degrades to null with `worktree_mint_failed` (the `:1048` test); (5) regression: `agent("plain")` (neither opt) still mints nothing (the `:1195` test). Then `bun run typecheck` and `bun run lint` clean.

**Done when:** a `verifyDiff` agent mints and runs in its own worktree on a shell-available engine (verify re-rooted to it); a `verifyDiff` agent on a no-shell/standalone/mint-miss engine falls through to unisolated and never degrades to null; an explicit `isolation:'worktree'` request still degrades-to-null loudly on a mint miss; the three regression tests (`:896`, `:1048`, `:1081`, `:1195`) pass verbatim.

### Epic 3.2: Fix default-mode (`true`/`{}`) false positive

**Goal:** Default-mode `verifyDiff` (`true`/`{}`) asserts *this agent* produced a change, not that *the whole tree* is non-empty — so an agent that changed nothing reports `verify_failed` even while a sibling concurrently mutates the tree.
**Scope:** `packages/workflows/src/plugin/engine.ts:1302-1328` (the `{}`/`true` branch of `verifyResult`).
**Dependencies:** Epic 3.1 (the per-agent worktree is what makes the diff per-agent).

**Elaboration finding (the false positive is already half-fixed by the existing worktree-rooted branch):** The `{}`/`true` branch of `verifyResult` already has a worktree-aware arm: when `v.directory !== undefined && opts.shell !== undefined` it runs `git diff` (working-tree vs HEAD) bound to the worktree dir (`engine.ts:1311-1326`) — which IS "did THIS agent change something", true by construction (the worktree starts at HEAD and holds only this agent's edits). Once Epic 3.1 makes `verifyDiff` imply isolation, a shell-available `verifyDiff:{}` agent ALWAYS supplies `v.directory`, so it ALWAYS takes this correct per-agent arm. The whole-tree `runCheckpointer.diff()` fallback (`:1327-1328`) is then reachable ONLY when `v.directory` is absent — i.e. the unisolated fallback from Epic 3.1 (no-shell / mint-miss), where the checkpointer is dead and `diff()` returns `available:false` → INERT pass-through, never a fabricated verdict. So the false positive cannot survive on a shell-available engine. Epic 3.2's remaining work is to make the per-agent assertion robust and explicitly verified, not to add new diff plumbing.

**Done when:** an agent that makes no real change reports `verify_failed` (its worktree `git diff` is empty) even while a sibling concurrently mutates the main tree; the whole-tree fallback only fires on the no-shell/mint-miss path where it is inert (`available:false`).

#### Task 3.2.1: Assert the worktree-rooted `{}` diff is the verdict for an isolated agent; lock the no-shell-inert fallback

- [ ] Done

**Context:** The `{}`/`true` branch of `verifyResult` (`engine.ts:1302-1328`) has three arms: (1) `v.directory` + shell present → `git diff` in the worktree (`:1311-1326`, the per-agent truth); (2) the fenced `catch` → `available:false` (`:1321-1325`); (3) no `v.directory` → `runCheckpointer.diff()` vs run-start baseline (`:1327-1328`, the whole-tree fallback). After Epic 3.1, arm (1) is the path for every shell-available `verifyDiff:{}` agent and arm (3) is reachable only when isolation was unavailable (no-shell → dead checkpointer → `available:false`, inert). The behavior is already correct; what is missing is a TEST that pins it so a future refactor cannot silently re-introduce the whole-tree diff for an isolated agent. The `git diff` in arm (1) is `working tree vs HEAD` — the worktree's HEAD is the create-time base (`git-worktree.ts:289-294`), so an agent that wrote nothing has an empty `git diff` → `passed:false` → `verify_failed` regardless of what siblings did to the main tree (the worktree is a separate checkout). This is the false-positive fix made concrete.

**Implementation vision:** No production change is required IF the elaboration finding holds end-to-end — this task is **test-first verification that the existing arms behave per the chosen design**, plus one defensive assertion. Write the engine-level tests FIRST (they should pass green if arms (1)/(2)/(3) are wired as read). The one production edge to confirm-or-fix: in arm (1), `git diff` (no `--quiet`, reads `.text()`) returns empty stdout for a no-change worktree → `text.trim().length > 0` is `false` → `passed:false`. Confirm a no-change isolated agent yields `passed:false, available:true` (a true `verify_failed`), and a changed isolated agent yields `passed:true`. If the test reveals arm (1) misclassifies (it should not), the fix stays within `:1311-1326` (e.g. ensure `git diff` is run, not `git diff HEAD` against the wrong ref) — but do NOT widen scope to the whole-tree diff. Keep arm (3) exactly as-is: it is the documented inert fallback and changing it would re-open the no-shell contract.

Named edge cases and handling:
- Isolated `verifyDiff:{}` agent that wrote a file: worktree `git diff` non-empty → `passed:true, available:true`. (Truthful pass.)
- Isolated `verifyDiff:{}` agent that wrote NOTHING while a sibling mutated the main tree: worktree `git diff` empty (the sibling's edits are in the MAIN tree / another worktree, invisible here) → `passed:false, available:true` → `verify_failed`. (The false-positive fix.)
- Isolated `verifyDiff:{}` agent whose worktree `git diff` shell throws: fenced `catch` → `available:false` → inert pass-through (`:1321-1325`). Never a fabricated failure.
- Unisolated `verifyDiff:{}` agent (no-shell / mint-miss from Epic 3.1): `v.directory` undefined → arm (3) `runCheckpointer.diff()` → dead checkpointer → `available:false` → inert. The whole-tree comparison NEVER produces a real verdict on this path (the checkpointer is dead whenever there is no shell), so no false positive.
- `verifyDiff:{check}` (not `{}`): unaffected — handled by the `wantsCheck` branch (`:1269-1301`), already worktree-rooted via `verifyDir` (`:1279`). Out of scope for this task (Epic 3.1 covers its isolation).

**Files:**
- Modify (only if a test reveals a misclassification): `packages/workflows/src/plugin/engine.ts:1311-1326`
- Test: `packages/workflows/src/plugin/engine.test.ts` (drive the engine's `verifyResult` via the existing fake-shell harness; assert the worktree-rooted arm and the inert fallback)

**Verification:** `bun test packages/workflows/src/plugin/engine.test.ts` — with a fake shell: (1) a `verifyResult({ verifyDiff: true, directory: "/wt" })` where `git diff` in `/wt` returns non-empty → `{passed:true, available:true}`; (2) same with `git diff` returning empty → `{passed:false, available:true}` (the verify_failed verdict); (3) `verifyResult({ verifyDiff: {} })` with NO `directory` on a dead checkpointer → `{available:false}` (inert); (4) the worktree `git diff` shell throwing → `{passed:false, available:false}` (inert, not a fabricated fail); (5) assert the worktree `git diff` was issued through `.quiet()` and bound to `cwd("/wt")`. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** an isolated `verifyDiff:{}` agent's verdict comes from its WORKTREE `git diff` (empty → `verify_failed`, non-empty → pass), provably independent of sibling main-tree mutation; the whole-tree `runCheckpointer.diff()` arm fires only on the no-shell/mint-miss path where it is inert (`available:false`); all four behavioral arms are pinned by tests; no change widens the inert no-shell fallback.

---

## Phase 4 — Abandoned-run checkpoint residue (Issue 1)

**Milestone:** A failed, cancelled, or aborted run no longer leaves permanent checkpoint commits interleaved in the working branch's history; the operator can tell which commits belong to a run that actually completed.

**Root cause (confirmed):** Checkpoints commit directly onto the working-branch HEAD (`git-checkpoint.ts:373`; "HEAD advances, the tree is NEVER reset", `:11`), and no terminal path rolls them back — the failure path (`engine.ts:1408-1423`) and `stopRun` (`engine.ts:1456-1467`) only flip status, `drainCheckpoints()`, and finalize the feed; `drainCheckpoints` awaits the commit chain, never reverts.

### Epic 4.1: Isolate or roll back abandoned-run checkpoints

**Goal:** Checkpoints from a run that does not complete successfully do not pollute the working branch's permanent history.
**Scope:** `packages/workflows/src/plugin/git-checkpoint.ts` (a per-run ref marker advanced on each commit + a `promote()`/`discard()` terminal helper, using the already-exposed `baselineRef()` at `:479` and the unchanged scoped commit at `:433-434`), `packages/workflows/src/plugin/engine.ts` (the settle branch's terminal arms at `:1502-1551`, where the per-run `runCheckpointer` + `runId` are in scope — NOT `stopRun` at `:1584-1595`, which cannot reach the per-run closure; cancel flows through the settle `else` arm).
**Dependencies:** Phase 1 (faithful checkpoints — already landed; `checkpoint()` now captures already-staged deletions at `git-checkpoint.ts:398-414`, so a rewind/discard operates on complete snapshots).
**Done when:** after a failed/cancelled run, `git log` on the working branch shows no checkpoint commits from that run; the on-disk working tree is unchanged (the abandoned run's edits survive as uncommitted changes — non-destructive); a successful run's checkpoints stay on the working branch exactly as today.

**Design fork — RESOLVED at elaboration to the branch-rewind realization of option (a), with the literal "HEAD never advances during the run" deviation surfaced for the user (default: implement the rewind):**

The CHOSEN APPROACH is "per-run ref, promote on success only; the working-branch HEAD does NOT advance during the run; edits remain on disk." The literal reading — HEAD never advancing during the run — is achievable ONLY by `git commit-tree` plumbing (build the commit object from a tree and parent it on the per-run ref, never touching the branch). But `commit-tree` commits a WHOLE tree (`git write-tree` of the index); it CANNOT scope to pathspecs the way the current `git commit -- <staged>` does. That scoping is load-bearing: it is the refuse-don't-stomp guarantee that keeps an operator's PRE-STAGED content out of an engine commit (pinned by `git-checkpoint.test.ts:406` "scopes the commit to the exact staged pathspecs, never sweeping pre-staged operator content"). A `commit-tree`/`write-tree` rewrite would regress that Phase-1/operator-safety guarantee. The detached-HEAD alternative is worse: `git checkout`/`switch`/`reset --hard` all MUTATE the working tree, destroying the on-disk edits that dependent agents read.

So this plan implements the **branch-rewind realization**, which preserves every existing guarantee and achieves the *observable* goal (no abandoned commits in `git log`), differing from the literal spec only in WHEN HEAD moves:
- **During the run:** checkpoints commit on the working branch exactly as today (the scoped `git commit -- <staged>` at `:433-434` is UNCHANGED — scoping, chaining, and dependent-agent visibility all preserved). The working-branch HEAD genuinely advances commit-by-commit. After each commit, a per-run ref marker `refs/wf-checkpoints/<runId>` is advanced to the new HEAD (a cheap `git update-ref`, additive — it does not change the commit mechanics).
- **On SUCCESS terminal:** the commits are already on the branch (promotion is a no-op); delete the marker ref. HEAD stays advanced — the correct end state for a completed run.
- **On FAILURE / ABORT / CANCEL terminal:** `git update-ref <currentBranchRef> <baselineRef()>` rewinds the branch pointer to the run-start HEAD. This is NON-destructive: it moves ONLY the ref, never the index or working tree (it is NOT `git reset --hard` — the rejected destructive alternative), so the abandoned run's edits survive on disk as uncommitted changes. The orphaned commits are then reachable only via the marker ref; deleting `refs/wf-checkpoints/<runId>` makes them unreachable → GC'd → gone from `git log`.

> **DECISION NEEDED FROM USER (do not silently default):** the rewind moves HEAD during the run (then rewinds on failure) rather than never moving it. Options: (a) the branch-rewind realization above [Recommended — preserves the scoped-commit refuse-don't-stomp guarantee, non-destructive to the tree, observable goal met; deviates only in HEAD-timing]; (b) a true `commit-tree`/per-run-ref build that never touches the branch [matches the literal spec, but regresses the scoped-pathspec operator-safety guarantee — a `write-tree` of the index can sweep pre-staged operator content into an engine commit; would need a fresh per-run index file via `GIT_INDEX_FILE` to re-scope, a markedly larger change]; (c) leave commits inline and only ADD the failure-path rewind without a marker ref [smaller, but loses the per-run forensic ref the operator can inspect before GC]. Default if no answer: (a). The rewind is gated STRICTLY on a non-`completed` terminal status AND a non-null `baselineRef()`; it never fires on success and never on a no-shell/zero-commit repo.

> **Operator-layering guard (named risk):** the failure-path rewind `update-ref <branch> <baselineRef>` blindly repointing the branch to baseline would DISCARD any commit an operator (or a concurrent process) layered onto the branch AFTER the run's checkpoints. Task 4.1.2 fences this: it rewinds ONLY when the branch tip is still the run's own marker tip (`refs/wf-checkpoints/<runId>` == current branch HEAD) — i.e. nothing was layered on top. If the tips diverge (operator committed, or another run interleaved), it SKIPS the rewind, deletes the marker, and warns with the residue SHAs so the operator can decide (this is the `ISSUES.md` Issue 1 "surface which commits were left behind" fallback). This makes the rewind safe-by-construction.

#### Task 4.1.1: Advance a per-run ref marker on each checkpoint commit + add `promote()`/`discard()` to the checkpointer

- [ ] Done

**Context:** `checkpoint()` (`git-checkpoint.ts:351-471`) commits scoped pathspecs onto the working branch via `git -c user.name=… -c user.email=… commit --no-verify -m <message> -- <staged>` (`:433-434`) and reads back the new sha at `:447-448`. The working branch HEAD advances per commit (the header's "HEAD advances, the tree is NEVER reset", `:10-11`). `baselineRef()` (`:479`) returns the run-start HEAD captured by `baseline()` (`:316-326`; null in a zero-commit repo). NO terminal path rewinds these commits today (the engine's settle branch only flips status, drains the chain, and finalizes the feed — `engine.ts:1502-1551`), so an abandoned run's commits are permanent `git log` noise (`ISSUES.md` Issue 1). The `Checkpointer` interface (`:107-126`) and `CheckpointMeta` (`:57-66`) already carry `runId`. All git plumbing MUST use the fenced `git()` + `.quiet()` pattern (host-fd reason documented at `:25-41` / the `git` factory at `:279`); never introduce an un-quieted call.

**Implementation vision:** Three additions to `git-checkpoint.ts`, all reusing the existing `git()` fence:

1. **A per-run ref constant + helper.** Add a module-level `const WF_CHECKPOINT_REF_PREFIX = "refs/wf-checkpoints/";` and a tiny pure helper `export function checkpointRefFor(runId: string): string` returning `` `${WF_CHECKPOINT_REF_PREFIX}${runId}` `` (exported for unit assertion; the runId is engine-generated `wf_…`, ref-name-safe). The ref name is derived from the `runId` already present in `CheckpointMeta`/`baseline`'s closure — store the `runId` on a closure var captured at the FIRST `checkpoint()`/`baseline()` call. Decision: capture `runId` at `baseline()` is impossible (baseline takes no meta); instead capture it lazily on the first `checkpoint(meta)` into a `let ownRunId: string | undefined` closure var, used by `promote`/`discard`. (Rationale: `baseline()` has no runId; `checkpoint()` is the first call that does, and `promote`/`discard` only run AFTER at least one terminal, by which point either a checkpoint ran — `ownRunId` set — or none did — `ownRunId` undefined → promote/discard are no-ops, correct: nothing to clean.)

2. **Advance the marker after each successful commit.** In `checkpoint()`, AFTER the sha read-back (`:447-448`) and only when `sha !== undefined`, run a fenced `git()`\``git update-ref ${checkpointRefFor(meta.runId)} ${sha}`\`.quiet() and set `ownRunId = meta.runId`. A non-zero exit is fenced (logged at `debug`, never thrown — the marker is forensic, its failure must not fail a checkpoint that already committed). Place it beside the existing mode-flips read-back (`:455-462`) so the result assembly at `:464-470` is untouched.

3. **`promote()` and `discard()` on the `Checkpointer` interface.** Add to the interface (`:107-126`) and the returned object (`:473-481`):
   - `promote(): Promise<void>` — the SUCCESS terminal. The commits are already on the branch; promotion only removes the now-redundant marker. Fenced: when `ownRunId === undefined` (no commits this run) → no-op; else `git()`\``git update-ref -d ${checkpointRefFor(ownRunId)}`\`.quiet() (a non-zero exit — e.g. the ref never existed because every checkpoint's sha read-back failed — is fenced and logged at `debug`). NEVER touches the branch.
   - `discard(): Promise<void>` — the FAILURE/ABORT/CANCEL terminal. Fenced throughout; resolves even on a dead/no-shell checkpointer (no-op). Logic: if `dead` or `ownRunId === undefined` → no-op. Else: (a) read the current branch tip `git()`\``git rev-parse HEAD`\`.quiet(); (b) read the marker tip `git()`\``git rev-parse ${checkpointRefFor(ownRunId)}`\`.quiet(); (c) the OPERATOR-LAYERING GUARD: rewind ONLY when `baselineRef() !== null` AND the marker tip read succeeded AND `branchTip === markerTip` (nothing layered on top since the run's last checkpoint). When the guard passes: `git()`\``git update-ref HEAD ${baselineRef()}`\`.quiet() (rewinds the branch pointer to the run-start baseline — NON-destructive: the index/working tree are untouched, the edits survive on disk as uncommitted changes; `update-ref HEAD <sha>` moves the symref target's branch without `--no-deref` so it follows the checked-out branch). When the guard FAILS (tips diverge → operator/other-run layered work, OR baseline null): SKIP the rewind and `logger?.warn` naming the marker SHA(s) left behind (the `ISSUES.md` Issue 1 "surface which commits were left behind" path). (d) ALWAYS (guard pass or fail) delete the marker: `git()`\``git update-ref -d ${checkpointRefFor(ownRunId)}`\`.quiet(), fenced.

Reuse the existing `git()`, `.quiet()`, `readText`, `dead`, `logger`, and `baselineRef`/`baselineHead` closure exactly. Do NOT add `git add -A`, `git reset`, `git checkout`, `git stash`, or any tree-mutating command — the discard moves refs ONLY.

Named edge cases and handling:
- Successful run with N committed checkpoints: marker advanced N times; `promote()` deletes the marker; the N commits stay on the branch. (Unchanged history for success.)
- Failed run, no operator layering (marker tip == branch tip): `discard()` rewinds the branch to baseline, deletes the marker; `git log` clean of the run's commits; tree edits survive on disk. (The fix.)
- Failed run, operator layered a commit on top (branch tip != marker tip): `discard()` SKIPS the rewind (would discard the operator's commit), deletes the marker, warns with the residue SHAs. Non-destructive, surfaced. (The layering guard.)
- Run with ZERO committed checkpoints (every agent empty-diff, or all refused): `ownRunId` stays undefined → both `promote()` and `discard()` are no-ops; marker never created. (No spurious ref ops.)
- A checkpoint whose sha read-back failed (`sha === undefined` at `:448`): the marker is NOT advanced for that commit (no sha to point at); but `ownRunId` is set on the FIRST sha-bearing commit. If EVERY commit's sha read-back failed, `ownRunId` stays unset → discard is a no-op AND the (uncommittable-to-track) commits remain — honest: without a sha the engine cannot build the marker, so it cannot safely rewind (it does not know the chain tip). Documented as a degraded-but-safe case.
- Zero-commit repo (`baselineRef()` null): `discard()`'s guard fails on `baselineRef() === null` → SKIP rewind (no baseline to rewind TO), delete marker, warn. (Cannot rewind below the root.)
- Dead / no-shell checkpointer: `promote`/`discard` short-circuit to no-op (the `dead` latch), parity with every other method.
- Marker tip read fails (ref missing — e.g. a transient `update-ref` failure earlier): guard fails → SKIP rewind, warn. Safe (never rewinds on uncertain state).

**Files:**
- Modify: `packages/workflows/src/plugin/git-checkpoint.ts:107-126` (add `promote`/`discard` to the `Checkpointer` interface), `:194` area (add `checkpointRefFor` + the ref-prefix constant near `parseModeFlips`), `:447-462` (advance the marker after sha read-back; set `ownRunId`), `:473-481` (implement + return `promote`/`discard`; add the `ownRunId` closure var near `baselineHead` at `:262`)
- Test: `packages/workflows/src/plugin/git-checkpoint.test.ts` (extend the fake-shell harness; the suite is entirely fake-shell — `makeShell`/`liveCheckpointer` at `:34-82`/`:319-334`, asserting the exact reconstructed git command strings — there are NO real-git temp repos in this file, so verification asserts the issued commands + canned outputs)

**Verification:** `bun test packages/workflows/src/plugin/git-checkpoint.test.ts` — add a `describe("createGitCheckpointer — per-run ref marker / promote / discard")` with cases driven through `liveCheckpointer`: (1) a successful `checkpoint()` (status dirty → add → commit → `rev-parse HEAD` → `sha_x`) issues `git update-ref refs/wf-checkpoints/wf_1 sha_x` and that command went through `.quiet()` (assert via the harness's `quietedCommands`); (2) after a checkpoint, `promote()` issues `git update-ref -d refs/wf-checkpoints/wf_1` and NO `update-ref HEAD …` rewind; (3) after a checkpoint, `discard()` with `rev-parse HEAD` and `rev-parse refs/wf-checkpoints/wf_1` BOTH returning the same `sha_x` issues `git update-ref HEAD <baseline>` (the baseline from `baseline()`'s stubbed `rev-parse HEAD`) THEN `git update-ref -d refs/wf-checkpoints/wf_1`; (4) `discard()` where `rev-parse HEAD` returns `operator_sha` but the marker returns `sha_x` (divergence) issues NO `update-ref HEAD` rewind, DOES delete the marker, and warns naming `sha_x`; (5) `discard()`/`promote()` on a checkpointer with no prior commit (`ownRunId` unset) issue NO `update-ref` at all; (6) `discard()` on a zero-commit repo (`baselineRef()` null) issues no rewind, deletes the marker, warns; (7) `checkpointRefFor("wf_abc")` === `"refs/wf-checkpoints/wf_abc"`. Then `bun run typecheck` and `bun run lint` clean.

**Done when:** every sha-bearing checkpoint advances `refs/wf-checkpoints/<runId>` via a fenced+quieted `git update-ref`; `promote()` deletes the marker and never touches the branch; `discard()` rewinds the branch to `baselineRef()` ONLY when the marker tip still equals the branch tip and a baseline exists (else skips + warns with the residue SHAs), then always deletes the marker, and is non-destructive to the index/working tree on every path; zero-commit/dead/no-shell/no-checkpoint cases are no-ops; the two pure additions (`checkpointRefFor`, the marker) are command-asserted; all new git calls are `.quiet()`.

#### Task 4.1.2: Call `promote()` on success and `discard()` on every non-success terminal in the settle branch

- [ ] Done

**Context:** The detached settle branch in `startRun` (`engine.ts:1496-1551`) is the single seam where a run's terminal status is known AND the per-run `runCheckpointer` (`:1105`) + `runId` are in closure scope. It has three arms: the success `.then` (`:1502-1535`, where `result.status` is the run's terminal verdict and `handle.record.status === "running"` distinguishes a clean settle from a stopRun-pre-flipped cancel), and the defensive `.catch` (`:1536-1551`, a thrown run → `error`). `drainCheckpoints()` (`:1469-1473`) awaits the per-run commit chain; it is called BEFORE `finalizeFeed` on both arms (`:1528`/`:1549`) so `run:end` stays the terminal feed line. `stopRun` (`:1584-1595`) only flips the record to `cancelled` and calls `abort()`; the aborted agents' `agent:end` events then flush through `onProgress` (enqueuing their checkpoints) and the settle branch's `.then` runs with `handle.record.status !== "running"` → the `else` arm (`:1519-1523`). So a CANCEL is observable in the settle branch as a non-`completed`/non-`running` terminal status — promote/discard belongs HERE, not in `stopRun` (which cannot reach `runCheckpointer`). The success determinant is `result.status === "completed"`; everything else (`error`, `cancelled`) is non-success.

**Implementation vision:** Add a fenced terminal helper inside `startRun` beside `drainCheckpoints` (`:1469-1473`):
```
/** Promote (success) or discard (abandoned) this run's checkpoint commits (Epic 4.1). Fenced. */
const settleCheckpoints = (terminalStatus: string): Promise<void> =>
  (terminalStatus === "completed"
    ? runCheckpointer.promote()
    : runCheckpointer.discard()
  ).then(() => undefined, () => undefined);
```
Wire it on BOTH arms, AFTER `await drainCheckpoints()` (the chain must fully drain so every commit — including a cancel's last in-flight agent's — has landed and the marker is at the true tip) and BEFORE `await finalizeFeed(...)` (so the ref op completes before the terminal feed line; ordering parity with the existing drain-then-finalize discipline):
- Success `.then` (after `:1528`): `await settleCheckpoints(handle.record.status);` — on a clean completion `handle.record.status` is `result.status` (set by `settleRecord`); on a stopRun-pre-flipped cancel it is `cancelled` → `discard()`. Use `handle.record.status` (NOT `result.status`) so a cancel that pre-flipped the record correctly routes to `discard()` even though `result.status` may read `completed`/`cancelled` from the run body. (The record status is the authoritative terminal verdict after the cancel pre-flip.)
- `.catch` (after `:1549`): `await settleCheckpoints("error");` — a thrown run is always non-success → `discard()`. (`handle.record.status` is `error` here too when it was `running`; passing the literal `"error"` is equally correct and explicit.)

Do NOT modify `stopRun` (`:1584-1595`): it stays the cancel authority that flips status + aborts; the discard rides the settle branch the abort drains into. Do NOT modify `drainCheckpoints` (it awaits the chain; promote/discard runs after it). The per-run-ref marker and the promote/discard logic all live in the checkpointer (Task 4.1.1); the engine only sequences the terminal call.

Named edge cases and handling:
- Clean completed run: `handle.record.status === "completed"` → `promote()` → marker deleted, commits stay on the branch. (Unchanged success behavior.)
- Errored run (the run body threw or returned `error`): `error` → `discard()` → branch rewound to baseline (guard permitting), commits GC'd, tree preserved.
- stopRun cancel: record pre-flipped to `cancelled`; the settle `.then` runs the `else` re-persist arm, drains the now-enqueued aborted-agent checkpoints, then `settleCheckpoints("cancelled")` → `discard()`. (The abandoned cancel's checkpoints are rewound — the Issue 1 fix for the abort path.)
- Defensive `.catch` (run rejected — should never happen, `run.run()` does not reject, but fenced): `discard()`. Safe.
- No-shell / dead checkpointer: `promote`/`discard` are no-ops (the `dead` latch in Task 4.1.1) — the settle call resolves harmlessly. The engine path is identical with or without git.
- A run with zero checkpoints: `ownRunId` unset in the checkpointer → promote/discard no-op. The settle call still runs (cheap, fenced).
- Ordering: `settleCheckpoints` is awaited AFTER `drainCheckpoints` and BEFORE `finalizeFeed`, so (a) the marker is at the chain's true tip before discard reads it, and (b) the ref op finishes before `run:end`. Fenced so a ref-op failure can never fail the run or block the feed's terminal line.

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts:1469-1473` (add `settleCheckpoints` beside `drainCheckpoints`), `:1528` (await `settleCheckpoints(handle.record.status)` after `drainCheckpoints` on the success `.then`), `:1549` (await `settleCheckpoints("error")` after `drainCheckpoints` on the `.catch`)
- Test: `packages/workflows/src/plugin/engine.test.ts` (drive a full run through the `makeGitRepo` fake-shell harness at `:249-402`, which records `commits` and every reconstructed git command; extend it to record `update-ref` ops)

**Verification:** `bun test packages/workflows/src/plugin/engine.test.ts` — using the `makeGitRepo` harness: (1) a run whose workflow body completes (`status:"completed"`) with one dirty-then-committed agent issues `git update-ref refs/wf-checkpoints/<runId> <sha>` during the run AND `git update-ref -d refs/wf-checkpoints/<runId>` at settle, with NO `update-ref HEAD` rewind (promote path); (2) a run whose body errors issues the during-run marker advance AND, at settle, a `git update-ref HEAD <baseline>` rewind THEN the marker delete (discard path, guard passing because the fake's branch tip == marker tip); (3) a cancelled run (drive `stopRun(runId)` mid-flight, then let the settle drain) issues the discard rewind + marker delete; (4) a completed run with NO agent edits (no commits) issues NO `update-ref` ops at settle (promote no-op); (5) a non-git engine (`makeGitRepo({isRepo:false})`) completes/errors without any `update-ref` op and without throwing. Assert ordering: the marker delete / rewind appears AFTER the last `commit --no-verify` and BEFORE the run settles (the harness's command order). Then `bun run typecheck` and `bun run lint` clean.

**Done when:** a completed run calls `promote()` (marker deleted, branch untouched) at settle; an errored/cancelled/thrown run calls `discard()` (branch rewound to baseline when the guard passes, marker deleted) at settle; both run AFTER `drainCheckpoints` and BEFORE `finalizeFeed`; `stopRun` is unchanged; the terminal call is fenced so a ref-op failure never fails the run; a non-git engine is a clean no-op; the during-run marker advance and the terminal promote/discard are command-asserted across completed, errored, cancelled, no-commit, and non-git runs.

---

## Self-Review

- **Spec coverage:** Issue 1 → Phase 4 (Epic 4.1). Issue 2 → Phase 3 (Epics 3.1, 3.2). Issue 3 → Phase 1 (Epic 1.1). Issue 4 → Phase 2 (Epic 2.2). Issue 5 → Phase 2 (Epic 2.1). Issue 6 → Phase 2 (Epic 2.4, observability half) + Epic 2.1 (filesChanged-ghost half) + explicit user-flag for the structural half. Issue 7 → Phase 2 (Epic 2.3). The `ISSUES.md` "Meta note" (surface run commits, post-run tree cleanliness, true-vs-stale `verify_failed` in `workflow_status --full`) is covered by Epics 2.2, 2.1, and 3.1 respectively. No gaps.
- **Vagueness scan:** Phase 1 (the only detailed wave) names every edge case with its handling and gives exact `file:line` targets and concrete verification cases; no "appropriate"/"TBD"/unnamed-edge language. Later phases carry deferrals deliberately (rolling wave), and the two design forks are flagged as needing user input rather than hand-waved.
- **Contract consistency:** the `RunRecord` git-truth surface (`filesChanged`, the checkpoint ledger with `sha`/`paths`/`label`/`phase`, mode-flip tags) is introduced in Epic 2.1, extended in 2.2, and tagged in 2.3 — one surface, three epics, no conflicting shapes. The `agent:checkpoint` feed line and `CheckpointResult` are the single source feeding it.
- **Phase boundaries:** Phase 1 ends with faithful checkpoints (testable in isolation). Phase 2 ends with truthful status surfaces. Phase 3 ends with correct per-agent verify. Phase 4 ends with clean abandoned-run history. Each is shippable alone.
- **Verification plausibility:** `bun test <path>`, `bun run typecheck`, `bun run lint` are the repo's real scripts (`package.json`); `git-checkpoint.test.ts` and the other referenced test files exist.
