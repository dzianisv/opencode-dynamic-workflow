import { describe, expect, test } from "bun:test";
import {
	commitMessageFor,
	createGitCheckpointer,
	parsePorcelain,
} from "./git-checkpoint";

/**
 * Tests for the git-checkpoint module (Epic 2.1). The host `$` (BunShell) is a
 * TAGGED-TEMPLATE callable — `$\`git status\`` — so the fake reconstructs the
 * command string by zipping the {@link TemplateStringsArray} with the
 * interpolated expressions, then returns a canned {@link FakeOutput} keyed by a
 * matcher. No real git, no real shell: the module is fenced and pure-by-injection.
 */

interface FakeOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** A single canned reply: match the reconstructed command, return an output. */
interface Stub {
	match: (cmd: string) => boolean;
	out: FakeOutput;
}

/**
 * Build a fake BunShell. It records every reconstructed command string in
 * `commands` and answers from the first matching stub (default: success/empty).
 * `.cwd()` / `.nothrow()` return the same callable (chainable, like the real one).
 */
function makeShell(stubs: Stub[] = []) {
	const commands: string[] = [];
	const reconstruct = (
		strings: TemplateStringsArray,
		expressions: unknown[],
	): string => {
		let out = strings[0] ?? "";
		for (let i = 0; i < expressions.length; i += 1) {
			out += String(expressions[i]) + (strings[i + 1] ?? "");
		}
		return out.trim();
	};
	const makeResult = (out: FakeOutput) => {
		const buf = (s: string) => ({ toString: () => s });
		return Promise.resolve({
			stdout: buf(out.stdout),
			stderr: buf(out.stderr),
			exitCode: out.exitCode,
			text: () => out.stdout,
		});
	};
	const quietedCommands: string[] = [];
	const shell = (strings: TemplateStringsArray, ...expressions: unknown[]) => {
		const cmd = reconstruct(strings, expressions);
		commands.push(cmd);
		const stub = stubs.find((s) => s.match(cmd));
		const p = makeResult(stub?.out ?? { stdout: "", stderr: "", exitCode: 0 });
		// The real Bun ShellPromise carries `.quiet()` (the NAMESPACE does not); the
		// checkpointer appends it per-call to stop the echo to the host TTY. Model it on
		// the returned promise so a test can assert a SPECIFIC command was suppressed.
		Object.assign(p, {
			quiet: () => {
				quietedCommands.push(cmd);
				return p;
			},
		});
		return p;
	};
	const chain = Object.assign(shell, {
		cwd: () => chain,
		nothrow: () => chain,
		env: () => chain,
		braces: (p: string) => [p],
		escape: (s: string) => s,
		throws: () => chain,
	});
	// biome-ignore lint/suspicious/noExplicitAny: structural BunShell fake for tests.
	return { shell: chain as any, commands, quietedCommands };
}

const ok = (stdout = ""): FakeOutput => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "boom"): FakeOutput => ({
	stdout: "",
	stderr,
	exitCode: 128,
});

const NOW = 1_000_000;
const clock = { now: () => NOW };

function captureLogger() {
	const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
	return {
		warns,
		logger: {
			debug: () => {},
			info: () => {},
			warn: (msg: string, meta?: Record<string, unknown>) =>
				warns.push({ msg, meta }),
			error: () => {},
		},
	};
}

describe("parsePorcelain", () => {
	test("clean tree → no paths", () => {
		expect(parsePorcelain("")).toEqual([]);
	});

	test("modified, added, untracked entries → their paths", () => {
		const out = [" M src/a.ts", "A  src/b.ts", "?? src/c.ts"].join("\n");
		expect(parsePorcelain(out).sort()).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
	});

	test("renames-off porcelain emits two single-path entries, never an arrow", () => {
		// With `-c diff.renames=false`, a rename surfaces as a delete + an add, each
		// a single path — never the `R old -> new` two-path record that breaks
		// path-string set subtraction and add-pathspec semantics.
		const out = [" D src/old.ts", "?? src/new.ts"].join("\n");
		expect(parsePorcelain(out).sort()).toEqual(["src/new.ts", "src/old.ts"]);
		expect(parsePorcelain(out).some((p) => p.includes("->"))).toBe(false);
	});

	test("a quoted path (spaces/unicode) is unquoted to its real path", () => {
		expect(parsePorcelain(' M "src/a b.ts"')).toEqual(["src/a b.ts"]);
	});

	test("trailing blank lines and stray whitespace are ignored", () => {
		expect(parsePorcelain(" M src/a.ts\n\n")).toEqual(["src/a.ts"]);
	});
});

