/**
 * Engine-owned git worktree manager (Epic H.1.1) — per-agent isolation lifecycle.
 *
 * The git checkpointer (`git-checkpoint.ts`) makes a parallel writer's overwrite
 * RECOVERABLE on one shared tree; this module PREVENTS the collision by giving each
 * isolated agent its own `git worktree` on a scratch branch, then merging the result
 * back. It is the other half of H.1's "safe by construction" parallel mutation.
 *
 * Lifecycle:
 * - `create(key)` → `git worktree add -b wf/<runId>/<label> <dir> HEAD`, where `<dir>`
 *   is a managed root OUTSIDE the working tree. A checkout INSIDE the tree would become
 *   a nested status/ignore hazard; inside `.git` is illegal for a worktree. The root is
 *   a sibling of the repo (`<repo>/../.wf-worktrees/<runId>/<label>`).
 * - `mergeBack(dir, branch)` → from the MAIN tree, `git merge --no-ff <branch>`. A REAL
 *   conflict (unmerged files present) is Tier 1 (loud, first-class): capture the unmerged
 *   files, `git merge --abort` to leave the main tree clean, and return `{conflict, branch,
 *   files, baseRef}` — the caller surfaces it without detonating the `parallel()` batch. A
 *   non-zero merge with ZERO unmerged files is NOT a conflict (branch missing / not
 *   mergeable / "local changes would be overwritten") → abort + `{failed: true}`, never a
 *   phantom Tier 1.
 * - `isUnchanged(dir)` → porcelain empty AND no commits ahead of the worktree's base.
 * - `cleanup(dir, branch)` → `git worktree remove --force` + `git branch -D` (best-effort).
 * - `sweep()` → prune orphan `wf/*` worktrees+branches from a crashed prior run.
 *
 * Serialization: N concurrent agents = N concurrent `git worktree add` against ONE
 * repo, which race the index lock. The module funnels EVERY `create` through a single
 * promise-chain mutex so adds never interleave.
 *
 * Fencing (identical contract to git-checkpoint.ts): every git invocation runs through
 * `shell.cwd(dir).nothrow()`, appends `.quiet()` to the ShellPromise (the plugin host
 * shares fd 1/2 with the opentui renderer — un-quieted output corrupts the screen), and
 * is inspected by `exitCode` — a non-zero git never rejects into the run. A non-repo is
 * detected ONCE (lazily, on first use) and latches the manager dead with a single warn;
 * every later call is a degrade-not-throw no-op. No `shell` injected → the whole
 * subsystem is a documented no-op (`create` returns null). NEVER `git add -A`, NEVER
 * `git stash`/`reset`/`restore` on a shared tree. The module imports nothing from
 * engine.ts — the dependency is one-way (engine constructs this), mirroring git-deny.ts.
 *
 * BunShell is a TAGGED-TEMPLATE callable (`$\`git status\``), NOT an argv API:
 * subcommands and pathspecs are string-INTERPOLATED into the template. The resolved
 * `BunShellOutput` carries `.exitCode` and a SYNCHRONOUS `.text()`.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";

/** The host shell primitive — `PluginInput['$']`; NOT a named package export. */
export type BunShell = PluginInput["$"];

/** Structured logger surface — the same subset git-checkpoint.ts uses. */
export interface WorktreeLogger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

/** Identity of one per-agent worktree: maps to the `wf/<runId>/<label>` branch. */
export interface WorktreeKey {
	/** The top-level runId that owns this worktree. */
	runId: string;
	/** The agent's display label. */
	label: string;
}

/** A successfully minted worktree: its checkout dir and the scratch branch it tracks. */
export interface WorktreeHandle {
	/** Absolute checkout dir, OUTSIDE the working tree; fed to `session.create`'s directory. */
	dir: string;
	/** The scratch branch `wf/<runId>/<label>` the worktree checked out. */
	branch: string;
}

