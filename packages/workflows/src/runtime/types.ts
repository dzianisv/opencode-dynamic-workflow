/**
 * The workflow runtime phase's internal contract module (spec §3.3).
 *
 * These are the globals a workflow script body programs against once the harness
 * has bound them, plus the supporting view/event/error types the runtime layer
 * shares. The composition primitives (`pipeline`, `parallel`) are typed here with
 * permissive signatures — Task 3.2.2 implements them; this module only fixes the
 * shape the script sees.
 */

/** A single `agent()` call's options (spec §3.3 "agent() options"). */
export interface AgentOpts {
	/** Display label for the progress tree; defaults to the prompt prefix. */
	label?: string;
	/** Progress group; preferred over the global `phase()` state when set. */
	phase?: string;
	/** JSON Schema for structured output (lands in Task 3.3.2). */
	schema?: object;
	/** Model override; default is to inherit the session model. */
	model?: string;
	/** Fresh git worktree — expensive, only for parallel file mutation. */
	isolation?: "worktree";
	/** Custom subagent type from the same registry as the `Agent` tool. */
	agentType?: string;
	/**
	 * Inject the engine-computed REAL git diff (since run start) as model-only
	 * context, and refuse the review when that diff is genuinely empty (Epic 4.1).
	 * Opt-in; absent → today's behavior. For REVIEW agents: a reviewer of narrative-
	 * only claims (a phantom review of work that was never written to disk) is the
	 * #7 catastrophe this prevents. The diff rides {@link AgentOpts} INTENTIONALLY
	 * as a flag, NOT the prompt — the engine injects it as a synthetic contextPart
	 * so it never perturbs the replay {@link computeCallKey} (a contextDiff reviewer
	 * still replays its journaled verdict on resume instead of re-diffing a now-
	 * different tree). The refusal is GATED on the diff being PROVABLY empty (a live
	 * git work tree); on a no-shell / non-git checkout the review runs normally with
	 * no diff part, since emptiness cannot be proven.
	 */
	contextDiff?: boolean;
	/**
	 * Post-condition the engine checks AFTER the agent settles (Epic 4.2). When set
	 * and the check FAILS, the settled result is downgraded to `null` (so it re-runs
	 * on resume rather than journaling a hollow success). Opt-in; absent → no
	 * verification.
	 *   - `true` (or `{}`): the engine asserts the unit's GIT diff (the engine's own
	 *     working-tree delta vs the run-start baseline) is NON-EMPTY — i.e. the agent
	 *     actually wrote something to disk. `verifyDiff:{}` is IDENTICAL to `true`
	 *     (the optional `check` simply being absent), NOT a no-op.
	 *   - `{check:'<cmd>'}`: run `<cmd>` via the engine's repo-bound shell and assert
	 *     exit 0.
	 * Verifies GIT/DISK TRUTH, NOT the agent's self-report and NOT the opencode
	 * session diff (which is a point-in-time SNAPSHOT that survives an out-of-band
	 * git restore — a phantom pass). BEST-EFFORT: it proves "something is on disk vs
	 * HEAD" (or a command exits 0), NOT that the agent's claim is correct. INERT on a
	 * no-shell / non-git checkout (the result passes through unchanged — never a
	 * fabricated failure). Like {@link AgentOpts.contextDiff}, a post-condition is NOT
	 * part of {@link computeCallKey} — it must not void the resume cache.
	 */
	verifyDiff?: boolean | { check?: string };
}

/** Spawn a subagent; resolves to its final text, a validated object, or `null`. */
export type AgentFn = (prompt: string, opts?: AgentOpts) => Promise<unknown>;

/**
 * Run another workflow inline as a sub-step (spec §8). `nameOrRef` is a saved-name
 * string or a `{ scriptPath }` ref; `args` is the child's verbatim `args`. Resolves
 * to the child's `return` value on completion, THROWS on child error (catchable,
 * unlike `agent()`'s null), and is unavailable (throws {@link NestingError}) inside
 * a child — nesting is one level deep.
 */
export type WorkflowFn = (
	nameOrRef: string | { scriptPath: string },
	args?: unknown,
) => Promise<unknown>;

/** The token budget as the script sees it (spec §6). */
export interface BudgetView {
	/** The hard ceiling for the turn, or `null` if none was set. */
	total: number | null;
	/** Output tokens spent this turn across the shared pool. */
	spent(): number;
	/** `max(0, total − spent())`, or `Infinity` with no target. */
	remaining(): number;
}

