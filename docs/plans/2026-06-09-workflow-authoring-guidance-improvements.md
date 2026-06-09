# Workflow Authoring-Guidance Improvements — Implementation Plan

> **For implementers:** Use ring:executing-plans (rolling wave: implement the
> detailed phase → user checkpoint → detail the next phase → implement → repeat).
> This document is the living source of truth — task elaboration for later
> phases is written back into it during execution.

**Goal:** Raise the floor of LLM-authored workflow scripts so they reliably use this plugin's git-truth review primitives, structure gated stages, and route work to specialist agents — by fixing the authoring manual (the `workflow` tool description), adding submit-time anti-pattern nudges, and shipping a canonical multi-phase template.

**Architecture:** The `workflow` tool description (`packages/workflows/src/plugin/tools/workflow.ts:224-289`, `WORKFLOW_DESCRIPTION`) is deliberately the authoring manual — the orchestrating model reads it on every turn and writes scripts from it (the rationale is stated in the file comment at `:217-222`). Two real scripts (a Claude-Code-authored one and an opencode-session one) were compared; both omit the same things the manual under-teaches. This plan closes those gaps at three leverage points, cheapest first: (1) the manual's prose, (2) the submit-time `architectureEcho` that already runs static analysis on the script, (3) a canonical saved-workflow template + README example.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run lint` via biome), opencode plugin SDK.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | The manual teaches the five under-taught practices (disk-truth review, schema-when-you-gate, agentType-by-role, on-failure policy, a multi-phase example) | 1.1 | Detailed |
| 2 | The tool's submit-time return flags the highest-value anti-patterns while the script is still in the model's context | 2.1 | Epic-level |
| 3 | A canonical multi-phase rolling-wave workflow ships as a named template + README worked example | 3.1 | Epic-level |

**Evidence base (the comparison that motivated this plan):**
- Both compared scripts review by telling the agent to run `git diff` in Bash, instead of `contextDiff:true` — which the engine already offers and which *refuses* a review when the diff is empty (`workflow.ts:240`). This is the single biggest shared miss and it is this plugin's headline git-truth feature.
- The opencode script left `implement`/`fix` agents schema-less (free-text returns), so the orchestrator could not gate control flow on them.
- The opencode script routed each stage to a specialist `agentType` (domain engineer for impl, a parallel reviewer panel for review) — a strength the Claude-Code script missed entirely (it used the default generalist for everything). The manual mentions `agentType` only as a bare opt, never as a role-routing practice.
- Neither script acts on a failed verify/gate: both report failure and return anyway, with no stop/escalate decision — and the manual is silent on what to do.
- Both worked examples in the manual are single-phase; neither models the sequential decompose→implement→review→fix shape that real multi-phase work needs.

---

## Phase 1 — Fix the authoring manual (`WORKFLOW_DESCRIPTION`)

Pure text edits to one exported string. Highest leverage (every script-authoring turn reads it), lowest risk. The wording IS the deliverable, so the proposed text is given verbatim below (Code Snippet Policy: a model-facing manual is the exact artifact where approximation changes behavior).

### Epic 1.1: Teach the five under-taught practices

**Goal:** `WORKFLOW_DESCRIPTION` names disk-truth review as a first-class pattern, states the schema-when-you-gate rule, nudges role-based `agentType` routing, gives an on-failure policy, and includes a multi-phase example.
**Scope:** `packages/workflows/src/plugin/tools/workflow.ts` (the `WORKFLOW_DESCRIPTION` template literal only, `:224-289`).
**Dependencies:** none.
**Done when:** the description contains the five additions; `bun run typecheck`/`lint` pass; any test asserting on `WORKFLOW_DESCRIPTION` content (in `workflow.test.ts`) is updated to match.

#### Task 1.1.1: Add a `review-against-disk-truth` pattern and an agentType-by-role nudge to the Patterns section

- [ ] Done

**Context:** The Patterns section (`workflow.ts:262-270`) lists six named shapes. Authors read it (the opencode script names review/fix/verify stages), but `contextDiff`/`verifyDiff` live only in the dense `agent()` opts paragraph at `:240`, so they get skipped. `agentType` is likewise only a bare opt at `:240` — never framed as "route by role." The fix is to surface both as named guidance where authors actually look.

**Implementation vision:** Append a seventh bullet to the Patterns list, and a short routing note. Use this exact text (match the existing bullet style — `name — description.`):

