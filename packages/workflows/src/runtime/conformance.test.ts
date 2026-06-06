import { describe, expect, test } from "bun:test";
import {
	ConcurrencyManager,
	createIdGenerator,
	createSessionRunner,
	type EngineClient,
	type SessionRunner,
} from "@drawers/core";
import { createWorkflowRun } from "./index";

/**
 * Spec-conformance suite (Task 3.2.3). Scripts run as template strings against
 * the REAL createSessionRunner with a scripted fake EngineClient. Completion is
 * driven by hand: a controllable clock + manual timers + synthetic
 * `session.idle` events, mirroring packages/core/src/completion.test.ts and
 * session-runner.test.ts. No real sleeps, no wall-clock timers.
 */

// ---- controllable timing fakes -------------------------------------------

interface TimerHandle {
	clear(): void;
}
interface IntervalHandle {
	clear(): void;
	unref?(): void;
}

function makeTimers() {
	let seq = 0;
	const timers = new Map<number, () => void>();
	const intervals = new Map<number, () => void>();
	return {
		setTimer: (cb: () => void): TimerHandle => {
			const id = ++seq;
			timers.set(id, cb);
			return { clear: () => timers.delete(id) };
		},
		setIntervalFn: (cb: () => void): IntervalHandle => {
			const id = ++seq;
			intervals.set(id, cb);
			return { clear: () => intervals.delete(id), unref: () => {} };
		},
		fireAllTimers: () => {
			for (const [id, cb] of [...timers]) {
				timers.delete(id);
				cb();
			}
		},
	};
}

function makeClock(start = 1000): {
	now: () => number;
	set: (t: number) => void;
} {
	let t = start;
	return { now: () => t, set: (v) => (t = v) };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await Promise.resolve();
	}
}

const MIN_IDLE = 5000;

// ---- scripted fake EngineClient ------------------------------------------

interface PartEntry {
	type: string;
	text?: string;
	synthetic?: boolean;
	state?: { status: string; output?: string; error?: string };
}
interface MessageEntry {
	info: { role: "user" | "assistant" };
	parts: PartEntry[];
}

/** A scripted session: the transcript to serve, and an error flag. */
interface SessionScript {
	messages?: MessageEntry[];
	/** When true, the session never reaches a valid-output idle (used for "poison"). */
	poison?: boolean;
	/** When true, session.create rejects (terminal launch failure → degrade null). */
	createThrows?: boolean;
}

/**
 * Scripted fake. Sessions are created sequentially (`ses_1`, `ses_2`, …); each
 * session's transcript is chosen by the order of creation against a queue of
 * scripts. Tracks concurrent live sessions (created-but-not-completed) so cases
 * can assert the concurrency high-water mark.
 */
function makeScriptedClient() {
	const scripts: SessionScript[] = [];
	const transcripts = new Map<string, MessageEntry[]>();
	const poisoned = new Set<string>();
	const abortCalls: string[] = [];
	const liveSessions = new Set<string>();
	let createSeq = 0;
	let highWater = 0;
	let createThrowsNext = false;

	const client: EngineClient = {
		session: {
			create() {
				const script = scripts.shift();
				if (script?.createThrows || createThrowsNext) {
					return Promise.reject(new Error("session.create boom"));
				}
				const id = `ses_${++createSeq}`;
				transcripts.set(id, script?.messages ?? defaultDone());
				if (script?.poison) {
					poisoned.add(id);
				}
				liveSessions.add(id);
				if (liveSessions.size > highWater) {
					highWater = liveSessions.size;
				}
				return Promise.resolve({ data: { id } });
			},
			promptAsync() {
				return Promise.resolve(undefined);
			},
			abort(opts) {
				abortCalls.push(opts.path.id);
				liveSessions.delete(opts.path.id);
				return Promise.resolve({ data: true });
			},
			messages(opts) {
				return Promise.resolve({ data: transcripts.get(opts.path.id) ?? [] });
			},
			get() {
				return Promise.resolve({ data: { id: "ses" } });
			},
		},
	};

	return {
		client,
		abortCalls,
		highWater: () => highWater,
		liveCount: () => liveSessions.size,
		/** Queue the script the NEXT create() consumes. */
		queueScript: (s: SessionScript) => scripts.push(s),
		setCreateThrows: (v: boolean) => {
			createThrowsNext = v;
		},
		/** A session reaches a clean completion (drops out of the live set). */
		completeSession: (id: string) => liveSessions.delete(id),
		isPoisoned: (id: string) => poisoned.has(id),
		liveSessionIds: () => [...liveSessions],
	};
}

