import type { ConcurrencyManager, SessionRunner } from "@drawers/core";
import {
	AgentCapError,
	type AgentFn,
	type AgentOpts,
	BudgetExhaustedError,
	type BudgetView,
	NotYetSupportedError,
	type ProgressEmitter,
} from "./types";

/** Lifetime agent-count backstop per workflow (spec §5). */
const AGENT_LIFETIME_CAP = 1_000;
/** Default per-agent completion timeout: 30 minutes. */
const DEFAULT_AWAIT_TIMEOUT_MS = 1_800_000;
/** Label fallback length when no `opts.label` is given. */
const LABEL_PREFIX_LEN = 60;

/** Everything the `agent()` primitive needs from the surrounding runtime. */
export interface AgentPrimitiveDeps {
	runner: SessionRunner;
	parentSessionID: string;
	/** Concurrency-gate key for this run; also the journal/abort scope. */
	runId: string;
	/** Standalone concurrency gate, keyed by `runId`. */
	gate: ConcurrencyManager;
	/** Lifetime agent counter shared across the run (mutated in place). */
	counters: { agents: number };
	budget: BudgetView;
	emit: ProgressEmitter;
	/** The active progress phase, when no per-call `opts.phase` is given. */
	currentPhase: () => string | undefined;
	/** Live task ids, so abort() (Task 3.2.3) can cancel in-flight work. */
	liveTasks?: Set<string>;
	defaults: { agent: string; awaitTimeoutMs?: number };
}

/**
 * Builds the `agent()` primitive over the core session runner (spec §3.3 row 1).
 *
 * Failure philosophy is "degrade, don't detonate" (§9): an agent that dies on a
 * terminal status, or a runner call that throws, resolves to `null`. The ONLY
 * intentional throws are the lifetime cap, budget exhaustion, and the not-yet
 * structured-output path — those are meant to stop the run.
 */
export function createAgentPrimitive(deps: AgentPrimitiveDeps): AgentFn {
	const {
		runner,
		parentSessionID,
		runId,
		gate,
		counters,
		budget,
		emit,
		currentPhase,
		liveTasks,
		defaults,
	} = deps;
	const awaitTimeoutMs = defaults.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;

	return async function agent(
		prompt: string,
		opts: AgentOpts = {},
	): Promise<unknown> {
		// 1. Lifetime cap — increment BEFORE acquire so queued calls count too.
		if (counters.agents >= AGENT_LIFETIME_CAP) {
			throw new AgentCapError();
		}
		counters.agents += 1;

		// 2. Budget ceiling (§6): a set total with nothing left refuses the call.
		if (budget.total !== null && budget.remaining() <= 0) {
			throw new BudgetExhaustedError();
		}

		// 3. Structured output is not wired yet (placeholder; replaced in 3.3.2).
		if (opts.schema !== undefined) {
			throw new NotYetSupportedError("structured output lands in Task 3.3.2");
		}

		// 4. Worktree isolation has no OpenCode session primitive — honest no-op.
		if (opts.isolation === "worktree") {
			emit({
				type: "warn",
				message:
					"isolation:'worktree' is not supported (no worktree session primitive); running without isolation",
			});
		}

		const label = opts.label ?? prompt.slice(0, LABEL_PREFIX_LEN);
		const phase = opts.phase ?? currentPhase();

		// 5. Gate the launch on the run's concurrency slots.
		await gate.acquire(runId);

		let taskId: string | undefined;
		let status = "error";
		try {
			// 6. Announce the start once the slot is held.
			emit({ type: "agent:start", label, phase });

			// 7. Launch the subagent.
			const task = await runner.launch({
				parentSessionID,
				description: label,
				prompt,
				agent: opts.agentType ?? defaults.agent,
				model: opts.model,
				depth: 0,
			});
			taskId = task.id;
			liveTasks?.add(task.id);

			// 8. Wait for it to reach a terminal status.
			const done = await runner.awaitCompletion(task.id, awaitTimeoutMs);
			status = done.status;

			// 10. Map terminal status to a result; non-completed degrades to null.
			if (done.status === "completed") {
				return (await runner.readOutput(task.id)).summaryText;
			}
			return null;
		} catch (err) {
			// launch()/awaitCompletion() throwing is a degrade, not a detonation.
			status = "error";
			emit({
				type: "warn",
				message: `agent '${label}' failed: ${describeError(err)}`,
			});
			return null;
		} finally {
			// 9. Release the slot and drop the live task on EVERY path.
			if (taskId !== undefined) {
				liveTasks?.delete(taskId);
			}
			gate.release(runId);
			// 11. Announce the end with the resolved status.
			emit({ type: "agent:end", label, status });
		}
	};
}

/** Best-effort human-readable detail for a thrown value. */
function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