/**
 * The outcome of {@link WorktreeManager.mergeBack}:
 * - `{ merged: true }` — clean fast-forward-disabled merge into the main tree.
 * - `{ conflict: true, branch, files, baseRef }` — a REAL merge conflict (unmerged files
 *   present): the locked Tier 1 shape (design decision #2). `branch` echoes the param;
 *   `baseRef` is the create-time base (the natural 3-way context for a Tier 2 resolver),
 *   or `undefined` when the dir has no recorded base (orphan / base-capture miss).
 * - `{ failed: true }` — a NON-conflict merge failure (branch missing, "not something we
 *   can merge", "local changes would be overwritten"): git exits non-zero but produces
 *   ZERO unmerged files. Reported distinctly so the engine never raises a PHANTOM Tier 1
 *   conflict (which would preserve a worktree for a conflict that never happened).
 */
export type MergeResult =
	| { merged: true }
	| {
			conflict: true;
			branch: string;
			files: string[];
			baseRef: string | undefined;
	  }
	| { failed: true };

export interface WorktreeManager {
	/**
	 * Mint a per-agent worktree on a scratch branch (serialized through the create
	 * mutex). Returns the {@link WorktreeHandle} on success, or `null` on a non-repo /
	 * no-shell / failed add — the caller then degrades to the unisolated/no-op path.
	 */
	create(key: WorktreeKey): Promise<WorktreeHandle | null>;
	/**
	 * From the MAIN tree, `git merge --no-ff <branch>`. A real conflict (unmerged files) →
	 * abort + Tier 1 `{conflict, branch, files, baseRef}`; a non-conflict merge failure →
	 * abort + `{failed}`; clean → `{merged}`. `dir` keys the create-time base for `baseRef`.
	 */
	mergeBack(dir: string, branch: string): Promise<MergeResult>;
	/** Worktree porcelain empty AND no commits ahead of its create-time base. */
	isUnchanged(dir: string): Promise<boolean>;
	/** Best-effort, fenced teardown: `worktree remove --force` then `branch -D`. */
	cleanup(dir: string, branch: string): Promise<void>;
	/** Prune orphan `wf/*` worktrees + branches from a crashed prior run. */
	sweep(): Promise<void>;
	/**
	 * Declare a run's source-of-truth spec as an UNTRACKED file that must be copied
	 * into every worktree this run mints (Issue 6 structural half). A fresh
	 * `worktree add … HEAD` checkout carries only HEAD's tracked files, so an
	 * untracked/ignored spec (e.g. a `.gitignore`d `docs/plans/…md`) is invisible to
	 * an isolated agent. The engine registers ONLY when its own classification
	 * verdict is `untracked`/`ignored` (tracked → already in HEAD; missing → not on
	 * disk), so `create` copies exactly the declared path, never a blanket sync.
	 * `repoRelPath` is repo-relative (resolved against `directory`). NOT part of the
	 * runtime {@link WorktreeManagerSeam} — an engine-only, out-of-band channel keyed
	 * by runId so the runtime mint call (`create({runId,label})`) stays unchanged.
	 */
	registerSpec(runId: string, repoRelPath: string): void;
	/** Drop a run's registered spec (best-effort, at run settle). */
	unregisterSpec(runId: string): void;
}

export interface CreateWorktreeManagerOptions {
	/** The host BunShell; `undefined` makes the whole manager a no-op. */
	shell: BunShell | undefined;
	/** Repo root; bound once via `shell.cwd(directory)` for main-tree commands. */
	directory: string;
	logger?: WorktreeLogger;
}

/** The wf/ branch namespace, shared by create/sweep so sweep can target only our refs. */
const WF_BRANCH_PREFIX = "wf/";

/** The managed worktree-root dirname, a sibling of the repo (outside the working tree). */
const WORKTREE_ROOT_DIRNAME = ".wf-worktrees";

/**
 * Engine identity used when the repo has no configured user, so the pre-merge commit
 * of a worktree's edits still lands. Mirrors git-checkpoint.ts's identity fallback.
 */