function done(text: string): MessageEntry[] {
	return [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }];
}
function defaultDone(): MessageEntry[] {
	return done("ok");
}

// ---- harness -------------------------------------------------------------

interface Harness {
	runner: SessionRunner;
	client: ReturnType<typeof makeScriptedClient>;
	clock: ReturnType<typeof makeClock>;
	timers: ReturnType<typeof makeTimers>;
	concurrency: ConcurrencyManager;
}

function makeHarness(): Harness {
	const client = makeScriptedClient();
	const clock = makeClock(1000);
	const timers = makeTimers();
	const concurrency = new ConcurrencyManager();
	const runner = createSessionRunner({
		client: client.client,
		concurrency,
		ids: createIdGenerator(),
		clock,
		startPoll: false,
		setTimer: timers.setTimer,
		setIntervalFn: timers.setIntervalFn,
		config: { minIdleMs: MIN_IDLE, pollMs: 5000 },
	});
	return { runner, client, clock, timers, concurrency };
}

/** Drive every currently-live session to completed via idle + grace. */
async function completeAllLive(h: Harness): Promise<void> {
	// Let launches register their sessions first.
	await flush();
	const live = h.client.liveSessionIds();
	h.clock.set(1000 + MIN_IDLE + 1);
	for (const id of live) {
		if (h.client.isPoisoned(id)) {
			continue; // poison: never produce a valid idle.
		}
		await h.runner.handleEvent({
			type: "session.idle",
			properties: { sessionID: id },
		} as never);
		h.client.completeSession(id);
	}
	await flush();
	h.timers.fireAllTimers();
	await flush();
}

const META = `export const meta = { name: "wf", description: "round trip" };\n`;

// ---- (a) meta + return round-trip ----------------------------------------

describe("conformance (a) — meta + return round-trip", () => {
	test("script returns a literal; returnValue matches; meta.name surfaced", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_a",
		});
		const result = await run.run(
			`export const meta = { name: "roundtrip", description: "d" };\nreturn { hello: "world", n: 7 };\n`,
		);
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual({ hello: "world", n: 7 });
		expect(result.meta?.name).toBe("roundtrip");
	});
});

// ---- (b) agent() resolves the child's final text -------------------------

describe("conformance (b) — agent() resolves scripted child text", () => {
	test("agent() resolves the scripted child's final assistant text", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("the answer is 42") });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_b",
		});
		const p = run.run(`${META}const r = await agent("compute");\nreturn r;\n`);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toBe("the answer is 42");
		expect(result.agentCount).toBe(1);
	});
});

// ---- (c) degrade: child error → null → .filter(Boolean) ------------------

describe("conformance (c) — degrade to null filters out", () => {
	test("a failing child becomes null; script .filter(Boolean) drops it", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("good") });
		h.client.queueScript({ createThrows: true }); // dies → null
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_c",
		});
		const p = run.run(
			`${META}const a = await agent("a");\nconst b = await agent("b");\nreturn [a, b].filter(Boolean);\n`,
		);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual(["good"]);
	});
});

// ---- (d) pipeline over 3 with a poisoned stage ---------------------------

describe("conformance (d) — pipeline with one poisoned stage", () => {
	test("pipeline over 3 items, middle fails → [x, null, y] shape", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("X") });
		h.client.queueScript({ createThrows: true }); // middle item agent dies
		h.client.queueScript({ messages: done("Y") });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_d",
		});
		// Each pipeline stage calls agent; the middle agent returns null, and the
		// stage throws on null to drop the item.
		const p = run.run(
			`${META}const out = await pipeline([1, 2, 3], async (item) => {\n  const r = await agent("item " + item);\n  if (r === null) throw new Error("poison");\n  return r;\n});\nreturn out;\n`,
		);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual(["X", null, "Y"]);
	});
});

// ---- (e) phase()/log() ordering in progress ------------------------------