```
- review-against-disk-truth — reviewers get contextDiff:true so they review the engine-computed REAL git diff (and the review is REFUSED when the diff is empty, so a reviewer can never pass on narrative-only claims); implement/fix agents get verifyDiff (verifyDiff:true asserts the unit wrote to disk; verifyDiff:{check:'<cmd>'} asserts a command exits 0). Never review by telling an agent to run `git diff` itself — contextDiff is the engine's tamper-proof channel. Code review, fix loops.
```

And, immediately after the Patterns list, add a routing note:

```
Route by role with agentType: prefer a specialist (a domain engineer for implementation, dedicated reviewer agents for review, a planning agent for decomposition) over the default generalist whenever one exists; a parallel panel of distinct reviewer agentTypes catches what one generalist misses, and a narrower panel on later rounds saves tokens.
```

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:262-270`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts` — passes (update any content snapshot/substring assertion on `WORKFLOW_DESCRIPTION`). `bun run typecheck` and `bun run lint` clean.

**Done when:** the seventh pattern and the routing note are present in `WORKFLOW_DESCRIPTION` with the exact intent above; tests green.

#### Task 1.1.2: State the schema-when-you-gate rule and an on-failure policy

- [ ] Done

**Context:** The opencode script left `implement`/`fix` schema-less and acted on nothing when its `verify` stage reported `buildPasses:false`. The manual's `agent()` entry (`:240`) explains `schema` mechanically but never says *when* it is mandatory; nothing anywhere addresses what to do on a failed post-condition. Both are decision-shaped gaps an author fills wrongly by default.

**Implementation vision:** Add one sentence to the `agent()` bullet (`:240`), right after the schema clause, and a two-sentence block after the Caps-and-failure-semantics section (`:253-255`). Exact text:

For the `agent()` bullet, append:
```
If later control flow branches on a result (a count, a pass/fail, a list to fan out over), that agent MUST have a schema — free text cannot be gated.
```

After the failure-semantics section, add a short block titled to match the existing `##` headers:
```
## Acting on failures

agent() failures and failed verifyDiff/contextDiff post-conditions degrade to null — the script keeps running unless you decide otherwise. When a stage gates downstream work, DECIDE explicitly: stop the run (throw), escalate (spawn a fix/repair agent), or record-and-continue. For SEQUENTIAL phases where phase N+1 builds on phase N's code, the default is to STOP on a red gate rather than compound onto broken work; for independent fan-out, record-and-continue and report the failures in the result.
```

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:240` (the `agent()` bullet) and after `:255`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts`; `bun run typecheck`; `bun run lint`.

**Done when:** the schema-when-you-gate sentence and the `## Acting on failures` block are present; tests green.

#### Task 1.1.3: Add a multi-phase (decompose → implement → review → fix) worked example

- [ ] Done

**Context:** Both worked examples (`:272-289`) are single-phase. The most common real ask — execute a phased plan end to end — has no model to copy, so authors reinvent the sequential-phase shape (and reinvent it without schemas or contextDiff, per the evidence base).

**Implementation vision:** Add a third worked example after the verifyDiff example (`:289`), short and self-contained, demonstrating: sequential phases, a per-phase helper, `agentType` routing, `contextDiff:true` on the reviewer, `verifyDiff` on the implementer, a schema on the gated stage, and a stop-on-red-gate decision. Keep it under ~15 lines — it is a shape, not a program. Exact example:

```
## Multi-phase example (sequential, disk-truth review, stop-on-red)

  export const meta = { name: 'run-plan', description: 'Execute phases: implement -> review -> fix', phases: [{ title: 'Implement' }, { title: 'Review' }] }
  const GATE = { type: 'object', properties: { gatesPass: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } }, required: ['gatesPass', 'findings'] }
  for (const p of args.phases) {
    phase('Implement')
    await agent('Implement phase ' + p + ' per the plan. Run the gates.', { agentType: 'domain-engineer', verifyDiff: { check: args.testCmd }, phase: 'Implement' })
    phase('Review')
    const r = await agent('Review phase ' + p + ' against the diff.', { agentType: 'code-reviewer', schema: GATE, contextDiff: true, phase: 'Review' })
    if (!r || !r.gatesPass) { log('Phase ' + p + ' red — stopping before the next phase.'); break }
  }
```