const ENGINE_USER_NAME = "opencode-drawers";
const ENGINE_USER_EMAIL = "workflows@opencode-drawers.local";

/**
 * Collapse a label into a single git-ref-safe path segment. Git refs forbid spaces,
 * `~^:?*[\`, `..`, leading/trailing `/`, and control chars; anything outside a
 * conservative `[A-Za-z0-9._-]` whitelist collapses to `-` so `worktree add -b` never
 * fails on a hostile label. The runId is engine-minted (already safe) and kept verbatim.
 *
 * The whitelist PERMITS `.`, so a pure-dot label (`.`, `..`, `...`) survives the regex
 * verbatim — which is doubly unsafe: git refs forbid a `..` component (the `worktree add
 * -b` silently degrades to null), and `join(root, runId, '..')` traverses OUT of the
 * managed root, so a later `worktree remove --force` would target a path outside it.
 * A segment that is nothing but dots carries no identity, so it falls back to `agent`.
 */
function sanitizeSegment(segment: string): string {
	const cleaned = segment
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (cleaned.length === 0 || /^\.+$/.test(cleaned)) {
		return "agent";
	}
	return cleaned;
}

/** The scratch branch for a worktree: `wf/<runId>/<sanitized-label>`. */
export function branchFor(key: WorktreeKey): string {
	return `${WF_BRANCH_PREFIX}${key.runId}/${sanitizeSegment(key.label)}`;
}

/** The text view of an awaited BunShellOutput's stdout (sync `.text()`), fenced. */
function readText(output: { text(): string }): string {
	try {
		return output.text();
	} catch {
		return "";
	}
}

/** Split git stdout into trimmed non-empty lines (porcelain/for-each-ref/diff lists). */
function lines(stdout: string): string[] {
	const out: string[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line.length > 0) {
			out.push(line);
		}
	}
	return out;
}

/**
 * Parse `git -c diff.renames=false status --porcelain` (renames OFF) into a flat list
 * of paths — used by `mergeBack` to stage the worktree's edits as EXPLICIT pathspecs
 * before committing (NEVER `git add -A`, per the module invariants). With renames off
 * every entry is a single path (a rename is a delete + an add), so there is no
 * `R old -> new` two-path record. Each line is `XY <path>`; strip the two status
 * columns + a space, then unquote a git C-quoted path (spaces/unicode → `"..."`).
 * Mirrors git-checkpoint.ts `parsePorcelain` so the staging contract is identical.
 */
function parsePorcelainPaths(stdout: string): string[] {
	const out: string[] = [];
	for (const raw of stdout.split("\n")) {
		if (raw.length < 4) {
			continue;
		}
		let path = raw.slice(3).trim();
		if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
			path = path.slice(1, -1);
		}
		if (path.length > 0) {
			out.push(path);
		}
	}
	return out;
}