describe("commitMessageFor", () => {
	test("encodes runId, label, sessionID, phase for forensic traceability", () => {
		const msg = commitMessageFor({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_9",
			phase: "build",
		});
		expect(msg).toContain("wf_1");
		expect(msg).toContain("worker");
		expect(msg).toContain("ses_9");
		expect(msg).toContain("build");
	});

	test("omits the phase fragment cleanly when no phase is given", () => {
		const msg = commitMessageFor({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_9",
		});
		expect(msg).toContain("wf_1");
		expect(msg).not.toContain("undefined");
	});
});

describe("createGitCheckpointer — no shell → documented no-op", () => {
	test("undefined shell yields a checkpointer whose every call is inert", async () => {
		const cp = createGitCheckpointer({
			shell: undefined,
			directory: "/proj",
		});
		expect(await cp.ready()).toBe(false);
		await cp.baseline();
		expect(await cp.dirtyPaths()).toEqual([]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "w",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(false);
	});
});

describe("createGitCheckpointer — ready() dead-latch", () => {
	test("a non-repo latches dead, warns ONCE, and every later call no-ops", async () => {
		const { shell, commands } = makeShell([
			{
				match: (c) => c.includes("rev-parse --is-inside-work-tree"),
				out: fail(),
			},
		]);
		const { logger, warns } = captureLogger();
		const cp = createGitCheckpointer({
			shell,
			directory: "/proj",
			logger,
			clock,
		});

		expect(await cp.ready()).toBe(false);
		// Subsequent calls are no-ops: no further git runs, no second warn.
		await cp.baseline();
		expect(await cp.dirtyPaths()).toEqual([]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "w",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(false);

		expect(warns).toHaveLength(1);
		// Only the single rev-parse probe ran; the dead latch suppressed the rest.
		expect(commands.filter((c) => c.startsWith("git")).length).toBe(1);
	});

	test("ready() probes the work-tree exactly once across repeated calls", async () => {
		const { shell, commands } = makeShell([
			{
				match: (c) => c.includes("rev-parse --is-inside-work-tree"),
				out: ok("true"),
			},
		]);
		const cp = createGitCheckpointer({ shell, directory: "/proj", clock });
		expect(await cp.ready()).toBe(true);
		expect(await cp.ready()).toBe(true);
		expect(
			commands.filter((c) => c.includes("is-inside-work-tree")).length,
		).toBe(1);
	});
});

describe("createGitCheckpointer — output suppression (TTY safety)", () => {
	test("every git invocation is fenced with .quiet() so output never echoes to the host TTY", async () => {
		// The engine + plugin host run in the same OS process as the opencode opentui
		// renderer, sharing fd 1/2. An un-quieted BunShell echoes git's stdout/stderr
		// (e.g. the commit summary) onto the TUI alt-buffer, corrupting the screen. The
		// fenced `git()` factory MUST engage `.quiet()` so every git command only buffers.
		const { shell, commands, quietedCommands } = makeShell([
			{
				match: (c) => c.includes("rev-parse --is-inside-work-tree"),
				out: ok("true"),
			},
		]);
		const cp = createGitCheckpointer({ shell, directory: "/proj", clock });
		expect(await cp.ready()).toBe(true);
		// The probe ran AND was quieted: the engine + the opentui renderer share the
		// host TTY, so an un-quieted git command would corrupt the screen.
		const probe = "git rev-parse --is-inside-work-tree";
		expect(commands).toContain(probe);
		expect(quietedCommands).toContain(probe);
	});
});

describe("createGitCheckpointer — presumedAlive (per-run instance, probe upstream)", () => {
	test("presumedAlive:true presumes the repo without re-probing the work-tree", async () => {
		// A per-run instance: the engine already probed once. ready() must return true
		// with NO `is-inside-work-tree` git call (the probe is not repeated per run).
		const { shell, commands } = makeShell([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(""),
			},
		]);
		const cp = createGitCheckpointer({
			shell,
			directory: "/proj",
			clock,
			presumedAlive: true,
		});
		expect(await cp.ready()).toBe(true);
		// baseline()/dirtyPaths() still run (they are not the probe).
		await cp.baseline();
		expect(commands.some((c) => c.includes("is-inside-work-tree"))).toBe(false);
	});

	test("presumedAlive:false latches dead SILENTLY — no probe, no warn, every call no-ops", async () => {
		// The shared probe already warned about the non-repo; a per-run instance must
		// NOT re-warn (that is the per-agent-noise the warn-once invariant forbids).
		const { shell, commands } = makeShell();
		const { logger, warns } = captureLogger();
		const cp = createGitCheckpointer({
			shell,
			directory: "/proj",
			logger,
			clock,
			presumedAlive: false,
		});
		expect(await cp.ready()).toBe(false);
		await cp.baseline();
		expect(await cp.dirtyPaths()).toEqual([]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "w",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(false);
		// Dead from construction: no git ran at all, and not a single warn was emitted.
		expect(commands.filter((c) => c.startsWith("git"))).toHaveLength(0);
		expect(warns).toHaveLength(0);
	});
});

describe("createGitCheckpointer — fencing", () => {
	test("a non-zero git exit during ready() never throws — it returns false", async () => {
		const { shell } = makeShell([
			{
				match: (c) => c.includes("rev-parse"),
				out: fail("fatal: not a git repo"),
			},
		]);
		const cp = createGitCheckpointer({ shell, directory: "/proj", clock });
		// Must resolve, never reject.
		await expect(cp.ready()).resolves.toBe(false);
	});
});

// ---- Task 2.1.3: baseline (operator-safety foundation) -------------------

/** A live (work-tree) checkpointer driven past `ready()`. */
async function liveCheckpointer(stubs: Stub[]) {
	const aliveStub: Stub = {
		match: (c) => c.includes("is-inside-work-tree"),
		out: ok("true"),
	};
	const made = makeShell([aliveStub, ...stubs]);
	const { logger, warns } = captureLogger();
	const cp = createGitCheckpointer({
		shell: made.shell,
		directory: "/proj",
		logger,
		clock,
	});
	expect(await cp.ready()).toBe(true);
	return { cp, commands: made.commands, warns };
}

describe("createGitCheckpointer — baseline()", () => {
	test("records the operator's pre-existing dirty paths from the porcelain snapshot", async () => {
		const { cp } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M operator.ts\n?? operator-new.ts"),
			},
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("deadbeef") },
		]);
		await cp.baseline();
		// dirtyPaths() re-reads porcelain; the same two paths surface.
		expect((await cp.dirtyPaths()).sort()).toEqual([
			"operator-new.ts",
			"operator.ts",
		]);
		expect(cp.baselineRef()).toBe("deadbeef");
	});

	test("a fresh repo with no HEAD records null without throwing", async () => {
		const { cp } = await liveCheckpointer([
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			// Zero-commit repo: `git rev-parse HEAD` fails.
			{
				match: (c) => c.includes("rev-parse HEAD"),
				out: fail("unknown revision"),
			},
		]);
		await expect(cp.baseline()).resolves.toBeUndefined();
		expect(cp.baselineRef()).toBeNull();
	});
});