describe("conformance (e) — phase()/log() ordering in progress", () => {
	test("log events appear in script order; agent:start carries phase title", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("done") });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_e",
		});
		const p = run.run(
			`${META}log("starting");\nphase("Build");\nawait agent("do it");\nlog("finished");\nreturn null;\n`,
		);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");

		const logs = result.progress
			.filter((e) => e.type === "log")
			.map((e) => (e.type === "log" ? e.message : ""));
		expect(logs).toEqual(["starting", "finished"]);

		const start = result.progress.find((e) => e.type === "agent:start");
		expect(start).toBeDefined();
		if (start?.type === "agent:start") {
			expect(start.phase).toBe("Build");
		}
	});
});

// ---- (f) Date.now() → determinism error ----------------------------------

describe("conformance (f) — Date.now() is a determinism error", () => {
	test("Date.now() in script → status error mentioning determinism", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_f",
		});
		const result = await run.run(`${META}return Date.now();\n`);
		expect(result.status).toBe("error");
		// The DeterminismError surfaces as the run error: it names the banned
		// nondeterministic op (Date.now) — the determinism guard fired (spec §7).
		expect(result.error?.toLowerCase()).toContain("date.now()");
		expect(result.error?.toLowerCase()).toContain("banned");
	});
});

// ---- (g) budget default --------------------------------------------------

describe("conformance (g) — budget default", () => {
	test("no budget → [total, remaining()] === [null, Infinity]", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_g",
		});
		const result = await run.run(
			`${META}return [budget.total, budget.remaining()];\n`,
		);
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual([null, Number.POSITIVE_INFINITY]);
	});
});

// ---- (h) cores=4 → gate limit 2 enforced ---------------------------------

describe("conformance (h) — cores gate limit enforced", () => {
	test("cores=4 → at most 2 concurrent sessions live (high-water 2)", async () => {
		const h = makeHarness();
		// Three children that all stay live (no idle) while we inspect the gate.
		h.client.queueScript({ messages: done("1"), poison: true });
		h.client.queueScript({ messages: done("2"), poison: true });
		h.client.queueScript({ messages: done("3"), poison: true });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_h",
			cores: 4,
		});
		// Fire three agents in parallel; none completes (poison), so the third must
		// queue behind the gate. We never resolve them — assert the high-water mark
		// then abort to unwind.
		const p = run.run(
			`${META}await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);\nreturn "done";\n`,
		);
		await flush();
		await flush();
		expect(h.client.highWater()).toBe(2);
		expect(h.client.liveCount()).toBe(2);

		// Unwind: abort the run so the parallel() resolves (aborted agents → null)
		// and the run can settle without hanging the test.
		run.abort();
		await flush();
		const result = await p;
		expect(result.status).toBe("completed");
	});
});

// ---- (i) workflow() → Phase 4 error --------------------------------------

describe("conformance (i) — workflow() throws Phase 4", () => {
	test("workflow() in script → status error mentioning Phase 4", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_i",
		});
		const result = await run.run(`${META}return workflow("other");\n`);
		expect(result.status).toBe("error");
		expect(result.error).toContain("Phase 4");
	});
});

// ---- (j) abort(): live child cancelled, later agent() resolves null ------

describe("conformance (j) — abort() cancels live child + degrades later calls", () => {
	test("abort mid-run cancels the live child and later agent() resolves null", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("never"), poison: true }); // long-running
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_j",
		});
		// First agent launches and stays live (poison). After it resolves (null via
		// abort), a second agent() must short-circuit to null without launching.
		const p = run.run(
			`${META}const first = await agent("long");\nconst second = await agent("after-abort");\nreturn { first, second, secondIsNull: second === null };\n`,
		);
		await flush();
		await flush();
		// The first child is live.
		const liveBefore = h.client.liveSessionIds();
		expect(liveBefore.length).toBe(1);
		const liveChild = liveBefore[0];
		if (liveChild === undefined) {
			throw new Error("expected a live child session");
		}

		run.abort();
		await flush();
		await flush();

		// The live child was cancelled via runner.cancel → observable abort call.
		expect(h.client.abortCalls).toContain(liveChild);

		const result = await p;
		expect(result.status).toBe("completed");
		const rv = result.returnValue as {
			first: unknown;
			second: unknown;
			secondIsNull: boolean;
		};
		expect(rv.first).toBeNull();
		expect(rv.secondIsNull).toBe(true);
	});
});
