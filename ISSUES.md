# ISSUES

Observations from running the workflow engine on a real, heavy multi-agent job
(`wf_8q6kkzy1` — 15 agents, 4 phases, 15m51s, Matcher frontend red/yellow fixes).
The per-agent checkpoint-commit feature is new and worked: an earlier run of the
same script (`wf_7dpt49ht`) lost all work to a mid-run restart because nothing was
committed; this run would have survived one. These are the rough edges found while
verifying the result against git/disk truth. Raw notes — to be distilled.

---

## Issue 1 — Cross-run checkpoint residue pollutes `git log`

**Severity:** medium (history hygiene / operator confusion)

**What happened:**
The failed run `wf_7dpt49ht` left 3 checkpoint commits in the working branch's
history that I had previously believed were gone (the working *tree* was clean
after the restart, so `git status` showed nothing — but `git log` did not):

```
197a97fc workflow checkpoint: run=wf_7dpt49ht agent=kill dayjs ...
df536fb6 workflow checkpoint: run=wf_7dpt49ht agent=lodash -> native ...
f45b98f7 workflow checkpoint: run=wf_7dpt49ht agent=config: coverage+a11y+csp ...
```

These sit interleaved with the successful `wf_8q6kkzy1` checkpoints in the same
branch. A failed/aborted run's checkpoints are now permanent history noise.

**Why it matters:**
- `git log` becomes a diary of every attempt, including the dead ones.
- An operator inspecting history can't tell at a glance which checkpoints belong
  to the run that actually completed vs. an abandoned one.
- The "clean working tree" after the failed restart was misleading — it implied
  nothing happened, when in fact 3 commits had landed on the branch.

**Possible directions (not prescriptive):**
- Isolate checkpoints on a per-run ref/branch (e.g. `refs/opencode/wf_<id>`)
  instead of the working branch, and only fast-forward/squash onto the working
  branch on successful completion.
- On run failure/abort, offer to roll back (or clearly tag) that run's
  checkpoints rather than leaving them inline.
- At minimum, make the failure message surface *which commits* were left behind
  so the operator can decide, instead of only saying "inspect git status"
  (git status was empty; the evidence was in git log).

---

## Issue 2 — `verifyDiff` produces false negatives under intra-phase parallelism

**Severity:** high (correctness of reported result vs. reality)

**What happened:**
Three Phase-1 agents were reported `ok:false` / `verify_failed`
(git/command post-condition failed):

```
result.phase1: lodash ok:false, dayjs ok:false, i18n ok:false
diagnostics: [verify_failed] i18n ... / lodash ... / kill dayjs ...
```

But all three had actually landed correctly and were independently verified after
the run:
- `dayjs`, `lodash`, `@types/lodash` removed from `package.json` ✓
- `scripts/check-i18n-parity.mjs` present and exits 0 (2116 keys parity) ✓
- full suite green: `tsc` clean, lint 0 errors, 278 tests pass ✓

**Root cause (hypothesis):**
Each of these agents ran its `verifyDiff` check (`pnpm typecheck` / `pnpm lint`)
while *other agents in the same `parallel()` phase were still mutating the working
tree*. The check observed a transient, mid-flight state of the repo — not the
agent's own isolated result — and failed on someone else's half-written change.

`verifyDiff` downgrades the result to `null` on failure but does NOT revert the
agent's disk writes, so the work survived; the only damage was a **lying result
object** (`ok:false` for work that succeeded). A consumer trusting `result` would
wrongly conclude these fixes failed.

**Why it matters:**
- The whole point of `verifyDiff` is to assert disk/command truth. A false
  negative here is worse than no check — it actively misreports success as
  failure.
- It undermines trust in the `result` payload; I had to go verify everything by
  hand against git + disk, which defeats the purpose of the post-condition.

**Possible directions:**
- Run a parallel agent's `verifyDiff` against an **isolated view** of *that
  agent's* changes (e.g. against its own checkpoint commit / worktree), not
  against the shared mutating tree.
- Or: defer `verifyDiff` for `parallel()`-grouped agents until the phase barrier,
  and run each against the post-phase state — accepting that this checks
  "phase is consistent" rather than "this one agent is consistent".
- Or: scope the check command to the agent's touched paths where the tool allows
  (e.g. `pnpm test <agent's files>` already does this; whole-tree `typecheck`
  does not and is the main offender — a single typecheck sees the whole repo).
- Document clearly that whole-repo checks (`typecheck`) are unsafe as per-agent
  `verifyDiff` inside `parallel()`, and steer toward scoped checks.