export function createWorktreeManager(
	opts: CreateWorktreeManagerOptions,
): WorktreeManager {
	const { shell, directory, logger } = opts;

	// Dead latch (mirrors git-checkpoint.ts): no shell at all is the documented no-op;
	// a non-repo flips it dead on first use with ONE warn, after which every method
	// degrades to a no-op rather than throwing.
	let dead = shell === undefined;
	let probed = false;

	// The base HEAD captured at each worktree's create time, keyed by its dir. Lets
	// isUnchanged() count commits ahead WITHOUT threading the main ref through callers.
	const baseByDir = new Map<string, string>();

	// Per-run UNTRACKED spec paths (Issue 6 structural half), keyed by runId. The
	// engine registers a run's declared `spec_path` here ONLY when its classification
	// verdict is untracked/ignored; doCreate copies it from the main tree into the
	// fresh worktree (which, born from HEAD, lacks any non-tracked file). Repo-relative.
	const specByRun = new Map<string, string>();

	// The managed worktree root: a SIBLING of the repo, outside the working tree (a
	// checkout inside the tree is a nested status/ignore hazard; inside .git is illegal).
	// `join` collapses the `..` so the path genuinely resolves OUTSIDE `directory`.
	const worktreeRoot = join(directory, "..", WORKTREE_ROOT_DIRNAME);

	/** The main-tree-bound, fenced shell. Only reachable when `shell` is defined. */
	const git = () => (shell as BunShell).cwd(directory).nothrow();
	/** A fenced shell bound to a specific worktree dir (`git -C <dir>` semantics). */
	const gitIn = (dir: string) => (shell as BunShell).cwd(dir).nothrow();

	/**
	 * Probe the work-tree ONCE (lazily, on first use). `false` latches the manager dead
	 * with a single warn; shared by every method so the non-repo case warns exactly once
	 * and never re-probes. Mirrors git-checkpoint.ts `ready()` but inlined as a shared
	 * gate because this manager has no separate ready() lifecycle call.
	 */
	async function alive(): Promise<boolean> {
		if (dead) {
			return false;
		}
		if (probed) {
			return true;
		}
		probed = true;
		const res = await git()`git rev-parse --is-inside-work-tree`.quiet();
		if (res.exitCode !== 0 || readText(res).trim() !== "true") {
			dead = true;
			logger?.warn(
				"git worktree isolation disabled: not a git work tree — isolated " +
					"agents will degrade to the unisolated fallback for this run",
				{ directory },
			);
			return false;
		}
		return true;
	}

	// The create mutex: a single promise chain that serializes EVERY create so N
	// concurrent `git worktree add` against one repo never race the index lock. Each
	// create appends its work to the tail and awaits the prior link first.
	let createTail: Promise<unknown> = Promise.resolve();

	async function doCreate(key: WorktreeKey): Promise<WorktreeHandle | null> {
		if (!(await alive())) {
			return null;
		}
		const branch = branchFor(key);
		const dir = join(worktreeRoot, key.runId, sanitizeSegment(key.label));
		// `-b <branch> <dir> HEAD`: create the scratch branch at the current HEAD and
		// check it out into the managed sibling dir (mirrors the host worktree convention).
		const add = await git()`git worktree add -b ${branch} ${dir} HEAD`.quiet();
		if (add.exitCode !== 0) {
			logger?.warn("git worktree add failed; agent will degrade to fallback", {
				runId: key.runId,
				label: key.label,
				branch,
				stderr: readText({ text: () => add.stderr.toString() }),
			});
			return null;
		}
		// Record the create-time base so isUnchanged() can count commits ahead. The
		// branch points at HEAD now, so the worktree's HEAD IS this base until it commits.
		const head = await git()`git rev-parse HEAD`.quiet();
		if (head.exitCode === 0) {
			const base = readText(head).trim();
			if (base.length > 0) {
				baseByDir.set(dir, base);
			}
		}
		// Issue 6 structural half: the worktree was born from HEAD, so an UNTRACKED
		// declared spec (ignored or plain-untracked) is absent from it. Copy ONLY that
		// one registered path from the main tree into the worktree so the isolated
		// agent can read its source of truth. Fenced — a copy failure (the file
		// vanished, a permission error) NEVER fails the mint or the agent.
		const spec = specByRun.get(key.runId);
		if (spec !== undefined) {
			try {
				const dest = join(dir, spec);
				await mkdir(dirname(dest), { recursive: true });
				await copyFile(join(directory, spec), dest);
			} catch (err) {
				logger?.warn(
					"failed to copy declared spec into worktree; the isolated agent may " +
						"not see its source of truth (non-blocking)",
					{
						runId: key.runId,
						spec,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}
		return { dir, branch };
	}

	function create(key: WorktreeKey): Promise<WorktreeHandle | null> {
		// Chain onto the tail (serialize). The tail must never reject — swallow so one
		// failed create can't poison the mutex for later creates.
		const run = createTail.then(() => doCreate(key));
		createTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// The merge runs from the MAIN tree BY BRANCH NAME, so the worktree dir is not the
	// merge target — but it IS the key into baseByDir, the only holder of the create-time
	// base, which the locked Tier 1 result carries as `baseRef` (3-way context for a
	// Tier 2 resolver). So `dir` is wired, not discarded.
	/**
	 * Commit the worktree's UNCOMMITTED working-tree edits onto its scratch branch
	 * BEFORE merge-back. A worker's edits live as uncommitted changes in the worktree
	 * checkout (nothing in the isolation path commits them — the engine's per-unit
	 * checkpointer is bound to the MAIN tree and is blind to the worktree). Without this
	 * step, merge-back would merge a scratch branch still pointing at the create-time
	 * base HEAD (zero commits ahead) → "Already up to date" → a phantom clean merge →
	 * cleanup destroys the worktree and the agent's work is SILENTLY LOST (the #5
	 * catastrophe, re-introduced through the isolation path). Staging is by EXPLICIT
	 * pathspecs parsed from porcelain — NEVER `git add -A` (module invariant). Fenced:
	 * a failure returns without throwing; the merge then proceeds (a still-empty branch
	 * merges cleanly to a no-op, which the caller's isUnchanged gate already routes to
	 * cleanup — no work is committed, so none is lost). Runs FROM the worktree dir.
	 */
	async function commitWorktreeEdits(
		dir: string,
		branch: string,
	): Promise<void> {
		const status = await gitIn(
			dir,
		)`git -c diff.renames=false status --porcelain`.quiet();
		if (status.exitCode !== 0) {
			return;
		}
		const paths = parsePorcelainPaths(readText(status));
		if (paths.length === 0) {
			return;
		}
		// Stage ONLY explicit pathspecs (never `-A`). Each add is its own fenced call so
		// one bad pathspec cannot abort the rest; a failed add drops that path.
		const staged: string[] = [];
		for (const path of paths) {
			const add = await gitIn(dir)`git add -- ${path}`.quiet();
			if (add.exitCode === 0) {
				staged.push(path);
			}
		}
		if (staged.length === 0) {
			return;
		}
		// Commit with --no-verify (skip operator hooks) + a git GLOBAL `-c` identity
		// fallback (which MUST precede the subcommand) so a repo with no configured user
		// still commits. Scoped to the exact staged pathspecs (`-- <paths>`).
		const commit = await gitIn(
			dir,
		)`git -c user.name=${ENGINE_USER_NAME} -c user.email=${ENGINE_USER_EMAIL} commit --no-verify -m ${`wf: ${branch}`} -- ${staged}`.quiet();
		if (commit.exitCode !== 0) {
			logger?.warn(
				"git worktree commit failed before merge-back; the merge may be a no-op " +
					"and the agent's edits will not land in the main tree",
				{
					dir,
					stderr: readText({ text: () => commit.stderr.toString() }),
				},
			);
		}
	}

	async function mergeBack(dir: string, branch: string): Promise<MergeResult> {
		if (!(await alive())) {
			// No git to merge with → degrade to "merged" so callers don't block on a
			// no-op subsystem (parity with the checkpointer's dead-state no-ops).
			return { merged: true };
		}
		// Commit the worktree's uncommitted edits onto its scratch branch FIRST, so the
		// branch is genuinely ahead of base and the merge actually carries the work (see
		// commitWorktreeEdits — without this the agent's work is silently lost).
		await commitWorktreeEdits(dir, branch);
		// From the MAIN tree, merge the scratch branch with an explicit merge commit
		// (--no-ff keeps the agent's work a distinguishable unit). Caller serializes this
		// via the engine's checkpointTail so merges/commits never interleave.
		const merge = await git()`git merge --no-ff ${branch}`.quiet();
		if (merge.exitCode === 0) {
			return { merged: true };
		}
		// Non-zero is NOT automatically a conflict. git also exits non-zero for "branch
		// not found", "not something we can merge", and "local changes would be overwritten
		// by merge" — none of which leave unmerged files. Classify on ACTUAL unmerged
		// files so we never raise a phantom Tier 1.
		const unmerged = await git()`git diff --name-only --diff-filter=U`.quiet();
		const files = unmerged.exitCode === 0 ? lines(readText(unmerged)) : [];
		// Always abort first (harmless no-op when there is no merge in progress, fenced),
		// to leave the MAIN tree clean in both branches.
		await git()`git merge --abort`.quiet();
		if (files.length > 0) {
			// REAL conflict → Tier 1: loud, not auto-resolved. Carry branch + baseRef.
			return { conflict: true, branch, files, baseRef: baseByDir.get(dir) };
		}
		// Non-conflict merge failure → distinct outcome (degrade), not a phantom conflict.
		logger?.warn(
			"git merge failed without conflict markers; degrading (no Tier 1 conflict)",
			{ branch, stderr: readText({ text: () => merge.stderr.toString() }) },
		);
		return { failed: true };
	}

	async function isUnchanged(dir: string): Promise<boolean> {
		if (!(await alive())) {
			// Cannot prove change without git; treat as unchanged so the dead path is a
			// clean no-op (the caller would then skip merge-back anyway).
			return true;
		}
		// (1) Any uncommitted worktree edits → changed.
		const status = await gitIn(dir)`git status --porcelain`.quiet();
		if (status.exitCode !== 0 || lines(readText(status)).length > 0) {
			// A non-zero status is treated as "not provably unchanged" → changed (safe:
			// the caller merges rather than silently dropping work).
			return false;
		}
		// (2) Commits ahead of the create-time base → changed. Without a recorded base
		// (an orphan dir we never minted, or a create-time base-capture miss) we CANNOT
		// count ahead-ness, so we cannot PROVE the worktree is unchanged. Returning true
		// here would route a worktree that committed work to cleanup and silently drop its
		// branch. Align with the module's safe default (status non-zero ⇒ false): an
		// unprovable base is "not provably unchanged" → false, so the caller merges.
		const base = baseByDir.get(dir);
		if (base === undefined) {
			return false;
		}
		const ahead = await gitIn(dir)`git rev-list --count ${base}..HEAD`.quiet();
		if (ahead.exitCode !== 0) {
			return false;
		}
		return readText(ahead).trim() === "0";
	}

	async function cleanup(dir: string, branch: string): Promise<void> {
		if (!(await alive())) {
			return;
		}
		// Best-effort, fenced: remove the checkout (force, since it may carry the agent's
		// dirt on a conflict-preserved worktree), then delete the scratch branch. A failed
		// remove must NOT prevent the branch delete — run both independently.
		baseByDir.delete(dir);
		await git()`git worktree remove --force ${dir}`.quiet();
		await git()`git branch -D ${branch}`.quiet();
	}

	async function sweep(): Promise<void> {
		if (!(await alive())) {
			return;
		}
		// Prune stale worktree admin entries (dirs deleted out from under git by a crash).
		await git()`git worktree prune`.quiet();
		// Enumerate ONLY our wf/* branches so we never touch operator/host branches, then
		// delete each (a leftover scratch branch from a crashed prior run).
		const refs =
			await git()`git for-each-ref --format=%(refname:short) refs/heads/${WF_BRANCH_PREFIX}`.quiet();
		if (refs.exitCode !== 0) {
			return;
		}
		for (const branch of lines(readText(refs))) {
			await git()`git branch -D ${branch}`.quiet();
		}
	}

	function registerSpec(runId: string, repoRelPath: string): void {
		specByRun.set(runId, repoRelPath);
	}

	function unregisterSpec(runId: string): void {
		specByRun.delete(runId);
	}

	return {
		create,
		mergeBack,
		isUnchanged,
		cleanup,
		sweep,
		registerSpec,
		unregisterSpec,
	};
}
