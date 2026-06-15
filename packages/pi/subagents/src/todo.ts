/**
 * Task/Todo System Extension
 *
 * Claude-inspired shared task board:
 * - file-backed at ~/.pi/todos/{project}.json
 * - supports activeForm, scope, team namespaces, dependencies, and owners
 * - owner activity is fused from subagent progress snapshots
 * - shared tasks can be coordinated with persistent workers/subagents
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import os, { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import {
	buildTaskPrompt,
	claimNextSharedTask,
	clearTaskBoard,
	createTasks,
	deleteTaskRecord,
	filterTasks,
	getBoardPath,
	getBoardSummary,
	getTaskDisplayStatus,
	loadBoard,
	sortTasks,
	type TaskFilter,
	type TaskPriority,
	type TaskRecord,
	type TaskScope,
	updateTaskRecord,
} from "./shared/task-board";
import { listTeams, normalizeTeamInput } from "./shared/team-registry";

const SUBAGENT_NAME_ENV = "PI_SUBAGENT_NAME";
const SUBAGENT_TEAM_ENV = "PI_SUBAGENT_TEAM";
const AGENTS_DIR = join(homedir(), ".pi", "agents");
const LOG_PATH = join(homedir(), ".pi", "agent", "todo.log");
const REFRESH_INTERVAL_MS = 1000;
type ViewStatus = ReturnType<typeof getTaskDisplayStatus>;

/**
 * Diagnostics go to a file sink, never the console: a raw write to stdout/stderr
 * while the TUI is mounted desyncs pi's differential renderer (gotchas §14/§15).
 */
function logDiagnostic(message: string, error: unknown): void {
	try {
		const detail =
			error instanceof Error ? error.stack || error.message : String(error);
		appendFileSync(
			LOG_PATH,
			`${new Date().toISOString()} ${message}: ${detail}\n`,
		);
	} catch {}
}

