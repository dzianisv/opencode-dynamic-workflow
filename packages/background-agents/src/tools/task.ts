/**
 * `bg_task` — launch a background agent task, or resume a terminal one.
 *
 * Factory-DI: {@link createBgTaskTool} takes the {@link SessionRunner} so tests
 * inject a typed fake (no SDK, no live engine). The tool is pure argument
 * mapping + error translation; all the heavy lifting (concurrency, sessions,
 * completion) lives in core.
 *
 * Two modes, keyed on `task_id`:
 *   - absent  → LAUNCH. Maps `description`/`prompt`/`agent`/`model` into a
 *     {@link LaunchRequest}; `depth` is INFERRED from the caller's session.
 *   - present → RESUME. Only `prompt` is used; every other arg is ignored.
 *
 * Error strategy (custom-tools.md): expected outcomes the model should reason
 * over — validation gaps, depth-exceeded, `taskStillRunning`, `sessionExpired`
 * — return honest strings. Genuinely exceptional failures rethrow so opencode
 * surfaces them.
 */

import type { BgTask, SessionRunner } from "@drawers/core";
import { tool } from "@opencode-ai/plugin";

const DEFAULT_AGENT = "build";

/**
 * Resume errors core raises are plain `Error`s whose `message` is prefixed with
 * a stable token (`session-runner.ts` `resume()`):
 *   - `taskStillRunning: <id> is <status>`
 *   - `sessionExpired: <id> ...`
 * We translate exactly these two prefixes; anything else rethrows.
 */
const TASK_STILL_RUNNING = "taskStillRunning:";
const SESSION_EXPIRED = "sessionExpired:";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Strip a known prefix from a core error message, leaving the human detail. */
function detailAfter(message: string, prefix: string): string {
	return message.slice(prefix.length).trim();
}

/**
 * Launch result text. Carries the id, the status, and explicit no-poll guidance
 * so the model does not turn `bg_task` into a poll-storm: it will be notified on
 * completion and should read the result with `bg_output` only then.
 */
function launchResultText(taskTask: BgTask): string {
	return [
		`Launched background task ${taskTask.id} (status: ${taskTask.status}).`,
		"It is running in the background — you will be notified on completion; " +
			`do NOT poll. Call bg_output("${taskTask.id}") when notified.`,
	].join(" ");
}

/** Resume result text — mirrors launch's no-poll contract. */
function resumeResultText(taskTask: BgTask): string {
	return [
		`Resumed background task ${taskTask.id} (status: ${taskTask.status}).`,
		"It is running in the background — you will be notified on completion; " +
			`do NOT poll. Call bg_output("${taskTask.id}") when notified.`,
	].join(" ");
}

export function createBgTaskTool(runner: SessionRunner) {
	return tool({
		description:
			"Launch a background agent task that runs independently of this turn, " +
			"or resume a finished one. You are notified when it completes — do NOT " +
			"poll; call bg_output(task_id) when notified. Pass task_id to resume a " +
			"completed/errored/cancelled task (only prompt is used; other args are " +
			"ignored).",
		args: {
			description: tool.schema
				.string()
				.describe("Short title for the task (shown in the UI)."),
			prompt: tool.schema
				.string()
				.describe("The instruction for the background agent."),
			agent: tool.schema
				.string()
				.default(DEFAULT_AGENT)
				.describe('Agent to run the task as. Defaults to "build".'),
			model: tool.schema
				.string()
				.optional()
				.describe('Optional model override, "provider/model".'),
			task_id: tool.schema
				.string()
				.optional()
				.describe(
					"Resume an existing terminal task instead of launching a new " +
						"one. When set, only `prompt` is used.",
				),
		},
		async execute(args, context) {
			const { description, prompt, agent, model, task_id } = args;

			// --- RESUME mode -------------------------------------------------
			if (task_id !== undefined) {
				if (prompt.trim().length === 0) {
					return "Cannot resume: `prompt` is required (the follow-up instruction).";
				}
				try {
					const resumed = await runner.resume(task_id, prompt);
					return resumeResultText(resumed);
				} catch (err) {
					const message = errorMessage(err);
					if (message.startsWith(TASK_STILL_RUNNING)) {
						return (
							`Cannot resume ${task_id}: it is still running ` +
							`(${detailAfter(message, TASK_STILL_RUNNING)}). ` +
							"Wait for completion, then resume or read its output."
						);
					}
					if (message.startsWith(SESSION_EXPIRED)) {
						return (
							`Cannot resume ${task_id}: its session has expired ` +
							`(${detailAfter(message, SESSION_EXPIRED)}). ` +
							"Launch a new background task instead."
						);
					}
					// Unexpected: a real failure the model cannot reason around.
					throw err;
				}
			}

			// --- LAUNCH mode -------------------------------------------------
			if (description.trim().length === 0) {
				return "Cannot launch: `description` is required (a short task title).";
			}
			if (prompt.trim().length === 0) {
				return "Cannot launch: `prompt` is required (the task instruction).";
			}

			// Depth inference: if the calling session is itself a tracked task's
			// child session, this call is one level deeper than that task. core's
			// maxDepth guard does the rejecting; we just compute + report.
			const parent = runner
				.list()
				.find((t) => t.sessionID === context.sessionID);
			const depth = (parent?.depth ?? -1) + 1;

			context.metadata({ title: description });

			try {
				const launched = await runner.launch({
					parentSessionID: context.sessionID,
					description,
					prompt,
					agent,
					model,
					depth,
				});
				return launchResultText(launched);
			} catch (err) {
				// Depth-exceeded (and any other launch guard) is an expected outcome
				// the model should reason over, not a crash.
				return `Cannot launch background task: ${errorMessage(err)}`;
			}
		},
	});
}
