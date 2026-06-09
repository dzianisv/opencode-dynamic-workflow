import { describe, expect, test } from "bun:test";
import { evaluateScript } from "../runtime/evaluate";
import { parseScript } from "../runtime/meta";
import type { AgentOpts, RuntimeApi } from "../runtime/types";
import { ROLLING_WAVE_SOURCE } from "./builtin-rolling-wave";

/**
 * Control-flow test for the built-in rolling-wave script. parseScript proves it
 * parses; this proves its LOGIC runs end-to-end on allowed globals only and
 * threads decompose → implement → review → fix → synthesize correctly. Agents are
 * stubbed by label, so no model access happens — we assert the script's plumbing
 * (happy path, fix loop, stop-on-red break, empty-goal guard, verifyDiff wiring),
 * not implementation quality (live behavior needs real agents and is not
 * unit-testable). Stubs are deterministic: no clocks/random.
 */

const body = parseScript(ROLLING_WAVE_SOURCE).bodySource;

/** Build a RuntimeApi with real pipeline/parallel and a label-dispatched agent. */
function makeApi(opts: {
	args: unknown;
	agent: (prompt: string, o?: AgentOpts) => Promise<unknown>;
}): RuntimeApi {
	return {
		agent: opts.agent as RuntimeApi["agent"],
		phase: () => {},
		log: () => {},
		args: opts.args,
		budget: { total: null, spent: () => 0, remaining: () => Infinity },
		workflow: (() => {
			throw new Error("workflow() not used");
		}) as RuntimeApi["workflow"],
		parallel: async (thunks: Array<() => Promise<unknown>>) =>
			Promise.all(thunks.map((t) => t())),
		pipeline: async (
			items: unknown[],
			...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>
		) =>
			Promise.all(
				items.map(async (item, i) => {
					let v: unknown = item;
					for (const stage of stages) v = await stage(v, item, i);
					return v;
				}),
			),
	} as RuntimeApi;
}

type Verdict = { gatesPass: boolean; findings: string[] };

/**
 * Dispatch a stub agent by label prefix. `reviews` maps a review/rereview label
 * to the verdict it should return; `calledLabels` accumulates every label seen so
 * negative assertions (no fix, no later task, no agent at all) can check absence.
 * `rereview:` is matched BEFORE `review:` since both start with "re".
 */
function dispatchAgent(opts: {
	tasks: string[];
	reviews: Record<string, Verdict>;
	calledLabels: string[];
	implementOpts?: Array<{ label: string; opts?: AgentOpts }>;
}) {
	return async (_prompt: string, o?: AgentOpts) => {
		const label = o?.label ?? "";
		opts.calledLabels.push(label);
		if (opts.implementOpts && label.startsWith("implement:")) {
			opts.implementOpts.push({ label, opts: o });
		}
		if (label === "decompose") return { tasks: opts.tasks };
		if (label.startsWith("rereview:") || label.startsWith("review:")) {
			return opts.reviews[label] ?? { gatesPass: true, findings: [] };
		}
		if (label.startsWith("implement:") || label.startsWith("fix:"))
			return "wrote to disk";
		if (label === "synthesize") return "REPORT";
		return null;
	};
}

type RollingWaveResult = {
	goal: string;
	completed: string[];
	remaining: string[];
	report: unknown;
	error?: string;
};

describe("built-in rolling-wave — control flow", () => {
	test("happy path threads all tasks through to a report", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "ship the feature" },
			agent: dispatchAgent({ tasks: ["t0", "t1"], reviews: {}, calledLabels }),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.goal).toBe("ship the feature");
		expect(result.completed).toEqual(["t0", "t1"]);
		expect(result.remaining).toEqual([]);
		expect(result.report).toBe("REPORT");
		// No review was red → no fix loop fired.
		expect(calledLabels.some((l) => l.startsWith("fix:"))).toBe(false);
	});

	test("a red review triggers fix + re-review, then continues on green", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0", "t1"],
				reviews: {
					"review:0": { gatesPass: false, findings: ["f1"] },
					"rereview:0": { gatesPass: true, findings: [] },
					"review:1": { gatesPass: true, findings: [] },
				},
				calledLabels,
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(calledLabels).toContain("fix:0");
		expect(calledLabels).toContain("rereview:0");
		expect(result.completed).toEqual(["t0", "t1"]);
	});

	test("stop-on-red halts the wave before later tasks", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0", "t1", "t2"],
				reviews: {
					"review:0": { gatesPass: false, findings: ["f"] },
					"rereview:0": { gatesPass: false, findings: ["still"] },
				},
				calledLabels,
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.completed).toEqual([]);
		expect(result.remaining).toContain("t1");
		expect(result.remaining).toContain("t2");
		// The break fired before task 1 was implemented.
		expect(calledLabels).not.toContain("implement:1");
	});

	test("an empty goal returns an honest error without spawning agents", async () => {
		let called = false;
		const api = makeApi({
			args: {},
			agent: async () => {
				called = true;
				return null;
			},
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.error).toContain("goal");
		expect(called).toBe(false);
	});

	test("verifyDiff shape is wired from args.testCmd", async () => {
		const withCmd: Array<{ label: string; opts?: AgentOpts }> = [];
		const apiWithCmd = makeApi({
			args: { goal: "g", testCmd: "bun test" },
			agent: dispatchAgent({
				tasks: ["t0"],
				reviews: {},
				calledLabels: [],
				implementOpts: withCmd,
			}),
		});
		await evaluateScript(body, apiWithCmd);
		const implemented = withCmd.find((c) => c.label === "implement:0");
		expect(implemented?.opts?.verifyDiff).toEqual({ check: "bun test" });

		const noCmd: Array<{ label: string; opts?: AgentOpts }> = [];
		const apiNoCmd = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0"],
				reviews: {},
				calledLabels: [],
				implementOpts: noCmd,
			}),
		});
		await evaluateScript(body, apiNoCmd);
		const implementedNoCmd = noCmd.find((c) => c.label === "implement:0");
		expect(implementedNoCmd?.opts?.verifyDiff).toBe(true);
	});
});