/** Collapse the user's home dir in displayed paths so it never leaks into the UI (gotchas §16). */
function shortenHomePath(path: string): string {
	const home = os.homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

interface AgentProgressSnapshot {
	agentId: string;
	name: string;
	description: string;
	cwd?: string;
	team?: string;
	phase?: string;
	queuedMessages?: number;
	currentTaskId?: number;
	lastActivity?: string;
	recentActivities?: string[];
	updatedAt?: number;
}

interface TodoToolDetails {
	error?: boolean;
	created?: number;
	taskId?: number;
	count?: number;
}

interface TodoBatchItemInput {
	title: string;
	activeForm?: string;
	priority?: TaskPriority;
	scope?: TaskScope;
	team?: string;
	dependencies?: number[];
	owner?: string;
	notes?: string;
}

interface TodoToolParams {
	action: "create" | "update" | "delete" | "list" | "claim";
	title?: string;
	activeForm?: string;
	priority?: TaskPriority;
	scope?: TaskScope;
	team?: string;
	dependencies?: number[];
	owner?: string;
	notes?: string;
	id?: number;
	status?: "todo" | "in-progress" | "done";
	includeDone?: boolean;
	tasks?: TodoBatchItemInput[];
}

const todoActionSchema: TSchema = StringEnum(
	["create", "update", "delete", "list", "claim"] as const,
	{
		description: "The action to perform",
	},
) as unknown as TSchema;
const taskPrioritySchema: TSchema = StringEnum(
	["low", "medium", "high", "critical"] as const,
	{
		description: "Task priority",
	},
) as unknown as TSchema;
const taskScopeSchema: TSchema = StringEnum(["private", "shared"] as const, {
	description: "Task scope",
}) as unknown as TSchema;
const taskStatusSchema: TSchema = StringEnum(
	["todo", "in-progress", "done"] as const,
	{
		description: "New task status",
	},
) as unknown as TSchema;
const todoBatchItemSchema = Type.Object({
	title: Type.String(),
	activeForm: Type.Optional(Type.String()),
	priority: Type.Optional(taskPrioritySchema),
	scope: Type.Optional(taskScopeSchema),
	team: Type.Optional(Type.String()),
	dependencies: Type.Optional(Type.Array(Type.Number())),
	owner: Type.Optional(Type.String()),
	notes: Type.Optional(Type.String()),
});
const todoToolParamsSchema = Type.Object({
	action: todoActionSchema,
	title: Type.Optional(
		Type.String({ description: "Task title (for create/update)" }),
	),
	activeForm: Type.Optional(
		Type.String({
			description: "Present continuous form shown while in progress",
		}),
	),
	priority: Type.Optional(taskPrioritySchema),
	scope: Type.Optional(taskScopeSchema),
	team: Type.Optional(
		Type.String({
			description: "Optional team namespace for this task or query",
		}),
	),
	dependencies: Type.Optional(
		Type.Array(Type.Number(), {
			description: "IDs of tasks that must complete first",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Who owns this task" })),
	notes: Type.Optional(Type.String({ description: "Additional task context" })),
	id: Type.Optional(
		Type.Number({ description: "Task ID (for update/delete)" }),
	),
	status: Type.Optional(taskStatusSchema),
	includeDone: Type.Optional(
		Type.Boolean({ description: "Include completed tasks when listing" }),
	),
	tasks: Type.Optional(Type.Array(todoBatchItemSchema)),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value
		: undefined;
}

function parseAgentProgressSnapshot(
	value: unknown,
): AgentProgressSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const name = asOptionalString(value.name);
	if (!name) return undefined;

	return {
		agentId: asOptionalString(value.agentId) ?? "",
		name,
		description: asOptionalString(value.description) ?? "",
		cwd: asOptionalString(value.cwd),
		team: asOptionalString(value.team),
		phase: asOptionalString(value.phase),
		queuedMessages: asOptionalNumber(value.queuedMessages),
		currentTaskId: asOptionalNumber(value.currentTaskId),
		lastActivity: asOptionalString(value.lastActivity),
		recentActivities: asOptionalStringArray(value.recentActivities),
		updatedAt: asOptionalNumber(value.updatedAt),
	};
}

function statusIcon(status: ViewStatus): string {
	switch (status) {
		case "todo":
			return "○";
		case "in-progress":
			return "◌";
		case "done":
			return "✓";
		case "blocked":
			return "⊘";
	}
}

function statusColor(status: ViewStatus): ThemeColor {
	switch (status) {
		case "todo":
			return "dim";
		case "in-progress":
			return "warning";
		case "done":
			return "success";
		case "blocked":
			return "error";
	}
}

function getActorName(): string | undefined {
	const agentName = process.env[SUBAGENT_NAME_ENV]?.trim();
	return agentName || undefined;
}

function getDefaultTeam(): string | undefined {
	const team = process.env[SUBAGENT_TEAM_ENV]?.trim();
	return normalizeTeamInput(team);
}

function normalizeScope(scope: unknown): TaskScope | undefined {
	return scope === "private" || scope === "shared" ? scope : undefined;
}

function normalizePriority(priority: unknown): TaskPriority | undefined {
	return priority === "low" ||
		priority === "medium" ||
		priority === "high" ||
		priority === "critical"
		? priority
		: undefined;
}

function sanitizeForDisplay(input: string, max = 240): string {
	let result = "";
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code === 0x1b) continue;
		if (
			code === 0x202a ||
			code === 0x202b ||
			code === 0x202c ||
			code === 0x202d ||
			code === 0x202e ||
			code === 0x2066 ||
			code === 0x2067 ||
			code === 0x2068 ||
			code === 0x2069
		)
			continue;
		const isControl =
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			(code >= 0x7f && code <= 0x9f);
		if (isControl) {
			result += " ";
			continue;
		}
		result += input[i] ?? "";
	}
	return result.replace(/\s+/g, " ").trim().slice(0, max);
}

function formatTaskList(
	tasks: TaskRecord[],
	ownerActivity: Map<string, string>,
): string {
	if (tasks.length === 0) return "No tasks.";

	const lines: string[] = [];
	for (const task of tasks) {
		const status = getTaskDisplayStatus(task);
		const title = sanitizeForDisplay(task.title);
		const parts = [`${statusIcon(status)} #${task.id} ${title}`];
		if (
			task.activeForm &&
			task.activeForm !== task.title &&
			status === "in-progress"
		) {
			parts.push(`(${sanitizeForDisplay(task.activeForm)})`);
		}
		if (task.priority !== "medium") parts.push(`[${task.priority}]`);
		if (task.scope === "private") parts.push("[private]");
		if (task.team) parts.push(`[team:${task.team}]`);
		if (task.owner) parts.push(`@${sanitizeForDisplay(task.owner, 80)}`);
		if (task.dependencies.length > 0)
			parts.push(`deps:${task.dependencies.join(",")}`);
		const activity = task.owner ? ownerActivity.get(task.owner) : undefined;
		if (activity) parts.push(`→ ${sanitizeForDisplay(activity, 120)}`);
		if (task.notes) parts.push(`— ${sanitizeForDisplay(task.notes, 200)}`);
		lines.push(parts.join(" "));
	}

	const summary = getBoardSummary(tasks);
	lines.push("");
	lines.push(
		`Total: ${summary.total} | Done: ${summary.done} | In Progress: ${summary.inProgress} | Todo: ${summary.todo} | Blocked: ${summary.blocked}`,
	);
	return lines.join("\n");
}

function readOwnerActivity(cwd: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!existsSync(AGENTS_DIR)) return result;
	try {
		for (const entry of readdirSync(AGENTS_DIR)) {
			const progressPath = join(AGENTS_DIR, entry, "progress.json");
			if (!existsSync(progressPath)) continue;
			try {
				const progress = parseAgentProgressSnapshot(
					JSON.parse(readFileSync(progressPath, "utf-8")),
				);
				if (!progress) continue;
				if (progress.cwd && progress.cwd !== cwd) continue;
				const activity =
					progress.lastActivity || progress.recentActivities?.[0];
				if (!activity) continue;
				const suffix = progress.currentTaskId
					? ` (#${progress.currentTaskId})`
					: "";
				result.set(
					sanitizeForDisplay(progress.name, 80),
					`${sanitizeForDisplay(activity, 120)}${suffix}`,
				);
			} catch (error) {
				logDiagnostic("failed to read owner activity snapshot", error);
			}
		}
	} catch (error) {
		logDiagnostic("failed to scan agent progress snapshots", error);
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionContext | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let currentTasks: TaskRecord[] = [];
	let ownerActivity = new Map<string, string>();
	let stateError: string | null = null;

	function getBoardFile() {
		if (!ctx) return undefined;
		return getBoardPath(ctx.cwd);
	}

	function loadCurrentState() {
		if (!ctx) return;
		try {
			const board = loadBoard(ctx.cwd);
			currentTasks = sortTasks(board.tasks);
			ownerActivity = readOwnerActivity(ctx.cwd);
			stateError = null;
		} catch (error) {
			currentTasks = [];
			ownerActivity = new Map();
			stateError = error instanceof Error ? error.message : String(error);
		}
	}

	function updateWidget() {
		if (!ctx?.hasUI) return;
		loadCurrentState();
		if (stateError) {
			const message = stateError;
			ctx.ui.setWidget("todo", (_tui, theme) => ({
				render(width: number): string[] {
					return [
						theme.fg(
							"error",
							truncateToWidth(
								`tasks error: ${sanitizeForDisplay(message, 200)}`,
								Math.max(1, width),
							),
						),
					];
				},
				invalidate() {},
			}));
			return;
		}
		const openTasks = currentTasks.filter((task) => task.status !== "done");
		if (openTasks.length === 0) {
			ctx.ui.setWidget("todo", undefined);
			return;
		}

		ctx.ui.setWidget("todo", (_tui, theme) => ({
			render(width: number): string[] {
				const summary = getBoardSummary(currentTasks);
				const barWidth = 16;
				const total = Math.max(1, summary.total);
				const filled = Math.round((summary.done / total) * barWidth);
				const bar =
					theme.fg("success", "█".repeat(filled)) +
					theme.fg("dim", "░".repeat(barWidth - filled));
				const prefix =
					theme.fg("dim", "─── tasks ") +
					bar +
					theme.fg("dim", ` ${summary.done}/${summary.total} `) +
					theme.fg("dim", "─── ");
				const inProgress = currentTasks
					.filter((task) => getTaskDisplayStatus(task) === "in-progress")
					.slice(0, 2)
					.map((task) => {
						const base = sanitizeForDisplay(task.activeForm || task.title, 120);
						const activity = task.owner
							? ownerActivity.get(task.owner)
							: undefined;
						return activity
							? `${base} → ${sanitizeForDisplay(activity, 120)}`
							: base;
					})
					.join("  •  ");
				const tailText = inProgress || "alt+t details";
				const availableTailWidth = Math.max(0, width - visibleWidth(prefix));
				const tail =
					availableTailWidth > 0
						? theme.fg("muted", truncateToWidth(tailText, availableTailWidth))
						: "";
				return [truncateToWidth(prefix + tail, Math.max(1, width))];
			},
			invalidate() {},
		}));
	}

	async function refreshLoop() {
		loadCurrentState();
		updateWidget();
	}

	function wrapText(text: string, width: number): string[] {
		if (visibleWidth(text) <= width) return [text];
		const words = text.split(/\s+/);
		const lines: string[] = [];
		let current = "";
		for (const word of words) {
			const next = current ? `${current} ${word}` : word;
			if (visibleWidth(next) > width) {
				if (current) lines.push(truncateToWidth(current, width));
				current = word;
			} else {
				current = next;
			}
		}
		if (current) lines.push(truncateToWidth(current, width));
		return lines.length > 0 ? lines : [""];
	}

	async function showTodoOverlay(uiCtx: ExtensionContext) {
		if (uiCtx.mode !== "tui") return;
		loadCurrentState();
		if (stateError) {
			uiCtx.ui.notify(stateError, "error");
			return;
		}
		if (currentTasks.length === 0) {
			uiCtx.ui.notify("No tasks", "info");
			return;
		}
		await uiCtx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				let teamIdx = 0;
				let scopeIdx = 0;
				let ownerIdx = 0;
				let includeDone = true;
				let selectedTaskIdx = 0;
				let overlayTimer: ReturnType<typeof setInterval> | null = setInterval(
					() => {
						loadCurrentState();
						tui.requestRender();
					},
					REFRESH_INTERVAL_MS,
				);

				const cleanup = () => {
					if (overlayTimer) {
						clearInterval(overlayTimer);
						overlayTimer = null;
					}
				};

				const getTeamOptions = () => {
					const registryTeams = (() => {
						try {
							return listTeams(uiCtx.cwd).map((team) => team.name);
						} catch {
							return [];
						}
					})();
					const taskTeams = currentTasks
						.map((task) => task.team)
						.filter((team): team is string => !!team);
					return [
						"all",
						...Array.from(new Set([...registryTeams, ...taskTeams])).sort(),
					];
				};

				const getOwnerOptions = () => {
					const owners = currentTasks
						.map((task) => task.owner)
						.filter((owner): owner is string => !!owner);
					return ["all", "unassigned", ...Array.from(new Set(owners)).sort()];
				};

				const getAssignableOwners = () => {
					const owners = [
						"",
						"supervisor",
						...Array.from(
							new Set([
								...ownerActivity.keys(),
								...currentTasks
									.map((task) => task.owner)
									.filter((owner): owner is string => !!owner),
							]),
						).sort(),
					];
					return Array.from(new Set(owners));
				};

				const getFilteredTasks = () => {
					const teamOptions = getTeamOptions();
					const ownerOptions = getOwnerOptions();
					if (teamIdx >= teamOptions.length) teamIdx = 0;
					if (ownerIdx >= ownerOptions.length) ownerIdx = 0;
					const teamValue = teamOptions[teamIdx] ?? "all";
					const scopeValue =
						(["all", "shared", "private"] as const)[scopeIdx] ?? "all";
					const ownerValue = ownerOptions[ownerIdx] ?? "all";
					const filtered = sortTasks(
						filterTasks(currentTasks, {
							team: teamValue === "all" ? undefined : teamValue,
							scope: scopeValue === "all" ? undefined : scopeValue,
							owner:
								ownerValue === "all" || ownerValue === "unassigned"
									? undefined
									: ownerValue,
							includeDone,
						}).filter((task) => ownerValue !== "unassigned" || !task.owner),
					);
					if (selectedTaskIdx >= filtered.length)
						selectedTaskIdx = Math.max(0, filtered.length - 1);
					return { filtered, teamValue, scopeValue, ownerValue };
				};

				const mutateSelectedTask = async (
					mutation: (task: TaskRecord) => Promise<void>,
				) => {
					const { filtered } = getFilteredTasks();
					const task = filtered[selectedTaskIdx];
					if (!task) return;
					await mutation(task);
					await refreshLoop();
					tui.requestRender();
				};

				return {
					render(width: number): string[] {
						const { filtered, teamValue, scopeValue, ownerValue } =
							getFilteredTasks();
						const innerW = Math.max(60, width - 2);
						const lines: string[] = [];
						const pad = (s: string) =>
							s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
						const row = (content: string) =>
							theme.fg("border", "│") +
							pad(truncateToWidth(` ${content}`, innerW)) +
							theme.fg("border", "│");
						const summary = getBoardSummary(filtered);
						const barWidth = 20;
						const total = Math.max(1, summary.total);
						const filled = Math.round((summary.done / total) * barWidth);
						const bar =
							theme.fg("success", "█".repeat(filled)) +
							theme.fg("dim", "░".repeat(barWidth - filled));

						lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
						lines.push(
							row(
								theme.fg("accent", theme.bold("Tasks")) +
									theme.fg("dim", "  ") +
									bar +
									theme.fg("dim", ` ${summary.done}/${summary.total}`),
							),
						);
						const boardFile = getBoardFile();
						if (boardFile)
							lines.push(row(theme.fg("dim", shortenHomePath(boardFile))));
						lines.push(
							row(
								`${theme.fg("muted", `[t]eam:${teamValue}`)} ${theme.fg("muted", `[s]cope:${scopeValue}`)} ${theme.fg("muted", `[o]wner:${ownerValue}`)} ${theme.fg("muted", `[d]one:${includeDone ? "on" : "off"}`)}`,
							),
						);
						lines.push(row(""));

						if (filtered.length === 0) {
							lines.push(
								row(theme.fg("dim", "No tasks match the current filters.")),
							);
						} else {
							for (const [i, task] of filtered.entries()) {
								const selected = i === selectedTaskIdx;
								const pointer = selected ? theme.fg("accent", "❯") : " ";
								const status = getTaskDisplayStatus(task);
								const color = statusColor(status);
								const ownerText = task.owner
									? ` @${sanitizeForDisplay(task.owner, 80)}`
									: "";
								const teamText = task.team ? ` team:${task.team}` : "";
								const activity = task.owner
									? ownerActivity.get(task.owner)
									: undefined;
								const activityText = activity
									? ` → ${sanitizeForDisplay(activity, 120)}`
									: "";
								const safeTitle = sanitizeForDisplay(task.title, 160);
								const safeActiveForm = task.activeForm
									? sanitizeForDisplay(task.activeForm, 120)
									: undefined;
								const title =
									status === "in-progress" ? theme.bold(safeTitle) : safeTitle;
								const line = `${pointer} ${theme.fg(color, statusIcon(status))} ${theme.fg("dim", `#${task.id}`)} ${title}${ownerText}${teamText}${activityText}`;
								for (const wrapped of wrapText(line, innerW - 1))
									lines.push(row(wrapped));
								if (safeActiveForm && task.activeForm !== task.title) {
									const activeLine = `${pointer} ${theme.fg("dim", `active: ${safeActiveForm}`)}`;
									for (const wrapped of wrapText(activeLine, innerW - 1))
										lines.push(row(wrapped));
								}
								if (task.notes) {
									for (const wrapped of wrapText(
										theme.fg(
											"dim",
											`notes: ${sanitizeForDisplay(task.notes, 200)}`,
										),
										innerW - 3,
									))
										lines.push(row(`   ${wrapped}`));
								}
							}
						}

						const termH = process.stdout.rows || 40;
						const targetH = Math.floor(termH * 0.82);
						while (lines.length < targetH - 2) lines.push(row(""));
						lines.push(
							row(
								theme.fg(
									"dim",
									"↑↓ select · t team · s scope · o owner · d done · a assign · u unassign · i in-progress · x done/todo · esc close",
								),
							),
						);
						lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
						return lines;
					},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || matchesKey(data, "alt+t")) {
							cleanup();
							done();
							return;
						}
						if (matchesKey(data, Key.up)) {
							selectedTaskIdx = Math.max(0, selectedTaskIdx - 1);
						} else if (matchesKey(data, Key.down)) {
							selectedTaskIdx = selectedTaskIdx + 1;
						} else if (data === "t") {
							teamIdx = (teamIdx + 1) % getTeamOptions().length;
							selectedTaskIdx = 0;
						} else if (data === "s") {
							scopeIdx = (scopeIdx + 1) % 3;
							selectedTaskIdx = 0;
						} else if (data === "o") {
							ownerIdx = (ownerIdx + 1) % getOwnerOptions().length;
							selectedTaskIdx = 0;
						} else if (data === "d") {
							includeDone = !includeDone;
							selectedTaskIdx = 0;
						} else if (data === "a") {
							void mutateSelectedTask(async (task) => {
								const owners = getAssignableOwners();
								const currentIdx = owners.indexOf(task.owner ?? "");
								const nextOwner =
									owners[(currentIdx + 1 + owners.length) % owners.length] ??
									"";
								await updateTaskRecord(uiCtx.cwd, task.id, {
									owner: nextOwner || undefined,
								});
							});
						} else if (data === "u") {
							void mutateSelectedTask(async (task) => {
								await updateTaskRecord(uiCtx.cwd, task.id, {
									owner: undefined,
								});
							});
						} else if (data === "i") {
							void mutateSelectedTask(async (task) => {
								await updateTaskRecord(
									uiCtx.cwd,
									task.id,
									{ status: "in-progress" },
									"supervisor",
								);
							});
						} else if (data === "x") {
							void mutateSelectedTask(async (task) => {
								await updateTaskRecord(
									uiCtx.cwd,
									task.id,
									{ status: task.status === "done" ? "todo" : "done" },
									"supervisor",
								);
							});
						}
						tui.requestRender();
					},
					invalidate() {},
					dispose() {
						cleanup();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 86, maxHeight: "85%" },
			},
		);
	}

	pi.registerTool<typeof todoToolParamsSchema, TodoToolDetails>({
		name: "todo",
		label: "Todo",
		description:
			"Manage a structured shared task board with dependencies, ownership, active forms, private/shared scope, and optional team namespaces. " +
			"Actions: create, update, delete, list, claim. Use to plan multi-step work, track progress across subagents, and coordinate persistent workers.",
		parameters: todoToolParamsSchema,

		async execute(_toolCallId, params) {
			if (!ctx) {
				return {
					content: [{ type: "text", text: "Todo extension is not ready yet." }],
					details: { error: true },
				};
			}

			const p = params as TodoToolParams;
			const actorName = getActorName();
			const selectedTeam =
				normalizeTeamInput(typeof p.team === "string" ? p.team : undefined) ??
				getDefaultTeam();

			try {
				if (p.action === "create") {
					const items: TodoBatchItemInput[] = Array.isArray(p.tasks)
						? p.tasks
						: [
								{
									title: p.title ?? "",
									activeForm: p.activeForm,
									priority: normalizePriority(p.priority),
									scope: normalizeScope(p.scope),
									team: p.team,
									dependencies: p.dependencies,
									owner: p.owner,
									notes: p.notes,
								},
							];
					if (
						!items.every(
							(item) => typeof item.title === "string" && item.title.trim(),
						)
					) {
						return {
							content: [
								{
									type: "text",
									text: "Error: title is required for create action.",
								},
							],
							details: { error: true },
						};
					}
					const created = await createTasks(
						ctx.cwd,
						items.map((item) => ({
							title: item.title,
							activeForm: item.activeForm,
							priority: normalizePriority(item.priority),
							scope: normalizeScope(item.scope) ?? "shared",
							team: item.team ?? selectedTeam,
							dependencies: item.dependencies ?? [],
							owner: item.owner,
							notes: item.notes,
						})),
					);
					await refreshLoop();
					return {
						content: [
							{
								type: "text",
								text: `Created ${created.length} task(s):\n${created.map((task) => `#${task.id} ${task.title}`).join("\n")}\n\n${formatTaskList(currentTasks, ownerActivity)}`,
							},
						],
						details: { created: created.length },
					};
				}

				if (p.action === "update") {
					if (!p.id) {
						return {
							content: [
								{
									type: "text",
									text: "Error: id is required for update action.",
								},
							],
							details: { error: true },
						};
					}
					const task = await updateTaskRecord(
						ctx.cwd,
						p.id,
						{
							title: p.title,
							activeForm: p.activeForm,
							priority: normalizePriority(p.priority),
							scope: normalizeScope(p.scope),
							team: typeof p.team === "string" ? selectedTeam : undefined,
							dependencies: p.dependencies,
							owner: p.owner,
							notes: p.notes,
							status: p.status,
						},
						actorName,
					);
					if (!task) {
						return {
							content: [
								{ type: "text", text: `Error: task #${p.id} not found.` },
							],
							details: { error: true },
						};
					}
					await refreshLoop();
					return {
						content: [
							{
								type: "text",
								text: `Updated task #${task.id}: ${task.title} → ${getTaskDisplayStatus(task)}\n\n${formatTaskList(currentTasks, ownerActivity)}`,
							},
						],
						details: { taskId: task.id },
					};
				}

				if (p.action === "delete") {
					if (!p.id) {
						return {
							content: [
								{
									type: "text",
									text: "Error: id is required for delete action.",
								},
							],
							details: { error: true },
						};
					}
					const removed = await deleteTaskRecord(ctx.cwd, p.id);
					if (!removed) {
						return {
							content: [
								{ type: "text", text: `Error: task #${p.id} not found.` },
							],
							details: { error: true },
						};
					}
					await refreshLoop();
					return {
						content: [
							{
								type: "text",
								text: `Deleted task #${removed.id}: ${removed.title}\n\n${formatTaskList(currentTasks, ownerActivity)}`,
							},
						],
						details: { taskId: removed.id },
					};
				}

				if (p.action === "claim") {
					const owner = p.owner || actorName;
					if (!owner) {
						return {
							content: [
								{
									type: "text",
									text: "Error: claim needs an owner or an agent context.",
								},
							],
							details: { error: true },
						};
					}
					const claimed = await claimNextSharedTask(ctx.cwd, owner, {
						team: selectedTeam,
						checkBusy: true,
					});
					if (!claimed.success) {
						const reason =
							claimed.reason === "agent_busy"
								? `Owner ${owner} is already busy with tasks ${claimed.busyWithTaskIds?.map((id) => `#${id}`).join(", ")}`
								: "No available shared tasks to claim.";
						return {
							content: [{ type: "text", text: reason }],
							details: { error: true },
						};
					}
					const claimedTask = claimed.task;
					if (!claimedTask) {
						return {
							content: [
								{
									type: "text",
									text: "Error: claim succeeded without a task payload.",
								},
							],
							details: { error: true },
						};
					}
					await refreshLoop();
					return {
						content: [
							{
								type: "text",
								text: `Claimed task #${claimedTask.id} for ${owner}.\n\n${buildTaskPrompt(claimedTask)}`,
							},
						],
						details: { taskId: claimedTask.id },
					};
				}

				await refreshLoop();
				const filter: TaskFilter = {
					team: selectedTeam,
					scope: normalizeScope(p.scope),
					owner:
						typeof p.owner === "string" && p.owner.trim()
							? p.owner.trim()
							: undefined,
					includeDone: p.includeDone !== false,
				};
				const tasks = sortTasks(filterTasks(loadBoard(ctx.cwd).tasks, filter));
				return {
					content: [
						{ type: "text", text: formatTaskList(tasks, ownerActivity) },
					],
					details: { count: tasks.length },
				};
			} catch (error) {
				await refreshLoop();
				return {
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: { error: true },
				};
			}
		},

		renderCall(args, theme, context) {
			const text =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			const p = args as TodoToolParams;
			let label = theme.fg("toolTitle", theme.bold("todo "));
			switch (p.action) {
				case "create":
					label += theme.fg(
						"accent",
						p.tasks
							? `create ${p.tasks.length} tasks`
							: `create "${sanitizeForDisplay(p.title || "", 80)}"`,
					);
					break;
				case "update":
					label += theme.fg("accent", `update #${p.id || "?"}`);
					break;
				case "delete":
					label += theme.fg("accent", `delete #${p.id || "?"}`);
					break;
				case "claim":
					label += theme.fg(
						"accent",
						`claim${p.team ? ` team:${p.team}` : ""}`,
					);
					break;
				default:
					label += theme.fg("accent", "list");
			}
			if (p.team) label += theme.fg("muted", ` [team:${p.team}]`);
			text.setText(label);
			return text;
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
			const details = result.details as TodoToolDetails | undefined;
			if (details?.error) {
				const firstLine =
					result.content[0]?.type === "text"
						? (result.content[0].text.split("\n")[0] ?? "error")
						: "error";
				return new Text(
					theme.fg("error", sanitizeForDisplay(firstLine, 200)),
					0,
					0,
				);
			}
			if (details?.created)
				return new Text(theme.fg("success", `+${details.created} tasks`), 0, 0);
			if (details?.taskId)
				return new Text(
					theme.fg("success", `#${details.taskId} updated`),
					0,
					0,
				);
			if (details?.count !== undefined)
				return new Text(theme.fg("dim", `${details.count} tasks`), 0, 0);
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});

	pi.registerShortcut("alt+t", {
		description: "Show task board details",
		handler: async (shortcutCtx) => {
			if (shortcutCtx.mode !== "tui") return;
			await showTodoOverlay(shortcutCtx);
		},
	});

	pi.registerCommand("todo", {
		description: "Show task board overlay",
		handler: async (_args, cmdCtx) => {
			if (cmdCtx.mode !== "tui") return;
			await showTodoOverlay(cmdCtx);
		},
	});

	pi.registerCommand("todo-clear", {
		description: "Clear the current project task board",
		handler: async (_args, cmdCtx) => {
			if (!ctx) return;
			try {
				const cleared = await clearTaskBoard(ctx.cwd);
				await refreshLoop();
				if (cmdCtx.hasUI)
					cmdCtx.ui.notify(
						`Task board cleared (${cleared} tasks removed)`,
						"info",
					);
			} catch (error) {
				if (cmdCtx.hasUI)
					cmdCtx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"error",
					);
			}
		},
	});

	pi.on("session_start", async (_event, startCtx) => {
		ctx = startCtx;
		await refreshLoop();
		refreshTimer = setInterval(() => {
			void refreshLoop();
		}, REFRESH_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	});
}