/** A progress signal emitted as the runtime drives `agent()` calls. */
export type ProgressEvent =
	| {
			type: "agent:start";
			label: string;
			phase?: string;
			/**
			 * A truncated preview of the USER prompt for this call (Task 8.3.x), shown
			 * in the TUI viewer's Detail pane. The original `agent()` argument — NOT the
			 * schema-suffixed launch prompt — capped to keep feed lines bounded. Present
			 * on every path (cached included); the runtime stays clock-free.
			 */
			promptPreview?: string;
	  }
	| {
			/**
			 * A child session was launched (Task 8.1.1), emitted between `agent:start`
			 * and `agent:end` the instant `runner.launch` returns a sessionID. Carries
			 * the session↔label binding downstream consumers (engine choke,
			 * `workflow_status`, feed) need to attach per-agent stats and compute
			 * durations. The cached and pre-launch-throw paths never emit it (no
			 * session). The runtime stays clock-free — durations are an engine-side
			 * derivation, never carried here.
			 */
			type: "agent:launched";
			label: string;
			phase?: string;
			sessionID: string;
			/** Resolved model (`task.model ?? opts.model`), when one is known. */
			model?: string;
			/** Resolved subagent type (`opts.agentType ?? defaults.agent`). */
			agentType?: string;
	  }
	| {
			type: "agent:end";
			label: string;
			status: string;
			/**
			 * The child's sessionID (Task 8.1.1), present only when a session was
			 * launched. Absent on the cached and pre-launch-throw paths, which
			 * legitimately have no session to bind. Lets the engine pair this end with
			 * its `agent:launched` to finalize per-agent stats and duration.
			 */
			sessionID?: string;
			/**
			 * Optional short human diagnostic line (Task 7.2.1), present only when the
			 * call degraded to `null`/`""`. `workflow_status` renders it after the
			 * duration line — e.g. `null — schema_invalid: missing 'verdict'; raw 6.3k
			 * chars preserved`, or the empty-output warning.
			 */
			note?: string;
	  }
	| { type: "log"; message: string }
	| { type: "warn"; message: string };

/** Sink for {@link ProgressEvent}s; renders to `/workflows` and narrator lines. */
export type ProgressEmitter = (e: ProgressEvent) => void;

/**
 * The typed reason an `agent()` call degraded to `null`/`""` (Task 7.2.1). One
 * vocabulary, used in both the progress note and the persisted run record:
 * - `schema_no_call`: structured call completed but `structured_output` was never
 *   called (nothing stored, no validation failure recorded).
 * - `schema_invalid`: `structured_output` WAS called but every call was rejected
 *   (parse or schema validation), so nothing was stored.
 * - `status_error` / `status_cancelled`: the child reached a non-completed terminal
 *   status.
 * - `await_failed`: `launch()`/`awaitCompletion()` threw (degraded, not detonated).
 * - `empty_output`: the child completed and produced an empty (`""`) final text.
 * - `isolation_unsupported`: `isolation:'worktree'` was requested but unsupported,
 *   so the call degraded to `null` BEFORE launch rather than running unisolated
 *   (Epic 0.4) — no child session, no `agent:launched`.
 * - `empty_diff`: `contextDiff:true` was set but the engine-computed git diff for
 *   the unit under review was PROVABLY empty (a live work tree), so the review was
 *   refused BEFORE launch rather than reviewing narrative-only claims (Epic 4.1) —
 *   no child session, no `agent:launched`.
 * - `verify_failed`: `verifyDiff` was set and the engine's POST-settle git/command
 *   check FAILED (an empty git diff, or a non-zero check exit), so the settled
 *   result was downgraded to `null` (Epic 4.2). Unlike `empty_diff`, the agent DID
 *   launch and settle (it carries a childSessionID) — the downgrade nulls the RESULT
 *   so it re-runs on resume, but does NOT un-commit (P2 recovery still holds for
 *   bytes already on disk).
 */
export type DiagnosticReason =
	| "schema_no_call"
	| "schema_invalid"
	| "status_error"
	| "status_cancelled"
	| "await_failed"
	| "empty_output"
	| "isolation_unsupported"
	| "empty_diff"
	| "verify_failed";

/**
 * A post-mortem diagnostic for a single failed/empty `agent()` call (Task 7.2.1).
 * Collected by the engine via the {@link DiagnosticEmitter} hook and persisted on
 * the run record so a finished run is debuggable WITHOUT SQLite — answering "why
 * was this null?" from the record alone. `agent()` itself still returns bare
 * `null`/`""` to the script: this is observational, never load-bearing.
 */
export interface AgentDiagnostic {
	/** Display label of the call (same as the progress label). */
	label: string;
	/** The deterministic call ordinal (matches the journal `index`). */
	index: number;
	reason: DiagnosticReason;
	/**
	 * The child's raw final text, captured for the schema reasons so a validation
	 * failure is inspectable. Capped at 20_000 chars with a `…[capped]` marker;
	 * absent when no capture applies or the capture itself failed (fenced).
	 */
	rawText?: string;
	/** The child's sessionID, when one was assigned (absent on a pre-launch throw). */
	childSessionID?: string;
}

/** Sink for {@link AgentDiagnostic}s; the engine collects them onto the run handle. */
export type DiagnosticEmitter = (d: AgentDiagnostic) => void;