Note in one line that `agentType` names are environment-dependent (the example's `domain-engineer`/`code-reviewer` are illustrative — authors substitute the agentTypes their platform actually registers).

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:289` (append after the last example)
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts`; `bun run typecheck`; `bun run lint`. Eyeball that the example parses as valid JS (no TS annotations, no banned `Date.now`/`Math.random`).

**Done when:** the multi-phase example is present and self-consistent with the rules added in 1.1.1–1.1.2; tests green.

---

## Phase 2 — Submit-time anti-pattern nudges (`architectureEcho`)

**Milestone:** When a script is submitted, the tool's return message flags the two highest-value anti-patterns *while the model still holds the script in context* and could resubmit — turning documented guidance into enforced-at-the-door feedback.

### Epic 2.1: Heuristic nudges in the architecture echo

**Goal:** `architectureEcho` (`workflow.ts:137-170`) — which already does cheap regex static analysis and returns "detected call-sites" — also emits up-to-two short warnings: (a) gated-looking script with no `schema` anywhere, (b) review/fix-looking labels with no `contextDiff`/`verifyDiff` anywhere.
**Scope:** `packages/workflows/src/plugin/tools/workflow.ts` (`architectureEcho` only), `packages/workflows/src/plugin/tools/workflow.test.ts`.
**Dependencies:** Phase 1 (the warnings should point at the now-documented patterns by name).
**Done when:** a script using `parallel`/`pipeline` but no `schema` gets a one-line "no schema detected — gated stages need schemas" nudge; a script with `review`/`fix`/`verify` in labels/prompts but no `contextDiff`/`verifyDiff` token gets a one-line "no disk-truth review detected — see review-against-disk-truth" nudge; neither fires on scripts that already do the right thing; the existing detected-call-sites line is unchanged.
**Known risk (resolve at elaboration):** these are regex heuristics over arbitrary JS — they cannot read intent and will sometimes false-positive (a script that legitimately needs neither). Keep them advisory ("consider…"), cap at two lines, and never block submission. Decide at elaboration whether the review-token heuristic keys on labels, prompt substrings, or both, accepting that it is best-effort.

---

## Phase 3 — Canonical multi-phase template + README

**Milestone:** A named, runnable workflow demonstrating the full rolling-wave shape ships with the plugin, so authors can start from a correct skeleton instead of the manual's prose, and the README documents it.

### Epic 3.1: Ship a `rolling-wave` built-in/saved template and document it

**Goal:** A canonical multi-phase workflow (decompose → implement → review → fix → synthesize, with agentType routing, contextDiff reviewers, verifyDiff implementers, schemas on gated stages, and stop-on-red) exists as a template authors can copy or invoke by name, and the package README's reference section points to it.
**Scope:** the built-ins registry (`packages/workflows/src/plugin/builtins.ts` and any `builtin-*.ts` sibling, following the `builtin-deep-research.ts` precedent), the package README, and tests for the registry.
**Dependencies:** Phase 1 (the template embodies the documented patterns; they must be settled first to avoid drift between manual and template).
**Done when:** the template is registered and loads by name like `deep-research`; it parses and passes the engine's script validation; the README references it as the multi-phase starting point; registry tests cover its presence.
**Decision deferred to elaboration:** whether this is a true built-in (compiled into `BUILTIN_WORKFLOWS`, always available) or a documented copy-paste skeleton in the README only. Built-in = discoverable and runnable but adds a maintained surface; skeleton = zero maintenance but less discoverable. Lean built-in for parity with `deep-research`, but confirm against how much the template would need per-project customization (a template that always needs editing argues for skeleton).

---

## Self-Review

- **Spec coverage:** the five evidence-base gaps map to Phase 1 (disk-truth pattern → 1.1.1; agentType routing → 1.1.1; schema-when-you-gate → 1.1.2; on-failure policy → 1.1.2; multi-phase example → 1.1.3), reinforced at the door by Phase 2 and given a copyable skeleton by Phase 3. No gap unaddressed.
- **Vagueness scan:** Phase 1 (detailed wave) gives exact `file:line` targets and verbatim insertion text for every edit — no "appropriate"/"TBD". Phase 2/3 carry explicit deferred decisions (heuristic keying; built-in vs skeleton), which is legitimate rolling-wave deferral, not vagueness.
- **Contract consistency:** the pattern name `review-against-disk-truth` introduced in 1.1.1 is the same name Phase 2's nudge points to and the same shape Phase 3's template embodies — one vocabulary across all three phases.
- **Phase boundaries:** Phase 1 ships an improved manual (verifiable: tests + read). Phase 2 ships door-checks (verifiable: echo unit tests). Phase 3 ships a template (verifiable: registry test + load). Each stands alone.
- **Verification plausibility:** `bun test <path>`, `bun run typecheck`, `bun run lint` are the repo's real scripts; `workflow.test.ts`, `builtins.ts`, and `builtin-deep-research.ts` exist (confirmed in the tree). Implementer must check `workflow.test.ts` for existing assertions on `WORKFLOW_DESCRIPTION`/`architectureEcho` and update them in lockstep — flagged in each task's verification.