// ---- Task 2.1.4: checkpoint (commit touched, refuse operator-dirty) ------

describe("createGitCheckpointer — checkpoint()", () => {
	test("commits ONLY workflow-touched paths via explicit pathspecs, never -A", async () => {
		// No baseline call → preexistingDirty empty → src/a.ts is workflow-touched.
		const { cp, commands } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts"),
			},
			{ match: (c) => c === "git add -- src/a.ts", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("newsha1") },
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
			phase: "build",
		});
		expect(result.committed).toBe(true);
		expect(result.sha).toBe("newsha1");
		expect(result.paths).toEqual(["src/a.ts"]);
		// Explicit pathspec, never -A.
		expect(commands).toContain("git add -- src/a.ts");
		expect(commands.some((c) => c.includes("add -A"))).toBe(false);
		// Commit carries --no-verify + the identity fallback as GLOBAL -c options
		// (which precede the subcommand) so a no-identity repo still commits.
		const commitCmd = commands.find((c) => c.includes("commit --no-verify"));
		expect(commitCmd).toBeDefined();
		expect(commitCmd).toContain("-c user.name=");
		expect(commitCmd).toContain("-c user.email=");
		// The `-c` options sit BEFORE `commit`.
		expect((commitCmd as string).indexOf("-c user.name=")).toBeLessThan(
			(commitCmd as string).indexOf("commit"),
		);
	});

	test("scopes the commit to the exact staged pathspecs, never sweeping pre-staged operator content", async () => {
		// The operator pre-STAGED fileX (it is in the index before the run). The agent
		// edits fileY. A pathspec-less `git commit` would sweep fileX into the engine
		// commit; the commit MUST be scoped to `-- fileY` so fileX never lands in it.
		const { cp, commands } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/fileY.ts"),
			},
			{ match: (c) => c === "git add -- src/fileY.ts", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("newshaY") },
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(true);
		expect(result.paths).toEqual(["src/fileY.ts"]);
		const commitCmd = commands.find((c) => c.includes("commit --no-verify"));
		expect(commitCmd).toBeDefined();
		// The commit is pathspec-scoped: it names ONLY the staged path after `--`, so a
		// pre-staged operator file (anything else in the index) can never be swept in.
		expect(commitCmd).toContain("-- src/fileY.ts");
		expect((commitCmd as string).indexOf("commit")).toBeLessThan(
			(commitCmd as string).indexOf("-- src/fileY.ts"),
		);
	});

	test("refuses to commit a path that was operator-dirty at baseline, surfacing it + a warn", async () => {
		// Baseline: operator.ts already dirty. The agent ALSO edits operator.ts.
		const aliveStub: Stub = {
			match: (c) => c.includes("is-inside-work-tree"),
			out: ok("true"),
		};
		const made = makeShell([
			aliveStub,
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M operator.ts"),
			},
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.startsWith("git add"), out: ok() },
			{ match: (c) => c.includes("commit"), out: ok() },
		]);
		const { logger, warns } = captureLogger();
		const cp = createGitCheckpointer({
			shell: made.shell,
			directory: "/proj",
			logger,
			clock,
		});
		await cp.ready();
		await cp.baseline(); // records operator.ts as off-limits

		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		// operator.ts was the ONLY dirty path and it is refused → no commit at all.
		expect(result.committed).toBe(false);
		expect(result.refused).toEqual(["operator.ts"]);
		// Never staged the operator's path.
		expect(made.commands.some((c) => c.startsWith("git add"))).toBe(false);
		// And it warned loudly, naming the path.
		expect(
			warns.some((w) => JSON.stringify(w.meta).includes("operator.ts")),
		).toBe(true);
	});

	test("an empty workflow diff skips with no empty commit", async () => {
		const { cp, commands } = await liveCheckpointer([
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "w",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(false);
		expect(commands.some((c) => c.includes("commit"))).toBe(false);
	});

	test("a commit failure is fenced — no throw, committed:false", async () => {
		const { cp } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts"),
			},
			{ match: (c) => c.startsWith("git add"), out: ok() },
			{ match: (c) => c.includes("commit"), out: fail("nothing to commit?") },
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "w",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(false);
	});
});

