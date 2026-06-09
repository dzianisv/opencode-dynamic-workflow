import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { branchFor, createWorktreeManager } from "./git-worktree";

/**
 * Tests for the git-worktree module (Epic H.1.1). Mirrors the git-checkpoint
 * test harness EXACTLY: the host `$` (BunShell) is a TAGGED-TEMPLATE callable —
 * `$\`git worktree add …\`` — so the fake reconstructs the command string by
 * zipping the {@link TemplateStringsArray} with the interpolated expressions,
 * then returns a canned {@link FakeOutput} keyed by a matcher. No real git, no
 * real shell: the module is fenced and pure-by-injection.
 *
 * Beyond the checkpoint harness this models `.quiet()` on the ShellPromise (the
 * TTY-safety contract, T.1) so every git command can be asserted suppressed.
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
		// Model `.quiet()` on the returned promise (the namespace does not carry it).
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
		braces: (path: string) => [path],
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

describe("branchFor", () => {
	test("encodes runId + label into a wf/<runId>/<label> scratch branch", () => {
		expect(branchFor({ runId: "wf_1", label: "worker" })).toBe(
			"wf/wf_1/worker",
		);
	});

	test("sanitizes label segments that are illegal in a git ref", () => {
		// Spaces, slashes, and other ref-hostile chars collapse to '-' so
		// `git worktree add -b` never fails on the branch name.
		const branch = branchFor({ runId: "wf_1", label: "build the thing!" });
		expect(branch.startsWith("wf/wf_1/")).toBe(true);
		expect(branch).not.toContain(" ");
		expect(branch).not.toContain("!");
		// The runId prefix is preserved verbatim under the wf/ namespace.
		expect(branch).toContain("wf/wf_1/");
	});

	test("a pure-dot label ('.' / '..' / '...') NEVER yields a '.' or '..' segment", () => {
		// A '..' component is forbidden in a git ref (the worktree add would degrade to
		// null) AND traverses out of the managed root in the dir path (re-pointing a
		// `worktree remove --force` at a parent). A pure-dot label carries no identity →
		// it must fall back to 'agent', never survive verbatim.
		for (const label of [".", "..", "..."]) {
			const branch = branchFor({ runId: "wf_1", label });
			const segment = branch.slice("wf/wf_1/".length);
			expect(segment).not.toBe(".");
			expect(segment).not.toBe("..");
			expect(segment).toBe("agent");
		}
	});

	test("the computed dir for a '..' label still resolves UNDER the worktree root (no traversal)", async () => {
		// End-to-end guard: a '..' label must not collapse the run dir away. The minted
		// dir must remain a descendant of <repo>/../.wf-worktrees, not a parent of it.
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: ".." })) as {
			dir: string;
			branch: string;
		};
		// worktreeRoot = join('/proj','..','.wf-worktrees') = '/.wf-worktrees'.
		expect(created.dir.startsWith("/.wf-worktrees/wf_1/")).toBe(true);
		// The traversal failure would have produced '/.wf-worktrees' (run dir collapsed).
		expect(created.dir).not.toBe("/.wf-worktrees");
		expect(created.dir.endsWith("/agent")).toBe(true);
		expect(created.branch).toBe("wf/wf_1/agent");
	});

	test("an all-hostile label falls back to the 'agent' segment", () => {
		// '///' has no whitelisted chars → empty after sanitize → fallback to 'agent'.
		expect(branchFor({ runId: "wf_1", label: "///" })).toBe("wf/wf_1/agent");
	});

	test("distinct labels that sanitize to the SAME segment collide (de-dup is the caller's job)", () => {
		// 'a b' (space→'-') and 'a-b' both collapse to 'a-b'. Pinning this documents that
		// the module does NOT de-dup: two agents with colliding labels share a branch+dir.
		// If isolation must survive label collisions, the CALLER must disambiguate.
		expect(branchFor({ runId: "wf_1", label: "a b" })).toBe(
			branchFor({ runId: "wf_1", label: "a-b" }),
		);
	});
});

describe("createWorktreeManager — no shell → documented no-op", () => {
	test("undefined shell yields a manager whose create returns null and the rest no-op", async () => {
		const mgr = createWorktreeManager({ shell: undefined, directory: "/proj" });
		expect(await mgr.create({ runId: "wf_1", label: "w" })).toBeNull();
		expect(await mgr.mergeBack("/wt", "wf/wf_1/w")).toEqual({ merged: true });
		expect(await mgr.isUnchanged("/wt")).toBe(true);
		await mgr.cleanup("/wt", "wf/wf_1/w");
		await mgr.sweep();
	});
});

describe("createWorktreeManager — create()", () => {
	test("adds a worktree on a scratch branch ROOTED OUTSIDE the working tree, fenced + quieted", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const res = await mgr.create({ runId: "wf_1", label: "worker" });
		expect(res).not.toBeNull();
		const created = res as { dir: string; branch: string };
		expect(created.branch).toBe("wf/wf_1/worker");

		// The worktree dir is OUTSIDE the working tree (NOT under /proj itself, NOT
		// inside /proj/.git). A sibling-rooted managed dir.
		expect(created.dir.startsWith("/proj/")).toBe(false);
		expect(created.dir.includes("/.git/")).toBe(false);

		const add = commands.find((c) => c.includes("worktree add"));
		expect(add).toBeDefined();
		// `-b <branch> <dir> HEAD` shape per the locked design.
		expect(add).toContain("worktree add -b wf/wf_1/worker");
		expect(add).toContain(created.dir);
		expect(add).toContain("HEAD");

		// Every git command was quieted (TTY safety, T.1).
		for (const c of commands.filter((c) => c.startsWith("git"))) {
			expect(quietedCommands).toContain(c);
		}
	});

	test("a non-repo (probe fails) returns null without throwing — caller degrades", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.create({ runId: "wf_1", label: "w" })).resolves.toBeNull();
		// Never attempted the add after the dead probe.
		expect(commands.some((c) => c.includes("worktree add"))).toBe(false);
	});

	test("a failed `worktree add` returns null (fenced, non-throwing)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: fail("locked") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.create({ runId: "wf_1", label: "w" })).resolves.toBeNull();
	});

	test("SERIALIZES concurrent creates through a single promise-chain mutex", async () => {
		// Two adds fired concurrently must not interleave: the second `worktree add`
		// only begins after the first create's whole sequence has run. We assert the
		// command ORDER proves serialization (add1 fully precedes add2).
		let resolveFirstAdd: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			resolveFirstAdd = r;
		});
		let addCount = 0;
		const order: string[] = [];
		// A bespoke shell that defers the FIRST `worktree add` until we release it.
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
		const shellFn = (
			strings: TemplateStringsArray,
			...expressions: unknown[]
		) => {
			const cmd = reconstruct(strings, expressions);
			commands.push(cmd);
			const result = (stdout: string) => {
				const p = Promise.resolve({
					stdout: { toString: () => stdout },
					stderr: { toString: () => "" },
					exitCode: 0,
					text: () => stdout,
				});
				Object.assign(p, { quiet: () => p });
				return p;
			};
			if (cmd.includes("is-inside-work-tree")) return result("true");
			if (cmd.includes("rev-parse HEAD")) return result("base000");
			if (cmd.includes("worktree add")) {
				addCount += 1;
				const which = addCount;
				order.push(`add-start-${which}`);
				if (which === 1) {
					const p = gate.then(() => {
						order.push("add-done-1");
						return {
							stdout: { toString: () => "" },
							stderr: { toString: () => "" },
							exitCode: 0,
							text: () => "",
						};
					});
					Object.assign(p, { quiet: () => p });
					return p;
				}
				order.push(`add-done-${which}`);
				return result("");
			}
			return result("");
		};
		const chain = Object.assign(shellFn, {
			cwd: () => chain,
			nothrow: () => chain,
			env: () => chain,
			braces: (p: string) => [p],
			escape: (s: string) => s,
			throws: () => chain,
		});
		const mgr = createWorktreeManager({
			// biome-ignore lint/suspicious/noExplicitAny: structural BunShell fake.
			shell: chain as any,
			directory: "/proj",
		});

		const p1 = mgr.create({ runId: "wf_1", label: "a" });
		const p2 = mgr.create({ runId: "wf_1", label: "b" });
		// Drain microtasks until add-1 is actually IN FLIGHT. create-1 must traverse the
		// mutex link + `await alive()` + `await is-inside-work-tree` before it reaches the
		// gated `worktree add`, which is several microtask hops — a fixed `await
		// Promise.resolve()` count would check BEFORE add-1 even starts, making the
		// "add-2 blocked" assertion vacuous (order would be empty). Spin until add-1
		// starts (bounded) so the invariant is exercised mid-flight.
		for (let i = 0; i < 50 && !order.includes("add-start-1"); i += 1) {
			await Promise.resolve();
		}
		// Guard: only trust the next assertion once add-1 is genuinely in flight.
		expect(order.includes("add-start-1")).toBe(true);
		// add-1 is gated (unresolved) → the mutex must hold add-2 behind it. If creates
		// were unserialized, add-2 would already have started.
		expect(order.includes("add-start-2")).toBe(false);
		// Release the first add; both should now complete in order.
		resolveFirstAdd?.();
		await Promise.all([p1, p2]);
		// add-1's whole turn completed before add-2 began.
		expect(order.indexOf("add-done-1")).toBeLessThan(
			order.indexOf("add-start-2"),
		);
	});
});

describe("createWorktreeManager — mergeBack()", () => {
	test("a clean `merge --no-ff` returns { merged: true }, quieted", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("merge --no-ff"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const res = await mgr.mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({ merged: true });
		const merge = commands.find((c) => c.includes("merge --no-ff")) as string;
		expect(merge).toContain("wf/wf_1/worker");
		expect(quietedCommands).toContain(merge);
		// A clean merge never aborts.
		expect(commands.some((c) => c.includes("merge --abort"))).toBe(false);
	});

	test("a conflicting merge captures the unmerged files, aborts, returns Tier 1 conflict", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{
				match: (c) => c.includes("merge --no-ff"),
				out: fail("CONFLICT (content): Merge conflict in src/a.ts"),
			},
			{
				match: (c) => c.includes("diff --name-only --diff-filter=U"),
				out: ok("src/a.ts\nsrc/b.ts"),
			},
			{ match: (c) => c.includes("merge --abort"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		// No recorded base for "/wt" (mergeBack called directly) → baseRef undefined.
		const res = await mgr.mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({
			conflict: true,
			branch: "wf/wf_1/worker",
			files: ["src/a.ts", "src/b.ts"],
			baseRef: undefined,
		});
		// It aborted the merge to leave the MAIN tree clean.
		expect(commands.some((c) => c.includes("merge --abort"))).toBe(true);
	});

	test("a real conflict carries the create-time base as baseRef (Tier 2 3-way context)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{
				match: (c) => c.includes("merge --no-ff"),
				out: fail("CONFLICT (content): Merge conflict in src/a.ts"),
			},
			{
				match: (c) => c.includes("diff --name-only --diff-filter=U"),
				out: ok("src/a.ts"),
			},
			{ match: (c) => c.includes("merge --abort"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "worker" })) as {
			dir: string;
			branch: string;
		};
		const res = await mgr.mergeBack(created.dir, created.branch);
		expect(res).toEqual({
			conflict: true,
			branch: "wf/wf_1/worker",
			files: ["src/a.ts"],
			baseRef: "base000",
		});
	});

	test("a NON-conflict merge failure (zero unmerged files) aborts and returns { failed } — NOT a phantom conflict", async () => {
		// 'local changes would be overwritten by merge' / 'not something we can merge':
		// git exits non-zero but diff --diff-filter=U is empty. Must NOT report conflict.
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{
				match: (c) => c.includes("merge --no-ff"),
				out: fail(
					"error: Your local changes to the following files would be overwritten by merge",
				),
			},
			{
				match: (c) => c.includes("diff --name-only --diff-filter=U"),
				out: ok(""),
			},
			{ match: (c) => c.includes("merge --abort"), out: ok() },
		]);
		const { logger, warns } = captureLogger();
		const mgr = createWorktreeManager({ shell, directory: "/proj", logger });
		const res = await mgr.mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({ failed: true });
		// It still aborted (harmless no-op) to leave the MAIN tree clean.
		expect(commands.some((c) => c.includes("merge --abort"))).toBe(true);
		// It warned about the degrade rather than raising a Tier 1 conflict.
		expect(warns).toHaveLength(1);
	});

	test("dead latch / no shell → { merged: true } (degrade, no git)", async () => {
		const mgr = createWorktreeManager({ shell: undefined, directory: "/proj" });
		expect(await mgr.mergeBack("/wt", "wf/wf_1/w")).toEqual({ merged: true });
	});

	test("commits the worktree's UNCOMMITTED edits onto the scratch branch BEFORE merging (no silent loss)", async () => {
		// The critical-finding guard: a worker's edits live as UNCOMMITTED changes in the
		// worktree checkout — nothing else commits them. Without a pre-merge commit, the
		// scratch branch sits at base HEAD, the merge is a no-op, and cleanup destroys the
		// work. mergeBack MUST stage the dirty paths (EXPLICIT pathspecs, never `-A`) and
		// commit them onto the branch BEFORE the merge, so the merge actually carries them.
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			// The worktree has uncommitted edits at merge-back time.
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts\n?? src/b.ts"),
			},
			{ match: (c) => c.includes("git add -- "), out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c.includes("merge --no-ff"), out: ok() },
		]);
		const res = await createWorktreeManager({
			shell,
			directory: "/proj",
		}).mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({ merged: true });

		// It staged BOTH dirty paths as explicit pathspecs (NEVER `git add -A`).
		expect(commands.some((c) => c === "git add -- src/a.ts")).toBe(true);
		expect(commands.some((c) => c === "git add -- src/b.ts")).toBe(true);
		expect(commands.some((c) => c.includes("git add -A"))).toBe(false);

		// It committed onto the scratch branch with --no-verify + the identity fallback,
		// BEFORE the merge (commit index must precede the merge index).
		const commitIdx = commands.findIndex((c) =>
			c.includes("commit --no-verify"),
		);
		const mergeIdx = commands.findIndex((c) => c.includes("merge --no-ff"));
		expect(commitIdx).toBeGreaterThanOrEqual(0);
		expect(mergeIdx).toBeGreaterThan(commitIdx);
		const commit = commands[commitIdx] as string;
		expect(commit).toContain("user.name=opencode-drawers");
		expect(commit).toContain("commit --no-verify");
		// The commit is SCOPED to the exact staged pathspecs (`-- <paths>`): real BunShell
		// escapes the interpolated array element-wise into separate args; the fake's
		// reconstruct joins with ',' — either way both staged paths ride the commit.
		expect(commit).toContain("src/a.ts");
		expect(commit).toContain("src/b.ts");
		expect(commit).toContain(" -- ");

		// Every git command quieted (TTY safety, T.1) — including the new add/commit.
		for (const c of commands.filter((c) => c.startsWith("git"))) {
			expect(quietedCommands).toContain(c);
		}
	});

	test("a clean worktree (empty porcelain) makes NO pre-merge commit", async () => {
		// When the worktree has no uncommitted edits there is nothing to commit — the
		// branch already carries whatever it carries. mergeBack must NOT fabricate an
		// empty commit; it goes straight to the merge.
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("merge --no-ff"), out: ok() },
		]);
		const res = await createWorktreeManager({
			shell,
			directory: "/proj",
		}).mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({ merged: true });
		expect(commands.some((c) => c.includes("git add"))).toBe(false);
		expect(commands.some((c) => c.includes("commit --no-verify"))).toBe(false);
	});
});

describe("createWorktreeManager — isUnchanged()", () => {
	test("clean porcelain AND zero commits ahead → true", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("rev-list --count"), out: ok("0") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(true);
	});

	test("dirty porcelain → false (worktree edits not yet committed)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts"),
			},
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});

	test("clean porcelain BUT commits ahead of base → false", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("rev-list --count"), out: ok("2") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});

	test("an unknown dir (no recorded base) treats commits-ahead as unknown → not unchanged when dirty", async () => {
		// Defensive: isUnchanged on a dir the manager never minted still fences on
		// porcelain. A dirty unknown dir is changed.
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M x.ts"),
			},
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		expect(await mgr.isUnchanged("/some/orphan")).toBe(false);
	});

	test("a CLEAN orphan dir (no recorded base) is NOT provably unchanged → false (never drops work)", async () => {
		// The safe-default: with no recorded base we cannot count commits-ahead, so even a
		// clean porcelain cannot PROVE the worktree is unchanged. Returning true here would
		// route a committed-but-base-lost worktree to cleanup and drop its branch. Must be
		// false so the caller merges instead.
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		expect(await mgr.isUnchanged("/some/orphan")).toBe(false);
		// It never reaches rev-list (no base to diff against).
		expect(commands.some((c) => c.includes("rev-list --count"))).toBe(false);
	});

	test("a non-zero `status --porcelain` is NOT provably unchanged → false (safe default)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});

	test("a clean porcelain but failing `rev-list --count` is NOT provably unchanged → false", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("rev-list --count"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});
});

describe("createWorktreeManager — cleanup()", () => {
	test("removes the worktree --force then deletes the branch, both fenced + quieted", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree remove"), out: ok() },
			{ match: (c) => c.includes("branch -D"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await mgr.cleanup("/wt", "wf/wf_1/worker");
		const remove = commands.find((c) =>
			c.includes("worktree remove"),
		) as string;
		expect(remove).toContain("--force");
		expect(remove).toContain("/wt");
		const del = commands.find((c) => c.includes("branch -D")) as string;
		expect(del).toContain("wf/wf_1/worker");
		expect(quietedCommands).toContain(remove);
		expect(quietedCommands).toContain(del);
	});

	test("a failing remove does NOT prevent the branch delete (best-effort, fenced)", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree remove"), out: fail("busy") },
			{ match: (c) => c.includes("branch -D"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.cleanup("/wt", "wf/wf_1/worker")).resolves.toBeUndefined();
		expect(commands.some((c) => c.includes("branch -D"))).toBe(true);
	});
});

describe("createWorktreeManager — sweep()", () => {
	test("prunes orphan wf/* worktrees AND branches from a crashed prior run", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree prune"), out: ok() },
			{
				match: (c) => c.includes("for-each-ref"),
				out: ok("wf/old_run/a\nwf/old_run/b"),
			},
			{ match: (c) => c.includes("branch -D"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await mgr.sweep();
		// Prunes stale worktree admin entries first.
		expect(commands.some((c) => c.includes("worktree prune"))).toBe(true);
		// Enumerates only wf/* branches, then deletes each.
		const enumCmd = commands.find((c) => c.includes("for-each-ref"));
		expect(enumCmd).toContain("refs/heads/wf/");
		expect(commands.some((c) => c.includes("branch -D wf/old_run/a"))).toBe(
			true,
		);
		expect(commands.some((c) => c.includes("branch -D wf/old_run/b"))).toBe(
			true,
		);
		// Every command quieted.
		for (const c of commands.filter((c) => c.startsWith("git"))) {
			expect(quietedCommands).toContain(c);
		}
	});

	test("no orphan wf/* branches → prune only, no branch deletes", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree prune"), out: ok() },
			{ match: (c) => c.includes("for-each-ref"), out: ok("") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.sweep()).resolves.toBeUndefined();
		expect(commands.some((c) => c.includes("branch -D"))).toBe(false);
	});

	test("sweep is fenced — a failing for-each-ref never throws", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree prune"), out: ok() },
			{ match: (c) => c.includes("for-each-ref"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.sweep()).resolves.toBeUndefined();
	});
});

describe("createWorktreeManager — non-repo dead latch shared across the manager", () => {
	test("a non-repo latches dead on first use; mergeBack/cleanup/sweep all no-op", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: fail() },
		]);
		const { logger, warns } = captureLogger();
		const mgr = createWorktreeManager({ shell, directory: "/proj", logger });
		expect(await mgr.create({ runId: "wf_1", label: "w" })).toBeNull();
		// Later calls do not re-probe and do not run git mutations.
		expect(await mgr.mergeBack("/wt", "wf/wf_1/w")).toEqual({ merged: true });
		await mgr.cleanup("/wt", "wf/wf_1/w");
		await mgr.sweep();
		expect(await mgr.isUnchanged("/wt")).toBe(true);
		// Exactly one probe, one warn, no mutating git.
		expect(
			commands.filter((c) => c.includes("is-inside-work-tree")),
		).toHaveLength(1);
		expect(warns).toHaveLength(1);
		expect(commands.some((c) => c.includes("worktree add"))).toBe(false);
		expect(commands.some((c) => c.includes("merge"))).toBe(false);
	});
});

/**
 * Issue 6 structural half — real-git temp-repo harness (the spec's required pattern):
 * a registered UNTRACKED spec (covering both ignored and plain-untracked) must be
 * COPIED into a freshly-minted worktree, which — born from `HEAD` — would otherwise
 * lack it. Uses the real `Bun.$` shell + a real on-disk git repo (no fake shell), so
 * the `worktree add … HEAD` + `node:fs` copy round-trip is exercised end-to-end.
 */
