import { describe, expect, test } from "bun:test";
import { type ControlFs, createControlWatcher } from "./control";

/**
 * Control-watcher unit tests (Task 8.2.2). The watcher is driven through its
 * exposed `tick()` so timers never enter the picture; `start()`/`stop()` are
 * exercised against injectable interval fns. The fs is a tiny in-memory facade
 * mirroring the readdir/rm subset the engine's {@link FsFacade} exposes.
 */

const DIR = "/wf-data/workflow-control";

function makeFs(names: string[] = []) {
	const present = new Set(names);
	const calls: { readdir: number; rm: string[] } = { readdir: 0, rm: [] };
	const fs: ControlFs = {
		readdir: async (dir: string) => {
			calls.readdir += 1;
			if (dir !== DIR) {
				return [];
			}
			return [...present];
		},
		rm: async (path: string) => {
			calls.rm.push(path);
			present.delete(path.slice(`${DIR}/`.length));
		},
	};
	return { fs, present, calls };
}

function enoentFs() {
	const fs: ControlFs = {
		readdir: async () => {
			const err = new Error("ENOENT") as Error & { code: string };
			err.code = "ENOENT";
			throw err;
		},
		rm: async () => {},
	};
	return fs;
}

interface LoggedDebug {
	msg: string;
	meta?: Record<string, unknown>;
}

function makeLogger() {
	const debug: LoggedDebug[] = [];
	return {
		logger: {
			debug: (msg: string, meta?: Record<string, unknown>) =>
				debug.push({ msg, meta }),
		},
		debug,
	};
}

describe("createControlWatcher — tick", () => {
	test("a `<runId>.cancel` sentinel triggers onCancel once and is removed", async () => {
		const { fs, present, calls } = makeFs(["wf_abc.cancel"]);
		const cancelled: string[] = [];
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
		});

		await watcher.tick();

		expect(cancelled).toEqual(["wf_abc"]);
		expect(calls.rm).toEqual([`${DIR}/wf_abc.cancel`]);
		expect(present.has("wf_abc.cancel")).toBe(false);
	});

	test("a missing control dir (ENOENT) yields no cancels and does not throw", async () => {
		const { logger, debug } = makeLogger();
		const cancelled: string[] = [];
		const watcher = createControlWatcher({
			dir: DIR,
			fs: enoentFs(),
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
			logger,
		});

		await watcher.tick();
		await watcher.tick();

		expect(cancelled).toEqual([]);
		// Logged once across repeated ticks (steady state, not noise).
		expect(debug.length).toBe(1);
	});

	test("a file without a .cancel suffix is ignored", async () => {
		const { fs, present, calls } = makeFs(["wf_abc.txt", "notes"]);
		const cancelled: string[] = [];
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
		});

		await watcher.tick();

		expect(cancelled).toEqual([]);
		expect(calls.rm).toEqual([]);
		expect(present.has("wf_abc.txt")).toBe(true);
	});

	test("consumes the sentinel even when onCancel rejects (loop survives)", async () => {
		const { logger } = makeLogger();
		const { fs, present, calls } = makeFs(["wf_boom.cancel"]);
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async () => {
				throw new Error("onCancel blew up");
			},
			logger,
		});

		// Must not reject.
		await watcher.tick();

		expect(calls.rm).toEqual([`${DIR}/wf_boom.cancel`]);
		expect(present.has("wf_boom.cancel")).toBe(false);
	});

	test("an rm failure is swallowed and the tick survives", async () => {
		const { logger, debug } = makeLogger();
		const cancelled: string[] = [];
		const fs: ControlFs = {
			readdir: async () => ["wf_stuck.cancel"],
			rm: async () => {
				throw new Error("EBUSY");
			},
		};
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
			logger,
		});

		await watcher.tick();

		expect(cancelled).toEqual(["wf_stuck"]);
		// rm failure logged at least once; the tick did not throw.
		expect(debug.length).toBeGreaterThanOrEqual(1);
	});
});

describe("createControlWatcher — start/stop", () => {
	test("start arms exactly one interval and is idempotent; stop clears it", () => {
		const armed: Array<{ ms: number }> = [];
		const cleared: unknown[] = [];
		let handleSeq = 0;
		const watcher = createControlWatcher({
			dir: DIR,
			fs: makeFs().fs,
			intervalMs: 1500,
			onCancel: async () => {},
			setIntervalFn: (_cb, ms) => {
				armed.push({ ms });
				handleSeq += 1;
				return handleSeq;
			},
			clearIntervalFn: (handle) => {
				cleared.push(handle);
			},
		});

		watcher.start();
		watcher.start();

		expect(armed).toEqual([{ ms: 1500 }]);

		watcher.stop();
		expect(cleared).toEqual([1]);

		// stop is idempotent — a second clear is a no-op.
		watcher.stop();
		expect(cleared).toEqual([1]);
	});

	test("the armed interval callback drives tick", async () => {
		const { fs, present } = makeFs(["wf_timer.cancel"]);
		const cancelled: string[] = [];
		let armedCb: (() => void) | undefined;
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
			setIntervalFn: (cb) => {
				armedCb = cb;
				return 1;
			},
			clearIntervalFn: () => {},
		});

		watcher.start();
		expect(armedCb).toBeDefined();
		armedCb?.();
		// Let the async tick the callback kicked off settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(cancelled).toEqual(["wf_timer"]);
		expect(present.has("wf_timer.cancel")).toBe(false);
	});
});