// ---- Task 4.1.1: diff() (engine-computed working-tree delta since baseline) ----

describe("createGitCheckpointer — diff()", () => {
	test("no shell → {text:'', isEmpty:true, available:false} (documented no-op)", async () => {
		const cp = createGitCheckpointer({ shell: undefined, directory: "/proj" });
		expect(await cp.diff()).toEqual({
			text: "",
			isEmpty: true,
			available: false,
		});
	});

	test("dead latch → available:false, never diffs", async () => {
		const { shell, commands } = makeShell([
			{
				match: (c) => c.includes("rev-parse --is-inside-work-tree"),
				out: fail(),
			},
		]);
		const cp = createGitCheckpointer({ shell, directory: "/proj", clock });
		expect(await cp.ready()).toBe(false);
		expect(await cp.diff()).toEqual({
			text: "",
			isEmpty: true,
			available: false,
		});
		// No `git diff` ran — the dead latch suppressed it.
		expect(commands.some((c) => c.includes("git diff"))).toBe(false);
	});

	test("alive with a baseline → diffs against baselineRef, non-empty output", async () => {
		const { cp, commands } = await liveCheckpointer([
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("base000") },
			{
				match: (c) => c === "git diff base000",
				out: ok("diff --git a/src/a.ts b/src/a.ts\n+added"),
			},
		]);
		await cp.baseline();
		const res = await cp.diff();
		expect(res.available).toBe(true);
		expect(res.isEmpty).toBe(false);
		expect(res.text).toContain("diff --git");
		// Diffs against the run-start baseline ref (single ref, NOT `base HEAD`).
		expect(commands).toContain("git diff base000");
		expect(commands.some((c) => c.includes("git diff base000 HEAD"))).toBe(
			false,
		);
		expect(commands.some((c) => c.includes("--cached"))).toBe(false);
	});

	test("a committed-then-further-dirtied tree still diffs non-empty against baseline", async () => {
		// At reviewer-launch time, predecessor edits are already COMMITTED (HEAD past
		// baseline) AND the reviewer's own unit may have uncommitted worktree edits.
		// `git diff <baseline>` (single ref) spans both: it compares baseline-tree vs
		// the current worktree, so the cumulative since-run-start delta is non-empty.
		const { cp } = await liveCheckpointer([
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("base000") },
			{
				match: (c) => c === "git diff base000",
				out: ok("diff --git a/src/x.ts b/src/x.ts\n+committed+dirty"),
			},
		]);
		await cp.baseline();
		const res = await cp.diff();
		expect(res.isEmpty).toBe(false);
		expect(res.text).toContain("committed+dirty");
	});

	test("alive but zero git output → isEmpty:true, available:true (real empty diff)", async () => {
		const { cp } = await liveCheckpointer([
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("base000") },
			{ match: (c) => c === "git diff base000", out: ok("   \n  ") },
		]);
		await cp.baseline();
		const res = await cp.diff();
		expect(res.available).toBe(true);
		expect(res.isEmpty).toBe(true);
	});

	test("zero-commit repo (baselineRef null) → diffs the working tree with no base", async () => {
		const { cp, commands } = await liveCheckpointer([
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			// No HEAD in a zero-commit repo.
			{
				match: (c) => c === "git rev-parse HEAD",
				out: fail("unknown revision"),
			},
			{
				match: (c) => c === "git diff",
				out: ok("diff --git a/new.ts b/new.ts\n+x"),
			},
		]);
		await cp.baseline();
		expect(cp.baselineRef()).toBeNull();
		const res = await cp.diff();
		expect(res.available).toBe(true);
		expect(res.isEmpty).toBe(false);
		// No base ref interpolated.
		expect(commands).toContain("git diff");
	});

	test("a non-zero git diff exit is fenced → treated as empty text, never rejects", async () => {
		const { cp } = await liveCheckpointer([
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("base000") },
			{ match: (c) => c === "git diff base000", out: fail("boom") },
		]);
		await cp.baseline();
		const res = await cp.diff();
		expect(res.available).toBe(true);
		expect(res.isEmpty).toBe(true);
		expect(res.text).toBe("");
	});
});