/**
 * A {@link ProgressEvent} stamped with the wall-clock time it was observed (Task
 * 6.2.1). The runtime stays deliberately clock-free — it emits bare
 * {@link ProgressEvent}s — and the ENGINE stamps `at = clock.now()` at its
 * `onProgress` boundary before pushing onto the handle. This keeps fake clocks
 * authoritative in tests and confines the only timestamp source to the one layer
 * that already owns an injected {@link Clock}.
 */
export type StampedProgressEvent = ProgressEvent & { at: number };

/**
 * A SETTLED `agent()`/`workflow()` call (spec §7). Only SETTLED, NON-null results
 * are journaled: a failed/null agent must re-run on resume, never replay its
 * failure. `key` is the {@link computeCallKey} hash of `(prompt, opts)`; `index`
 * is the deterministic call ordinal (every invocation, cached or live).
 */
export interface SettledJournalEntry {
	index: number;
	key: string;
	status: "ok";
	result: unknown;
}

/**
 * A WRITE-AHEAD intent record (Phase 3): one line appended BEFORE a live launch
 * so a crash in the launch window leaves a durable "dispatched-but-not-settled"
 * marker. It shares `index` + `key` with its eventual {@link SettledJournalEntry}
 * completion (the same call ordinal) — that pairing is how a reconciler matches
 * them; there is deliberately no separate id. An intent carries NO `result` (it
 * has none by definition); `label` is optional forensic readability. There is no
 * `pending`/`running` status beyond `intent`: a settled call has its `ok` line,
 * an interrupted call has only its `intent` line — that is enough to detect it.
 */
export interface IntentJournalEntry {
	index: number;
	key: string;
	status: "intent";
	label?: string;
}

/**
 * One line in the run journal (spec §7), discriminated on `status`: a settled
 * {@link SettledJournalEntry} (`ok`, replayed on resume) or a write-ahead
 * {@link IntentJournalEntry} (`intent`, never replayed — filtered before the
 * replay cache is built). The journal serializes/deserializes whole objects, so
 * both members ride the same `record()`/`load()` path unchanged.
 *
 * Lives here (not in `../plugin/journal`) so the runtime layer stays free of any
 * plugin import — journal.ts imports this type from the runtime instead.
 */
export type JournalEntry = SettledJournalEntry | IntentJournalEntry;

/**
 * The complete set of globals available to a workflow script body (spec §3.3).
 * `pipeline`/`parallel` keep permissive signatures here — their concrete typing
 * arrives with their implementation (Task 3.2.2).
 */
export interface RuntimeApi {
	agent: AgentFn;
	pipeline: (...args: unknown[]) => Promise<unknown[]>;
	parallel: (...args: unknown[]) => Promise<unknown[]>;
	phase: (title: string) => void;
	log: (message: string) => void;
	args: unknown;
	budget: BudgetView;
	/** Run another workflow inline as a sub-step (spec §8); see {@link WorkflowFn}. */
	workflow: WorkflowFn;
}

/** The lifetime agent-count cap (1,000) was hit — a runaway-loop backstop (§5). */
export class AgentCapError extends Error {
	constructor(message = "workflow exceeded the 1000-agent lifetime cap") {
		super(message);
		this.name = "AgentCapError";
	}
}

/**
 * `isolation:'worktree'` was requested but there is no OpenCode worktree-session
 * primitive (Epic 0.4). The old behavior silently ran the agent UNISOLATED, giving
 * false safety; the new behavior fails the requesting agent loudly. The agent-call
 * primitive DEGRADES the call to `null` carrying this message (it does NOT throw —
 * a throw before `gate.acquire` would detonate the whole `parallel()` batch,
 * breaking the degrade-don't-detonate contract). The class exists so the message is
 * one canonical string and a caller that wants a hard stop can throw it instead.
 */
export class IsolationUnsupportedError extends Error {
	constructor(
		message = "isolation:'worktree' is not supported (no worktree session primitive); the agent fails rather than running unisolated",
	) {
		super(message);
		this.name = "IsolationUnsupportedError";
	}
}

/** The token budget is exhausted; further `agent()` calls are refused (§6). */
export class BudgetExhaustedError extends Error {
	constructor(message = "workflow token budget exhausted") {
		super(message);
		this.name = "BudgetExhaustedError";
	}
}

// ItemCapError's canonical home is compose.ts (it carries count/cap fields the
// composition functions populate); re-exported here so the error-class family
// stays importable from one module.
export { ItemCapError } from "./compose";

/** A primitive/option that is recognized but not yet implemented in this phase. */
export class NotYetSupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotYetSupportedError";
	}
}

/**
 * `workflow()` was called inside a child workflow (spec §8: nesting is one level
 * deep). Thrown structurally — a child run is built with no `resolveSubWorkflow`,
 * so its `workflow()` global detonates rather than nesting a second level.
 */
export class NestingError extends Error {
	constructor(
		message = "sub-workflows are limited to one level — workflow() is unavailable inside a child workflow",
	) {
		super(message);
		this.name = "NestingError";
	}
}
