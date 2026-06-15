import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type TaskStatus = "todo" | "in-progress" | "done" | "blocked";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type TaskScope = "private" | "shared";

export interface TaskRecord {
	id: number;
	title: string;
	activeForm?: string;
	status: TaskStatus;
	priority: TaskPriority;
	scope: TaskScope;
	team?: string;
	owner?: string;
	claimedByAgentId?: string;
	dependencies: number[];
	notes?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface TaskBoardFile {
	version: 2;
	projectKey: string;
	projectRoot: string;
	nextId: number;
	tasks: TaskRecord[];
	updatedAt: number;
}

export interface TaskFilter {
	team?: string;
	scope?: TaskScope | TaskScope[];
	owner?: string;
	includeDone?: boolean;
}

export interface ClaimTaskResult {
	success: boolean;
	reason?: "none_available" | "agent_busy";
	task?: TaskRecord;
	busyWithTaskIds?: number[];
}

const TODOS_DIR = join(homedir(), ".pi", "todos");
const LOCK_TIMEOUT_MS = 4000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizePathComponent(input: string): string {
	return (
		input
			.replace(/[^a-zA-Z0-9_-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "project"
	);
}

export function getLegacyProjectKey(cwd: string): string {
	return (
		cwd.replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9_.-]/g, "-") || "project"
	);
}

function getProjectRoot(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}

export function getProjectKey(cwd: string): string {
	const root = getProjectRoot(cwd);
	const slug = sanitizePathComponent(basename(root));
	const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
	return `${slug}-${digest}`;
}

function getPreferredBoardPath(cwd: string): string {
	return join(TODOS_DIR, `${getProjectKey(cwd)}.json`);
}

function getLegacyBoardPath(cwd: string): string {
	return join(TODOS_DIR, `${getLegacyProjectKey(cwd)}.json`);
}

export function getBoardPath(cwd: string): string {
	mkdirSync(TODOS_DIR, { recursive: true, mode: 0o700 });
	const preferred = getPreferredBoardPath(cwd);
	if (existsSync(preferred)) return preferred;
	const legacy = getLegacyBoardPath(cwd);
	if (existsSync(legacy)) return legacy;
	return preferred;
}

function getLockPath(cwd: string): string {
	return `${getBoardPath(cwd)}.lock`;
}

function defaultBoard(cwd: string): TaskBoardFile {
	return {
		version: 2,
		projectKey: getProjectKey(cwd),
		projectRoot: getProjectRoot(cwd),
		nextId: 1,
		tasks: [],
		updatedAt: Date.now(),
	};
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(tmp, path);
}

function quarantineUnreadableFile(path: string): string | null {
	if (!existsSync(path)) return null;
	const quarantined = `${path}.corrupt.${Date.now()}`;
	try {
		renameSync(path, quarantined);
		return quarantined;
	} catch {
		return null;
	}
}

export function loadBoard(cwd: string): TaskBoardFile {
	const path = getBoardPath(cwd);
	if (!existsSync(path)) return defaultBoard(cwd);
	try {
		const parsed = JSON.parse(
			readFileSync(path, "utf-8"),
		) as Partial<TaskBoardFile>;
		const board: TaskBoardFile = {
			version: 2,
			projectKey:
				typeof parsed.projectKey === "string"
					? parsed.projectKey
					: getProjectKey(cwd),
			projectRoot:
				typeof parsed.projectRoot === "string" ? parsed.projectRoot : cwd,
			nextId: typeof parsed.nextId === "number" ? parsed.nextId : 1,
			tasks: Array.isArray(parsed.tasks)
				? parsed.tasks.map(normalizeTaskRecord)
				: [],
			updatedAt:
				typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
		};
		resolveBlocked(board.tasks);
		return board;
	} catch {
		const quarantined = quarantineUnreadableFile(path);
		throw new Error(
			quarantined
				? `Task board is unreadable. Preserved at ${quarantined}`
				: `Task board is unreadable: ${path}`,
		);
	}
}

export function saveBoard(cwd: string, board: TaskBoardFile): void {
	resolveBlocked(board.tasks);
	board.updatedAt = Date.now();
	const preferred = getPreferredBoardPath(cwd);
	const current = getBoardPath(cwd);
	if (current !== preferred && existsSync(current) && !existsSync(preferred)) {
		try {
			renameSync(current, preferred);
		} catch {}
	}
	board.projectKey = getProjectKey(cwd);
	board.projectRoot = getProjectRoot(cwd);
	writeJsonAtomic(preferred, board);
}

async function acquireLock(cwd: string): Promise<() => void> {
	const lockPath = getLockPath(cwd);
	const start = Date.now();
	while (true) {
		try {
			writeFileSync(lockPath, `${process.pid}:${Date.now()}`, {
				mode: 0o600,
				flag: "wx",
			});
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {}
			};
		} catch {
			try {
				const stat = statSync(lockPath);
				if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					rmSync(lockPath, { force: true });
					continue;
				}
			} catch {}
			if (Date.now() - start >= LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out acquiring task board lock for ${cwd}`);
			}
			await sleep(LOCK_RETRY_MS);
		}
	}
}

export async function withBoardLock<T>(
	cwd: string,
	fn: (board: TaskBoardFile) => T | Promise<T>,
): Promise<T> {
	const release = await acquireLock(cwd);
	try {
		const board = loadBoard(cwd);
		const result = await fn(board);
		saveBoard(cwd, board);
		return result;
	} finally {
		release();
	}
}

function normalizeTaskRecord(task: unknown): TaskRecord {
	const candidate =
		task && typeof task === "object" ? (task as Record<string, unknown>) : {};
	const normalized: TaskRecord = {
		id: typeof candidate.id === "number" ? candidate.id : 0,
		title:
			typeof candidate.title === "string" ? candidate.title : "Untitled task",
		activeForm:
			typeof candidate.activeForm === "string" && candidate.activeForm.trim()
				? candidate.activeForm
				: undefined,
		status: normalizeTaskStatus(candidate.status),
		priority: normalizePriority(candidate.priority),
		scope: normalizeScope(candidate.scope),
		team: normalizeTeamValue(candidate.team),
		owner:
			typeof candidate.owner === "string" && candidate.owner.trim()
				? candidate.owner.trim()
				: undefined,
		claimedByAgentId:
			typeof candidate.claimedByAgentId === "string" &&
			candidate.claimedByAgentId.trim()
				? candidate.claimedByAgentId.trim()
				: undefined,
		dependencies: Array.isArray(candidate.dependencies)
			? candidate.dependencies.filter(
					(value: unknown): value is number => typeof value === "number",
				)
			: [],
		notes:
			typeof candidate.notes === "string" && candidate.notes.trim()
				? candidate.notes
				: undefined,
		createdAt:
			typeof candidate.createdAt === "number"
				? candidate.createdAt
				: Date.now(),
		updatedAt:
			typeof candidate.updatedAt === "number"
				? candidate.updatedAt
				: Date.now(),
		completedAt:
			typeof candidate.completedAt === "number"
				? candidate.completedAt
				: undefined,
	};
	if (!normalized.activeForm) normalized.activeForm = normalized.title;
	return normalized;
}

function normalizeTaskStatus(status: unknown): TaskStatus {
	if (
		status === "todo" ||
		status === "in-progress" ||
		status === "done" ||
		status === "blocked"
	)
		return status;
	return "todo";
}

function normalizePriority(priority: unknown): TaskPriority {
	if (
		priority === "low" ||
		priority === "medium" ||
		priority === "high" ||
		priority === "critical"
	)
		return priority;
	return "medium";
}

function normalizeScope(scope: unknown): TaskScope {
	return scope === "private" ? "private" : "shared";
}

function normalizeTeamValue(team: unknown): string | undefined {
	if (typeof team !== "string" || !team.trim()) return undefined;
	return sanitizePathComponent(team).toLowerCase();
}

function getUnresolvedDependencyIds(
	board: TaskBoardFile,
	taskId: number,
	dependencies: number[],
): number[] {
	return dependencies.filter((depId) => {
		if (depId === taskId) return true;
		const dep = getTask(board, depId);
		return dep?.status !== "done";
	});
}

function validateDependencyIds(
	board: TaskBoardFile,
	taskId: number,
	dependencies: number[],
): void {
	const uniqueDeps = new Set<number>();
	for (const depId of dependencies) {
		if (depId === taskId)
			throw new Error(`Task #${taskId} cannot depend on itself.`);
		if (uniqueDeps.has(depId)) continue;
		uniqueDeps.add(depId);
		if (!getTask(board, depId)) {
			throw new Error(
				`Task #${taskId} references unknown dependency #${depId}.`,
			);
		}
	}
}

export function resolveBlocked(tasks: TaskRecord[]): void {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	for (const task of tasks) {
		if (task.status === "done") continue;
		const hasUnfinishedDeps = task.dependencies.some((depId) => {
			const dep = byId.get(depId);
			return dep?.status !== "done";
		});
		if (hasUnfinishedDeps) {
			task.status = "blocked";
		} else if (!hasUnfinishedDeps && task.status === "blocked") {
			task.status = "todo";
		}
	}
}

function matchesScope(task: TaskRecord, scope: TaskFilter["scope"]): boolean {
	if (!scope) return true;
	if (Array.isArray(scope)) return scope.includes(task.scope);
	return task.scope === scope;
}

export function filterTasks(
	tasks: TaskRecord[],
	filter: TaskFilter = {},
): TaskRecord[] {
	return tasks.filter((task) => {
		if (filter.team !== undefined && task.team !== filter.team) return false;
		if (!matchesScope(task, filter.scope)) return false;
		if (filter.owner !== undefined && task.owner !== filter.owner) return false;
		if (!filter.includeDone && task.status === "done") return false;
		return true;
	});
}

function getTask(board: TaskBoardFile, id: number): TaskRecord | undefined {
	return board.tasks.find((task) => task.id === id);
}

export function getTaskDisplayStatus(task: TaskRecord): TaskStatus {
	return task.status;
}

export function sortTasks(tasks: TaskRecord[]): TaskRecord[] {
	return [...tasks].sort((a, b) => a.id - b.id);
}

export function getTaskDoneMarker(taskId: number): string {
	return `[TASK_DONE:${taskId}]`;
}

export function buildTaskPrompt(task: TaskRecord): string {
	const parts = [`Complete task #${task.id}: ${task.title}`];
	if (task.notes) parts.push(task.notes);
	if (task.dependencies.length > 0) {
		parts.push(
			`Dependencies already resolved: ${task.dependencies.map((id) => `#${id}`).join(", ")}`,
		);
	}
	parts.push(
		`When the task is fully complete, end your final response with exactly ${getTaskDoneMarker(task.id)}. ` +
			`If you need clarification, follow-up, or leave the task incomplete, do not include that marker.`,
	);
	return parts.join("\n\n");
}

export async function createTasks(
	cwd: string,
	items: Array<Partial<TaskRecord> & { title: string }>,
): Promise<TaskRecord[]> {
	return withBoardLock(cwd, (board) => {
		const created: TaskRecord[] = [];
		for (const item of items) {
			const task: TaskRecord = normalizeTaskRecord({
				id: board.nextId++,
				title: item.title,
				activeForm: item.activeForm,
				status: "todo",
				priority: item.priority,
				scope: item.scope,
				team: normalizeTeamValue(item.team),
				owner: item.owner,
				dependencies: item.dependencies ?? [],
				notes: item.notes,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			board.tasks.push(task);
			created.push(task);
		}
		resolveBlocked(board.tasks);
		return created;
	});
}

export async function updateTaskRecord(
	cwd: string,
	id: number,
	updates: Partial<Omit<TaskRecord, "id" | "createdAt">>,
	actorName?: string,
): Promise<TaskRecord | null> {
	return withBoardLock(cwd, (board) => {
		const task = getTask(board, id);
		if (!task) return null;
		if (updates.title !== undefined) task.title = updates.title;
		if (updates.activeForm !== undefined)
			task.activeForm = updates.activeForm || task.title;
		if (updates.priority !== undefined)
			task.priority = normalizePriority(updates.priority);
		if (updates.scope !== undefined) task.scope = normalizeScope(updates.scope);
		if ("team" in updates) task.team = normalizeTeamValue(updates.team);
		if ("owner" in updates) {
			const nextOwner =
				typeof updates.owner === "string" && updates.owner.trim()
					? updates.owner.trim()
					: undefined;
			if (task.owner !== nextOwner) task.claimedByAgentId = undefined;
			task.owner = nextOwner;
		}
		if ("notes" in updates)
			task.notes =
				typeof updates.notes === "string" && updates.notes.trim()
					? updates.notes
					: undefined;
		if (updates.dependencies !== undefined) {
			const nextDependencies = Array.from(
				new Set(
					updates.dependencies.filter(
						(value): value is number => typeof value === "number",
					),
				),
			);
			validateDependencyIds(board, task.id, nextDependencies);
			task.dependencies = nextDependencies;
		}
		if (updates.status !== undefined) {
			const nextStatus = normalizeTaskStatus(updates.status);
			if (nextStatus === "in-progress") {
				const unresolved = getUnresolvedDependencyIds(
					board,
					task.id,
					task.dependencies,
				);
				if (unresolved.length > 0) {
					throw new Error(
						`Task #${task.id} cannot start while dependencies are unresolved: ${unresolved.map((depId) => `#${depId}`).join(", ")}`,
					);
				}
			}
			if (nextStatus === "done") {
				task.completedAt = Date.now();
				task.status = "done";
			} else {
				task.completedAt = undefined;
				task.status = nextStatus === "blocked" ? "todo" : nextStatus;
				if (actorName && task.status === "in-progress" && !task.owner) {
					task.owner = actorName;
				}
			}
		}
		task.updatedAt = Date.now();
		resolveBlocked(board.tasks);
		return task;
	});
}

export async function deleteTaskRecord(
	cwd: string,
	id: number,
): Promise<TaskRecord | null> {
	return withBoardLock(cwd, (board) => {
		const idx = board.tasks.findIndex((task) => task.id === id);
		if (idx === -1) return null;
		const existing = board.tasks[idx];
		if (
			existing?.status === "in-progress" ||
			existing?.owner ||
			existing?.claimedByAgentId
		) {
			throw new Error(
				`Task #${id} is active and cannot be deleted while claimed or in progress.`,
			);
		}
		const [removed] = board.tasks.splice(idx, 1);
		for (const task of board.tasks) {
			task.dependencies = task.dependencies.filter((dep) => dep !== id);
			task.updatedAt = Date.now();
		}
		resolveBlocked(board.tasks);
		return removed ?? null;
	});
}

export async function clearTaskBoard(cwd: string): Promise<number> {
	return withBoardLock(cwd, (board) => {
		const active = board.tasks.filter(
			(task) =>
				task.status === "in-progress" || task.owner || task.claimedByAgentId,
		);
		if (active.length > 0) {
			throw new Error(
				`Cannot clear the task board while active tasks exist: ${active.map((task) => `#${task.id}`).join(", ")}`,
			);
		}
		const cleared = board.tasks.length;
		board.tasks = [];
		board.nextId = 1;
		board.updatedAt = Date.now();
		return cleared;
	});
}

export async function claimNextSharedTask(
	cwd: string,
	agentName: string,
	options: { team?: string; checkBusy?: boolean; agentId?: string } = {},
): Promise<ClaimTaskResult> {
	return withBoardLock(cwd, (board) => {
		const visible = sortTasks(
			filterTasks(board.tasks, {
				team: options.team,
				scope: "shared",
				includeDone: false,
			}),
		);
		if (options.checkBusy) {
			const busy = visible.filter((task) => {
				if (task.status === "done") return false;
				if (options.agentId) return task.claimedByAgentId === options.agentId;
				return task.owner === agentName;
			});
			if (busy.length > 0) {
				return {
					success: false,
					reason: "agent_busy",
					busyWithTaskIds: busy.map((task) => task.id),
				};
			}
		}
		const task = visible.find(
			(candidate) => candidate.status === "todo" && !candidate.owner,
		);
		if (!task) return { success: false, reason: "none_available" };
		task.owner = agentName;
		task.claimedByAgentId = options.agentId;
		task.status = "in-progress";
		task.updatedAt = Date.now();
		resolveBlocked(board.tasks);
		return { success: true, task };
	});
}

export async function releaseOwnedTasks(
	cwd: string,
	agentName: string,
	options: { team?: string; agentId?: string } = {},
): Promise<TaskRecord[]> {
	return withBoardLock(cwd, (board) => {
		const released: TaskRecord[] = [];
		for (const task of board.tasks) {
			if (options.agentId) {
				if (task.claimedByAgentId !== options.agentId) continue;
			} else if (task.owner !== agentName) continue;
			if (options.team !== undefined && task.team !== options.team) continue;
			if (task.status === "done") continue;
			task.owner = undefined;
			task.claimedByAgentId = undefined;
			task.completedAt = undefined;
			task.status = "todo";
			task.updatedAt = Date.now();
			released.push({ ...task });
		}
		resolveBlocked(board.tasks);
		return released;
	});
}

export async function markTaskDone(
	cwd: string,
	taskId: number,
	options: { agentId?: string } = {},
): Promise<TaskRecord | null> {
	return withBoardLock(cwd, (board) => {
		const task = getTask(board, taskId);
		if (!task) return null;
		if (
			options.agentId &&
			task.claimedByAgentId &&
			task.claimedByAgentId !== options.agentId
		)
			return null;
		task.completedAt = Date.now();
		task.status = "done";
		task.updatedAt = Date.now();
		resolveBlocked(board.tasks);
		return task;
	});
}

export async function reassignOrDeleteTeamTasks(
	cwd: string,
	team: string,
	options: { deleteTasks?: boolean } = {},
): Promise<{ deleted: number; detached: number }> {
	return withBoardLock(cwd, (board) => {
		const normalizedTeam = team;
		let deleted = 0;
		let detached = 0;
		const deletedIds: number[] = [];
		if (options.deleteTasks) {
			board.tasks = board.tasks.filter((task) => {
				if (task.team !== normalizedTeam) return true;
				deleted += 1;
				deletedIds.push(task.id);
				return false;
			});
			for (const task of board.tasks) {
				const nextDeps = task.dependencies.filter(
					(dep) => !deletedIds.includes(dep),
				);
				if (nextDeps.length !== task.dependencies.length) {
					task.dependencies = nextDeps;
					task.updatedAt = Date.now();
				}
			}
		} else {
			for (const task of board.tasks) {
				if (task.team !== normalizedTeam) continue;
				task.team = undefined;
				task.owner = undefined;
				task.claimedByAgentId = undefined;
				if (task.status !== "done") {
					task.status = "todo";
					task.completedAt = undefined;
				}
				task.updatedAt = Date.now();
				detached += 1;
			}
		}
		resolveBlocked(board.tasks);
		return { deleted, detached };
	});
}

export function getBoardSummary(tasks: TaskRecord[]): {
	total: number;
	done: number;
	inProgress: number;
	todo: number;
	blocked: number;
} {
	return {
		total: tasks.length,
		done: tasks.filter((task) => task.status === "done").length,
		inProgress: tasks.filter((task) => task.status === "in-progress").length,
		todo: tasks.filter((task) => task.status === "todo").length,
		blocked: tasks.filter((task) => task.status === "blocked").length,
	};
}