describe("createWorktreeManager — registerSpec copies an untracked spec into the worktree (Issue 6)", () => {
	const tmps: string[] = [];

	afterEach(async () => {
		for (const dir of tmps.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** Init a real git repo with one tracked commit so `HEAD` exists for `worktree add`. */
	async function makeRepo(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "wf-wt-"));
		tmps.push(dir);
		// The managed worktree root is a SIBLING of the repo (`<repo>/../.wf-worktrees`),
		// so register the parent for cleanup too.
		tmps.push(join(dir, "..", ".wf-worktrees"));
		const git = $.cwd(dir).nothrow();
		await git`git init -q -b main`.quiet();
		await git`git config user.email t@t.local`.quiet();
		await git`git config user.name tester`.quiet();
		await writeFile(join(dir, "README.md"), "# tracked\n");
		await git`git add README.md`.quiet();
		await git`git commit -q -m init`.quiet();
		return dir;
	}

	test("an IGNORED spec is copied into the new worktree (not in HEAD)", async () => {
		const repo = await makeRepo();
		// A .gitignore'd plan doc: tracked .gitignore, ignored+untracked plan file.
		await writeFile(join(repo, ".gitignore"), "docs/plans/\n");
		await $.cwd(repo).nothrow()`git add .gitignore`.quiet();
		await $.cwd(repo).nothrow()`git commit -q -m ignore`.quiet();
		await $.cwd(repo).nothrow()`mkdir -p docs/plans`.quiet();
		await writeFile(
			join(repo, "docs/plans/plan.md"),
			"# the source of truth\n",
		);

		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_run1", "docs/plans/plan.md");
		const handle = await mgr.create({ runId: "wf_run1", label: "worker" });
		expect(handle).not.toBeNull();
		const dir = (handle as { dir: string }).dir;

		// The ignored plan is PRESENT in the worktree with the main tree's content.
		const copied = await readFile(join(dir, "docs/plans/plan.md"), "utf-8");
		expect(copied).toBe("# the source of truth\n");
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("a PLAIN-UNTRACKED spec is copied into the new worktree", async () => {
		const repo = await makeRepo();
		// Untracked, not ignored — also absent from a HEAD checkout.
		await writeFile(join(repo, "notes.md"), "# untracked notes\n");

		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_run2", "notes.md");
		const handle = await mgr.create({ runId: "wf_run2", label: "worker" });
		const dir = (handle as { dir: string }).dir;

		expect(await readFile(join(dir, "notes.md"), "utf-8")).toBe(
			"# untracked notes\n",
		);
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("NO registered spec → no copy (worktree carries only HEAD)", async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, "notes.md"), "# untracked notes\n");

		const mgr = createWorktreeManager({ shell: $, directory: repo });
		// No registerSpec call.
		const handle = await mgr.create({ runId: "wf_run3", label: "worker" });
		const dir = (handle as { dir: string }).dir;

		// README (tracked) is in HEAD; the untracked notes are NOT copied.
		expect(await readFile(join(dir, "README.md"), "utf-8")).toBe("# tracked\n");
		await expect(stat(join(dir, "notes.md"))).rejects.toThrow();
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("a copy failure (spec vanished) is fenced — the mint still succeeds", async () => {
		const repo = await makeRepo();
		const { logger, warns } = captureLogger();
		const mgr = createWorktreeManager({ shell: $, directory: repo, logger });
		// Register a path that does not exist on disk → copyFile rejects (ENOENT).
		mgr.registerSpec("wf_run4", "ghost.md");
		const handle = await mgr.create({ runId: "wf_run4", label: "worker" });
		// The mint is NOT failed by a copy error.
		expect(handle).not.toBeNull();
		const dir = (handle as { dir: string }).dir;
		await expect(stat(join(dir, "ghost.md"))).rejects.toThrow();
		expect(
			warns.some((w) => w.msg.includes("failed to copy declared spec")),
		).toBe(true);
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("unregisterSpec stops the copy on a later mint", async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, "notes.md"), "# untracked notes\n");
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_run5", "notes.md");
		mgr.unregisterSpec("wf_run5");
		const handle = await mgr.create({ runId: "wf_run5", label: "worker" });
		const dir = (handle as { dir: string }).dir;
		await expect(stat(join(dir, "notes.md"))).rejects.toThrow();
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});
});