---

## Issue 3 — Checkpoint commits miss file deletions

**Severity:** medium (incomplete checkpoint → manual cleanup required)

**What happened:**
The `domain/ cleanup (Option A)` agent deleted 21 files
(`src/domain/*-entity.ts`, `pagination-entity.ts`, moved `state-machine.ts`).
Its checkpoint commit (`4fceb103`) captured the *additions/modifications* (the
moved `state-machine.ts` in `lib/`, updated importers) but left the 21 deletions
**staged-but-uncommitted** in the index. After the run completed, `git status`
showed 21 pending `D` entries that I had to commit manually to get a clean tree.

```
D  ui/src/domain/matcher-actor-mapping-entity.ts
D  ui/src/domain/matcher-adjustment-entity.ts
... (21 total)
```

**Root cause (hypothesis):**
The checkpoint staging step appears to stage new/modified files but not removals
— likely a `git add <paths>` / `git add .` that doesn't capture deletions, rather
than `git add -A` (or `git add -u`).

**Why it matters:**
- The checkpoint is not a faithful snapshot of the agent's result — a restart
  immediately after this checkpoint would have *resurrected* the 21 deleted files
  (they'd be back on disk, un-deleted), partially undoing the cleanup.
- It silently requires manual finalization after a "successful" run, which is
  exactly the kind of hidden state the checkpoint feature is meant to eliminate.

**Possible directions:**
- Use `git add -A` (stage adds, modifies, AND deletes) for checkpoint staging.
- Add a post-checkpoint assertion that `git status --short` is empty for the
  agent's declared touched paths — if not, the checkpoint is incomplete.

---

## Issue 4 — `workflow_status` says “No commit was created” while checkpoint commits exist

**Severity:** high (operator trust / git safety)

**What happened:**
During the Matcher UI parity execution, `workflow_status --full` for the Phase 3
workflow reported:

```
wf_mna7lden result.notes: ["No commit was created, per request."]
wf_mna7lden result.filesChanged: ["docs/plans/2026-06-09-matcher-ui-parity-100.md"]
```

But `git log --oneline -8` in the Matcher repo showed checkpoint commits created
by that same workflow:

```
2c63f553 workflow checkpoint: run=wf_mna7lden agent=task-3-3-2-final-bundle ...
29da8261 workflow checkpoint: run=wf_mna7lden agent=task-3-3-1-discovery-contract ...
98326c4b workflow checkpoint: run=wf_mna7lden agent=task-3-2-2-fee-schedule-limits ...
b0fcbf60 workflow checkpoint: run=wf_mna7lden agent=task-3-2-1-fee-rules-tab ...
e13bb739 workflow checkpoint: run=wf_mna7lden agent=task-3-1-4-context-surface ...
908ea7d3 workflow checkpoint: run=wf_mna7lden agent=task-3-1-3-schedules-tab ...
e14df14f workflow checkpoint: run=wf_mna7lden agent=task-3-1-2-existing-tab-tests ...
cf5c6167 workflow checkpoint: run=wf_mna7lden agent=task-3-1-1-source-contract ...
```

The workflow was explicitly prompted with “Do not commit”, so either:
- checkpoint commits are expected engine behavior and the result note is wrong,
- or the engine violated the requested no-commit constraint.

Either way, the operator-facing status lied about the most important mutable
state: git history.

**Why it matters:**
- “No commit was created” is a safety claim. If false, it can make an operator
  continue work on top of unexpected history.
- `filesChanged` being reduced to the plan file hid the actual code changes,
  which were present in checkpoint commits rather than the working tree.
- The only reliable way to reconcile the run was manual `git log`, `git status`,
  file inspection, and re-running gates.

**Possible directions:**
- Make checkpoint commits explicit in `workflow_status` regardless of agent
  prompt wording: list commit SHA, agent, phase, and whether the commit is a
  checkpoint vs. user-requested final commit.
- Do not allow result synthesis agents to claim “No commit was created” unless
  the engine injects git-truth into the final status.
- Distinguish “no final user commit was created” from “checkpoint commits were
  created”. The current wording collapses two very different facts.

---

## Issue 5 — `filesChanged` in workflow results is incomplete and misleading

**Severity:** high (result correctness / auditability)

**What happened:**
In multiple Matcher UI parity workflows, the final structured result claimed only
the plan file changed:

```
wf_ff3goj56 result.filesChanged: ["docs/plans/2026-06-09-matcher-ui-parity-100.md"]
wf_mna7lden result.filesChanged: ["docs/plans/2026-06-09-matcher-ui-parity-100.md"]
```

But the completed work included route files, UI components, tests, generated route
tree updates, API contract tests, and docs. Examples observed on disk after the
run:

```
ui/src/routes/matcher.studio.sources.tsx
ui/src/routes/matcher.studio.rules.tsx
ui/src/routes/matcher.reconciliation.contexts.new.tsx
ui/src/components/context-setup/schedules-tab.tsx
ui/src/components/context-setup/fee-rules-tab.tsx
ui/src/api/sources.test.tsx
ui/src/api/schedules.test.tsx
ui/src/components/context-setup/*-tab.test.tsx
```

The code was real — route parity, a11y smoke, UI contract tests, typecheck, lint,
and backend unit tests passed. The structured result was the broken part.

**Why it matters:**
- `filesChanged` is used as the operator’s first-pass audit surface. If it omits
  nearly all code changes, it is worse than absent.
- A reviewer could wrongly assume the workflow only updated a plan and skip code
  review entirely.
- This forces manual reconciliation via git/disk/test commands after every
  workflow, defeating the purpose of structured results.

**Possible directions:**
- Populate `filesChanged` from git truth (`git diff --name-status` plus
  checkpoint commit file lists), not from agent self-report.
- Include both working-tree changes and checkpoint-commit changes.
- Add a status warning when agent-reported `filesChanged` disagrees with git
  truth.

---

## Issue 6 — Ignored plan files create “ghost source of truth” behavior

**Severity:** medium (operator confusion / reproducibility)

**What happened:**
The live rolling-wave plan for Matcher UI parity was written to:

```
docs/plans/2026-06-09-matcher-ui-parity-100.md
```

That path is ignored by the Matcher repo:

```
.gitignore:47:docs/plans/
```

The main session could read and patch the file, but subagents sometimes reported
that the file or `docs/plans/` did not exist. Meanwhile, the workflow checkpoint
and `filesChanged` surfaces referenced the ignored file as if it were the primary
changed artifact.

**Why it matters:**
- The workflow can treat an ignored, untracked file as the living source of truth,
  but the file will not travel with the branch and may not be visible to agents
  depending on their checkout/sandbox behavior.
- `git status` does not show it, so an operator can believe the plan was saved
  when it is actually a local ghost file.
- Subagents may fail plan review because the ignored plan is unavailable, causing
  false blockers unrelated to the task.

**Possible directions:**
- Warn when a workflow script references a plan/spec file that is ignored by git.
- Include ignored referenced files in `workflow_status` diagnostics: tracked,
  ignored, untracked, or missing from agent sandbox.
- If a workflow uses an ignored file as source-of-truth, require explicit opt-in
  or suggest a tracked path.

---

## Issue 7 — Executability/mode changes are easy to miss in workflow evidence

**Severity:** medium (release gate reliability)

**What happened:**
In the Phase 1 Matcher UI parity workflow (`wf_5549jqh5`), the release-bundle
guard stopped on:

```
./scripts/check-ui-production-bundle.sh: permission denied
```

The actual fix was a file-mode change:

```
chmod +x scripts/check-ui-production-bundle.sh
```

After that, the guard passed. The final tracked status showed only:

```
M scripts/check-ui-production-bundle.sh
```

which is a mode-only change in practice, but the workflow result did not make the
mode change prominent as the reason the gate was unblocked.

**Why it matters:**
- A script can be content-identical but still fail every CI/local release gate due
  to mode bits.
- Standard `filesChanged` output does not distinguish content edits from mode
  changes, so reviewers can miss why a file changed.
- The operator had to rerun the guard manually to prove the mode fix.

**Possible directions:**
- Surface mode-only changes explicitly in workflow status and file summaries
  (`100644 -> 100755`).
- When a command fails with `permission denied` for a repo script, suggest or
  perform a mode-check diagnostic (`git diff --summary`, `ls -l`).
- Include mode changes in checkpoint/file-change summaries, not just paths.

---

## Meta note

The tool *surface* (the `workflow` / `workflow_status` / `workflow_stop` schemas)
is unchanged from before the plugin update — these issues live in the engine
(checkpointing + verifyDiff timing), and were only discoverable by inspecting
`git log` / `git status` / re-running the gate by hand. Consider surfacing more of
this engine state in `workflow_status --full` so an operator doesn't have to drop
to git to reconcile the reported result with reality:
- which commits a run created (and which are residue from prior failed runs),
- whether the working tree is clean or has pending changes after completion,
- whether any `verify_failed` was a true failure vs. a stale-tree false negative.
