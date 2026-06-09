import { describe, expect, test } from "bun:test";
import {
	checkpointRefFor,
	commitMessageFor,
	createGitCheckpointer,
	parseModeFlips,
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

// ---- Task 1.1.1: checkpoint captures already-staged deletions ------------

describe("createGitCheckpointer — checkpoint() already-staged deletions", () => {
	test("an already-staged deletion (git rm) whose `git add` fails is kept via --cached and committed", async () => {
		// `git rm f.ts` removes f.ts from disk and stages the deletion (porcelain `D `).
		// `git add -- f.ts` then fails (`fatal: pathspec did not match any files`): the
		// file matches neither a working-tree nor a tracked-and-present pathspec. The fix
		// detects the path is ALREADY in the index (`git diff --cached --name-only`
		// non-empty) and keeps it in the commit set; the scoped commit commits it.
		const { cp, commands } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok("D  src/f.ts"),
			},
			// add fails — the file is gone from disk, already staged.
			{ match: (c) => c === "git add -- src/f.ts", out: fail("pathspec") },
			// --cached shows it staged.
			{
				match: (c) => c === "git diff --cached --name-only -- src/f.ts",
				out: ok("src/f.ts"),
			},
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("delsha1") },
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(true);
		expect(result.sha).toBe("delsha1");
		expect(result.paths).toEqual(["src/f.ts"]);
		const commitCmd = commands.find((c) => c.includes("commit --no-verify"));
		expect(commitCmd).toContain("-- src/f.ts");
	});

	test("a git mv (delete old + add new) commits both the new path and the staged old deletion", async () => {
		// `git mv old.ts new.ts` stages a deletion of old.ts (gone from disk) and an add
		// of new.ts. `git add -- new.ts` succeeds; `git add -- old.ts` fails but old.ts
		// is staged, so both land in the commit.
		const { cp, commands } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok("A  src/new.ts\nD  src/old.ts"),
			},
			{ match: (c) => c === "git add -- src/new.ts", out: ok() },
			{ match: (c) => c === "git add -- src/old.ts", out: fail("pathspec") },
			{
				match: (c) => c === "git diff --cached --name-only -- src/old.ts",
				out: ok("src/old.ts"),
			},
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("mvsha1") },
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(true);
		expect((result.paths as string[]).sort()).toEqual([
			"src/new.ts",
			"src/old.ts",
		]);
		const commitCmd = commands.find((c) => c.includes("commit --no-verify"));
		expect(commitCmd).toContain("src/new.ts");
		expect(commitCmd).toContain("src/old.ts");
	});

	test("a genuinely bad pathspec (add fails AND not staged) is still skipped + warned", async () => {
		// add fails and --cached is empty → the path was never staged (a typo, or a
		// concurrently re-removed path): retain warn-and-skip, never commit it.
		const { cp, commands, warns } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/ghost.ts"),
			},
			{ match: (c) => c === "git add -- src/ghost.ts", out: fail("pathspec") },
			{
				match: (c) => c === "git diff --cached --name-only -- src/ghost.ts",
				out: ok(""),
			},
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		// The only touched path failed and was unstaged → nothing to commit.
		expect(result.committed).toBe(false);
		expect(commands.some((c) => c.includes("commit"))).toBe(false);
		expect(
			warns.some((w) => JSON.stringify(w.meta).includes("src/ghost.ts")),
		).toBe(true);
	});

	test("an operator-dirty staged deletion is refused at baseline, never reaching the add loop", async () => {
		// The operator staged a deletion of operator-del.ts BEFORE the run (it is dirty at
		// baseline). The fix must not sweep it into an engine commit: it is excluded into
		// `refused` upstream of the staging loop, so no `git add`/`--cached` ever runs.
		const aliveStub: Stub = {
			match: (c) => c.includes("is-inside-work-tree"),
			out: ok("true"),
		};
		const made = makeShell([
			aliveStub,
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok("D  operator-del.ts"),
			},
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
		]);
		const { logger, warns } = captureLogger();
		const cp = createGitCheckpointer({
			shell: made.shell,
			directory: "/proj",
			logger,
			clock,
		});
		await cp.ready();
		await cp.baseline(); // records operator-del.ts as off-limits
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(false);
		expect(result.refused).toEqual(["operator-del.ts"]);
		// Never touched the staged operator deletion — no add, no --cached, no commit.
		expect(made.commands.some((c) => c.startsWith("git add"))).toBe(false);
		expect(made.commands.some((c) => c.includes("--cached"))).toBe(false);
		expect(made.commands.some((c) => c.includes("commit"))).toBe(false);
		expect(
			warns.some((w) => JSON.stringify(w.meta).includes("operator-del.ts")),
		).toBe(true);
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

// ---- Task 2.3.1: parseModeFlips (mode-aware change enumeration) ----------

describe("parseModeFlips", () => {
	const line = (
		oldmode: string,
		newmode: string,
		oldsha: string,
		newsha: string,
		status: string,
		path: string,
	) => `:${oldmode} ${newmode} ${oldsha} ${newsha} ${status}\t${path}`;

	test("a chmod (100644→100755, equal blobs) yields the transition", () => {
		const out = line(
			"100644",
			"100755",
			"abc1234",
			"abc1234",
			"M",
			"scripts/foo.sh",
		);
		expect(parseModeFlips(out)).toEqual({ "scripts/foo.sh": "100644→100755" });
	});

	test("a creation (000000→100644) is excluded (not a chmod)", () => {
		const out = line(
			"000000",
			"100644",
			"000000",
			"def5678",
			"A",
			"src/new.ts",
		);
		expect(parseModeFlips(out)).toEqual({});
	});

	test("a deletion (100755→000000) is excluded", () => {
		const out = line(
			"100755",
			"000000",
			"ghi9012",
			"000000",
			"D",
			"src/old.ts",
		);
		expect(parseModeFlips(out)).toEqual({});
	});

	test("a content-only change (equal modes) yields no entry", () => {
		const out = line("100644", "100644", "aaa", "bbb", "M", "src/edit.ts");
		expect(parseModeFlips(out)).toEqual({});
	});

	test("a path with spaces (TAB-delimited) parses its path correctly", () => {
		const out = line("100644", "100755", "abc", "abc", "M", "scripts/a b.sh");
		expect(parseModeFlips(out)).toEqual({ "scripts/a b.sh": "100644→100755" });
	});

	test("empty / non-colon stdout → empty map", () => {
		expect(parseModeFlips("")).toEqual({});
		expect(parseModeFlips("not a diff-tree line\n")).toEqual({});
	});
});

// ---- Task 4.1.1: per-run ref marker / promote() / discard() -------------

describe("checkpointRefFor", () => {
	test("derives the per-run marker ref from the runId", () => {
		expect(checkpointRefFor("wf_abc")).toBe("refs/wf-checkpoints/wf_abc");
	});
});

describe("createGitCheckpointer — per-run ref marker / promote / discard", () => {
	/**
	 * Build a live checkpointer, capture its baseline (HEAD = `baseSha`), and run one
	 * successful checkpoint that commits `src/a.ts` → HEAD `headSha`, advancing the
	 * marker. The default-empty fake answers `update-ref` with exitCode 0. Returns the
	 * checkpointer plus the recorded command lists for assertion.
	 */
	async function committedCheckpointer(
		extraStubs: Stub[] = [],
		opts: { baseSha?: string; headSha?: string } = {},
	) {
		const baseSha = opts.baseSha ?? "base000";
		const headSha = opts.headSha ?? "sha_x";
		const aliveStub: Stub = {
			match: (c) => c.includes("is-inside-work-tree"),
			out: ok("true"),
		};
		// `rev-parse HEAD` is read at baseline() (→ baseSha) AND after the commit
		// (→ headSha). Track call order so the same command returns the right value.
		let revParseHeadCalls = 0;
		// Porcelain: CLEAN at baseline() (so src/a.ts is workflow-touched, not operator-
		// dirty), DIRTY at the checkpoint() read.
		let porcelainCalls = 0;
		const made = makeShell([
			aliveStub,
			{
				match: (c) => c.includes("status --porcelain"),
				get out() {
					porcelainCalls += 1;
					return porcelainCalls === 1 ? ok("") : ok(" M src/a.ts");
				},
			},
			{ match: (c) => c === "git add -- src/a.ts", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{
				match: (c) => c === "git rev-parse HEAD",
				get out() {
					revParseHeadCalls += 1;
					return revParseHeadCalls === 1 ? ok(baseSha) : ok(headSha);
				},
			},
			...extraStubs,
		]);
		const { logger, warns } = captureLogger();
		const cp = createGitCheckpointer({
			shell: made.shell,
			directory: "/proj",
			logger,
			clock,
		});
		await cp.ready();
		await cp.baseline();
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		return {
			cp,
			result,
			commands: made.commands,
			quietedCommands: made.quietedCommands,
			warns,
		};
	}

	test("a successful checkpoint advances refs/wf-checkpoints/<runId> via a quieted update-ref", async () => {
		const { result, commands, quietedCommands } = await committedCheckpointer();
		expect(result.committed).toBe(true);
		expect(result.sha).toBe("sha_x");
		expect(commands).toContain("git update-ref refs/wf-checkpoints/wf_1 sha_x");
		expect(quietedCommands).toContain(
			"git update-ref refs/wf-checkpoints/wf_1 sha_x",
		);
	});

	test("promote() deletes the marker and NEVER rewinds the branch", async () => {
		const { cp, commands } = await committedCheckpointer();
		await cp.promote();
		expect(commands).toContain("git update-ref -d refs/wf-checkpoints/wf_1");
		// Promotion never touches the branch.
		expect(commands.some((c) => c.startsWith("git update-ref HEAD"))).toBe(
			false,
		);
	});

	test("discard() with branch tip == marker tip rewinds HEAD to baseline, THEN deletes the marker", async () => {
		// After the commit, both `rev-parse HEAD` and `rev-parse <marker>` read sha_x.
		const { cp, commands } = await committedCheckpointer([
			{
				match: (c) => c === "git rev-parse refs/wf-checkpoints/wf_1",
				out: ok("sha_x"),
			},
		]);
		// committedCheckpointer's `rev-parse HEAD` returns headSha (sha_x) on the 2nd+
		// call, so discard()'s branch-tip read == marker tip → rewind fires.
		await cp.discard();
		const rewindIdx = commands.indexOf("git update-ref HEAD base000");
		const delIdx = commands.indexOf(
			"git update-ref -d refs/wf-checkpoints/wf_1",
		);
		expect(rewindIdx).toBeGreaterThanOrEqual(0);
		expect(delIdx).toBeGreaterThanOrEqual(0);
		// Rewind precedes the marker delete.
		expect(rewindIdx).toBeLessThan(delIdx);
	});

	test("discard() with a diverged branch tip SKIPS the rewind, deletes the marker, warns with the residue sha", async () => {
		// Branch tip moved to operator_sha (operator layered a commit) while the marker
		// still points at sha_x → the guard fails → no rewind.
		let revParseHeadCalls = 0;
		let porcelainCalls = 0;
		const aliveStub: Stub = {
			match: (c) => c.includes("is-inside-work-tree"),
			out: ok("true"),
		};
		const made = makeShell([
			aliveStub,
			{
				match: (c) => c.includes("status --porcelain"),
				get out() {
					porcelainCalls += 1;
					return porcelainCalls === 1 ? ok("") : ok(" M src/a.ts");
				},
			},
			{ match: (c) => c === "git add -- src/a.ts", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{
				match: (c) => c === "git rev-parse HEAD",
				get out() {
					revParseHeadCalls += 1;
					// baseline → base000; post-commit read-back → sha_x; discard branch
					// tip → operator_sha (an operator layered work on top).
					if (revParseHeadCalls === 1) return ok("base000");
					if (revParseHeadCalls === 2) return ok("sha_x");
					return ok("operator_sha");
				},
			},
			{
				match: (c) => c === "git rev-parse refs/wf-checkpoints/wf_1",
				out: ok("sha_x"),
			},
		]);
		const { logger, warns } = captureLogger();
		const cp = createGitCheckpointer({
			shell: made.shell,
			directory: "/proj",
			logger,
			clock,
		});
		await cp.ready();
		await cp.baseline();
		await cp.checkpoint({ runId: "wf_1", label: "worker", sessionID: "ses_1" });
		await cp.discard();
		// No rewind (would discard the operator's commit).
		expect(made.commands.some((c) => c.startsWith("git update-ref HEAD"))).toBe(
			false,
		);
		// Marker still deleted.
		expect(made.commands).toContain(
			"git update-ref -d refs/wf-checkpoints/wf_1",
		);
		// Warns naming the residue marker tip.
		expect(warns.some((w) => JSON.stringify(w.meta).includes("sha_x"))).toBe(
			true,
		);
	});

	test("promote()/discard() with no prior commit emit no ref ops (command-asserted)", async () => {
		const aliveStub: Stub = {
			match: (c) => c.includes("is-inside-work-tree"),
			out: ok("true"),
		};
		const made = makeShell([
			aliveStub,
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("base000") },
		]);
		const cp = createGitCheckpointer({
			shell: made.shell,
			directory: "/proj",
			clock,
		});
		await cp.ready();
		await cp.baseline();
		await cp.checkpoint({ runId: "wf_1", label: "worker", sessionID: "ses_1" });
		await cp.promote();
		await cp.discard();
		expect(made.commands.some((c) => c.startsWith("git update-ref"))).toBe(
			false,
		);
	});

	test("discard() on a zero-commit repo (baselineRef null) skips the rewind, deletes the marker, warns", async () => {
		// baseline() finds no HEAD (baselineRef null), but a checkpoint still commits and
		// the marker advances. discard()'s guard fails on the null baseline → no rewind.
		const aliveStub: Stub = {
			match: (c) => c.includes("is-inside-work-tree"),
			out: ok("true"),
		};
		let revParseHeadCalls = 0;
		let porcelainCalls = 0;
		const made = makeShell([
			aliveStub,
			{
				match: (c) => c.includes("status --porcelain"),
				get out() {
					porcelainCalls += 1;
					return porcelainCalls === 1 ? ok("") : ok(" M src/a.ts");
				},
			},
			{ match: (c) => c === "git add -- src/a.ts", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{
				match: (c) => c === "git rev-parse HEAD",
				get out() {
					revParseHeadCalls += 1;
					// baseline → no HEAD (zero-commit); post-commit read-back → first commit.
					if (revParseHeadCalls === 1) return fail("unknown revision");
					return ok("firstsha");
				},
			},
			{
				match: (c) => c === "git rev-parse refs/wf-checkpoints/wf_1",
				out: ok("firstsha"),
			},
		]);
		const { logger, warns } = captureLogger();
		const cp = createGitCheckpointer({
			shell: made.shell,
			directory: "/proj",
			logger,
			clock,
		});
		await cp.ready();
		await cp.baseline();
		expect(cp.baselineRef()).toBeNull();
		await cp.checkpoint({ runId: "wf_1", label: "worker", sessionID: "ses_1" });
		await cp.discard();
		expect(made.commands.some((c) => c.startsWith("git update-ref HEAD"))).toBe(
			false,
		);
		expect(made.commands).toContain(
			"git update-ref -d refs/wf-checkpoints/wf_1",
		);
		expect(warns.length).toBeGreaterThan(0);
	});

	test("promote()/discard() on a dead (no-shell) checkpointer are no-ops", async () => {
		const cp = createGitCheckpointer({ shell: undefined, directory: "/proj" });
		await expect(cp.promote()).resolves.toBeUndefined();
		await expect(cp.discard()).resolves.toBeUndefined();
	});
});

describe("createGitCheckpointer — checkpoint() modeFlips", () => {
	test("a chmod commit attaches the mode transition to the result", async () => {
		const made = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M scripts/foo.sh"),
			},
			{ match: (c) => c === "git add -- scripts/foo.sh", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("flipsha1") },
			{
				match: (c) => c.includes("diff-tree"),
				out: ok(":100644 100755 abc abc M\tscripts/foo.sh"),
			},
		]);
		const cp = createGitCheckpointer({
			shell: made.shell,
			directory: "/proj",
			clock,
		});
		expect(await cp.ready()).toBe(true);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "worker",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(true);
		expect(result.modeFlips).toEqual({ "scripts/foo.sh": "100644→100755" });
		// The diff-tree read is fenced + quieted (host-fd safety).
		const dt = made.commands.find((c) => c.includes("diff-tree"));
		expect(dt).toBeDefined();
		expect(made.quietedCommands.some((c) => c.includes("diff-tree"))).toBe(
			true,
		);
	});

	test("a content-only commit yields no modeFlips field", async () => {
		const { cp } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts"),
			},
			{ match: (c) => c === "git add -- src/a.ts", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("contentsha") },
			{
				match: (c) => c.includes("diff-tree"),
				out: ok(":100644 100644 aaa bbb M\tsrc/a.ts"),
			},
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "w",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(true);
		expect(result.modeFlips).toBeUndefined();
	});

	test("a diff-tree failure is fenced → modeFlips omitted, commit still reported", async () => {
		const { cp } = await liveCheckpointer([
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts"),
			},
			{ match: (c) => c === "git add -- src/a.ts", out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c === "git rev-parse HEAD", out: ok("anysha") },
			{ match: (c) => c.includes("diff-tree"), out: fail("boom") },
		]);
		const result = await cp.checkpoint({
			runId: "wf_1",
			label: "w",
			sessionID: "ses_1",
		});
		expect(result.committed).toBe(true);
		expect(result.modeFlips).toBeUndefined();
	});
});
