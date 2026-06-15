/**
 * Subagent System Extension
 *
 * Claude-inspired v2 design:
 * - supervisor keeps structured task state per agent
 * - child agents write progress snapshots to disk
 * - follow-ups are queued through an inbox instead of typed into the editor
 * - completed agents keep a resumable session transcript
 * - running agents are visible in a tmux monitor overlay; completed agents open a detail view
 *
 * The agent runtime lives on disk under ~/.pi/agents/{id}/ (session.jsonl,
 * status.txt, progress.json, supervisor.json, prompt.txt, inbox/) — these paths
 * are live, shipped on-disk state and are preserved verbatim. The tmux-based
 * supervised-agent model is retained by design: each agent is a full `pi` CLI
 * child running in its own tmux window against a shared session transcript.
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildTaskPrompt,
	claimNextSharedTask,
	getTaskDoneMarker,
	loadBoard,
	markTaskDone,
	reassignOrDeleteTeamTasks,
	releaseOwnedTasks,
} from "./shared/task-board";
import {
	createTeam,
	deleteTeam,
	listTeams,
	normalizeTeamInput,
} from "./shared/team-registry";

// ── Types ───────────────────────────────────────────────────────────

type AgentStatus = "running" | "done" | "error" | "killed";
type ChildPhase =
	| "starting"
	| "waiting"
	| "running"
	| "done"
	| "error"
	| "killed";

/**
 * On-disk progress snapshot written by each child to
 * ~/.pi/agents/{id}/progress.json. todo.ts's alt+t overlay (readOwnerActivity)
 * reads a loose subset of this shape — keep `name`, `cwd`, `lastActivity`,
 * `recentActivities`, `currentTaskId`, `phase`, `queuedMessages`, `updatedAt`
 * present and matching todo's reader.
 */
interface AgentProgressSnapshot {
	agentId: string;
	name: string;
	description: string;
	cwd?: string;
	team?: string;
	persistent?: boolean;
	autoClaim?: boolean;
	paused?: boolean;
	currentTaskId?: number;
	runCount: number;
	phase: ChildPhase;
	turnCount: number;
	toolUseCount: number;
	queuedMessages: number;
	lastActivity?: string;
	recentActivities: string[];
	lastAssistantText?: string;
	finalResult?: string;
	updatedAt: number;
}

interface AgentState {
	id: string;
	name: string;
	description: string;
	cwd: string;
	team?: string;
	persistent: boolean;
	autoClaim: boolean;
	paused: boolean;
	model?: string;
	status: AgentStatus;
	tmuxWindow?: string;
	createdAt: number;
	lastRunStartedAt: number;
	runCount: number;
	sessionFile: string;
	statusFile: string;
	progressFile: string;
	result?: string;
	exitCode?: number;
	lastActivity?: string;
	recentActivities: string[];
	turnCount: number;
	toolUseCount: number;
	queuedMessages: number;
	childPhase: ChildPhase;
	currentTaskId?: number;
	lastUpdateTime?: number;
	cleanupScheduled?: boolean;
}

interface PersistedSupervisorState {
	supervisorPid: number;
	id: string;
	name: string;
	description: string;
	cwd: string;
	team?: string;
	persistent: boolean;
	autoClaim: boolean;
	paused: boolean;
	model?: string;
	status: AgentStatus;
	tmuxWindow?: string;
	createdAt: number;
	lastRunStartedAt: number;
	runCount: number;
	result?: string;
	exitCode?: number;
	lastActivity?: string;
	recentActivities: string[];
	turnCount: number;
	toolUseCount: number;
	queuedMessages: number;
	childPhase: ChildPhase;
	currentTaskId?: number;
	lastUpdateTime?: number;
}

type UnknownRecord = Record<string, unknown>;

interface SpawnAgentResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

interface SpawnRequestPayload extends UnknownRecord {
	resolve: (result: SpawnAgentResult) => void;
}

// ── Constants ───────────────────────────────────────────────────────

const AGENT_DIR = join(homedir(), ".pi", "agents");
const LOG_PATH = join(homedir(), ".pi", "agent", "subagents.log");
const POLL_INTERVAL_MS = 1000;
const REFRESH_INTERVAL_MS = 1000;
const WINDOW_CLEANUP_DELAY_MS = 1500;
const CHILD_INBOX_POLL_MS = 500;
const CHILD_SHUTDOWN_DELAY_MS = 500;
const MAX_RECENT_ACTIVITIES = 5;
const MAX_RESULT_PREVIEW_CHARS = 1200;
const MAX_OVERLAY_RESULT_CHARS = 4000;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const SUBAGENT_UI_MODE_ENV = "PI_SUBAGENT_UI_MODE";
const SUBAGENT_UI_MODE_OVERLAY = "overlay-no-editor";
const SUBAGENT_ID_ENV = "PI_SUBAGENT_ID";
const SUBAGENT_NAME_ENV = "PI_SUBAGENT_NAME";
const SUBAGENT_DESCRIPTION_ENV = "PI_SUBAGENT_DESCRIPTION";
const SUBAGENT_RUN_COUNT_ENV = "PI_SUBAGENT_RUN_COUNT";
const SUBAGENT_TEAM_ENV = "PI_SUBAGENT_TEAM";
const SUBAGENT_PERSISTENT_ENV = "PI_SUBAGENT_PERSISTENT";
const SUBAGENT_AUTOCLAIM_ENV = "PI_SUBAGENT_AUTOCLAIM";
const SUBAGENT_PAUSED_ENV = "PI_SUBAGENT_PAUSED";
const CONTROL_PREFIX = "__PI_SUBAGENT_CONTROL__:";

/**
 * Diagnostics go to a file sink, never the console: a raw write to stdout/stderr
 * while the TUI is mounted desyncs pi's differential renderer (gotchas §14/§15).
 * Matches todo.ts's ~/.pi/agent/todo.log convention.
 */
function logDiagnostic(message: string, error?: unknown): void {
	try {
		const detail =
			error === undefined
				? ""
				: `: ${error instanceof Error ? error.stack || error.message : String(error)}`;
		appendFileSync(
			LOG_PATH,
			`${new Date().toISOString()} ${message}${detail}\n`,
		);
	} catch {}
}

/**
 * Strip ANSI escapes, control bytes, and bidi overrides, collapse whitespace,
 * and clamp length before any render measurement. The capture-pane monitor and
 * every overlay error branch funnel raw terminal/error text through this so a
 * stray control byte can never trip the renderer's width math (gotchas §16).
 */
function sanitizeForDisplay(input: string, max = 4000): string {
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

/**
 * Sanitize a captured tmux pane line: keep printable content but neutralize
 * control bytes / tabs that break width math, while preserving leading
 * whitespace (terminal output is layout-significant). ANSI SGR sequences from
 * `capture-pane -e` are dropped — the overlay reapplies its own framing color.
 */
function sanitizePaneLine(input: string): string {
	let result = "";
	let i = 0;
	while (i < input.length) {
		const code = input.charCodeAt(i);
		// Drop ANSI/OSC escape sequences (capture-pane -e emits these).
		if (code === 0x1b) {
			i++;
			const next = input.charCodeAt(i);
			if (next === 0x5b) {
				// CSI: ESC [ ... final byte in 0x40-0x7e
				i++;
				while (i < input.length) {
					const c = input.charCodeAt(i);
					i++;
					if (c >= 0x40 && c <= 0x7e) break;
				}
			} else if (next === 0x5d) {
				// OSC: ESC ] ... terminated by BEL or ST (ESC \)
				i++;
				while (i < input.length) {
					const c = input.charCodeAt(i);
					if (c === 0x07) {
						i++;
						break;
					}
					if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) {
						i += 2;
						break;
					}
					i++;
				}
			} else {
				i++;
			}
			continue;
		}
		if (code === 0x09) {
			result += "  ";
			i++;
			continue;
		}
		// bidi overrides
		if (
			code === 0x202a ||
			code === 0x202b ||
			code === 0x202c ||
			code === 0x202d ||
			code === 0x202e ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			i++;
			continue;
		}
		const isControl =
			code <= 0x08 ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			(code >= 0x7f && code <= 0x9f);
		if (isControl) {
			result += " ";
			i++;
			continue;
		}
		result += input[i] ?? "";
		i++;
	}
	return result;
}

class OverlayOnlySubagentEditor extends CustomEditor {
	private readonly statusLine: (text: string) => string;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		// setEditorComponent provides an EditorTheme, not the full extension Theme API.
		// Using theme.fg(...) here crashes child subagents before they can process work.
		this.statusLine = (text: string) => `\x1b[2m${text}\x1b[0m`;
	}

	override render(width: number): string[] {
		const line = `${this.statusLine(" subagent input hidden · supervisor queues follow-ups ")}${CURSOR_MARKER} `;
		return [truncateToWidth(line, Math.max(1, width))];
	}
}

// ── Resolve binaries once ───────────────────────────────────────────

function which(bin: string): string | null {
	try {
		return execSync(`which ${bin}`, {
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
	} catch {
		return null;
	}
}

const TMUX_BIN = which("tmux");
const PI_BIN = which("pi");
const PROCESS_CLEANUP_KEY = "__pi_subagents_process_cleanup_installed__";
const PROCESS_TMUX_SESSION = `pi-agents-${process.pid}`;
const globalProcessState = globalThis as typeof globalThis &
	Record<string, unknown>;

if (!globalProcessState[PROCESS_CLEANUP_KEY]) {
	globalProcessState[PROCESS_CLEANUP_KEY] = true;
	process.on("exit", () => {
		if (TMUX_BIN) {
			try {
				execSync(
					`"${TMUX_BIN}" kill-session -t "${PROCESS_TMUX_SESSION}" 2>/dev/null`,
					{ timeout: 3000 },
				);
			} catch {}
		}
		cleanupSupervisorRuntimeFilesForCurrentProcess();
	});
}

// ── Shared filesystem helpers ──────────────────────────────────────

function agentDir(id: string): string {
	return join(AGENT_DIR, id);
}

function isValidAgentId(id: unknown): id is string {
	return typeof id === "string" && AGENT_ID_RE.test(id);
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function getNestedRecord(
	value: unknown,
	key: string,
): UnknownRecord | undefined {
	if (!isRecord(value)) return undefined;
	const nestedValue = value[key];
	return isRecord(nestedValue) ? nestedValue : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const propertyValue = value[key];
	return typeof propertyValue === "string" ? propertyValue : undefined;
}

function isSpawnRequestPayload(value: unknown): value is SpawnRequestPayload {
	if (!isRecord(value)) return false;
	const resolveValue = value.resolve;
	return typeof resolveValue === "function";
}

function agentStatusFile(id: string): string {
	return join(agentDir(id), "status.txt");
}

function agentPromptFile(id: string): string {
	return join(agentDir(id), "prompt.txt");
}

function agentSessionFile(id: string): string {
	return join(agentDir(id), "session.jsonl");
}

function agentProgressFile(id: string): string {
	return join(agentDir(id), "progress.json");
}

function agentInboxDir(id: string): string {
	return join(agentDir(id), "inbox");
}

function agentSupervisorFile(id: string): string {
	return join(agentDir(id), "supervisor.json");
}

function ensureAgentFilesystem(id: string): void {
	mkdirSync(agentDir(id), { recursive: true, mode: 0o700 });
	mkdirSync(agentInboxDir(id), { recursive: true, mode: 0o700 });
	writeFileSync(agentSessionFile(id), "", { mode: 0o600, flag: "a" });
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(tmp, path);
}

function readJsonFile<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function truncatePlainText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function listInboxFiles(id: string): string[] {
	const dir = agentInboxDir(id);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".msg"))
			.sort()
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

function countInboxMessages(id: string): number {
	return listInboxFiles(id).length;
}

function peekNextInboxMessage(id: string): string | null {
	const [first] = listInboxFiles(id);
	if (!first) return null;
	try {
		return readFileSync(first, "utf-8");
	} catch {
		return null;
	}
}

function enqueueInboxMessage(id: string, message: string): void {
	ensureAgentFilesystem(id);
	const file = join(
		agentInboxDir(id),
		`${Date.now().toString().padStart(13, "0")}-${randomUUID().slice(0, 8)}.msg`,
	);
	writeFileSync(file, message, { mode: 0o600 });
}

function popNextInboxMessage(
	id: string,
): { path: string; message: string } | null {
	for (const path of listInboxFiles(id)) {
		try {
			const message = readFileSync(path, "utf-8");
			return { path, message };
		} catch {
			try {
				unlinkSync(path);
			} catch {}
		}
	}
	return null;
}

function deleteAgentFilesystem(id: string): void {
	try {
		rmSync(agentDir(id), { recursive: true, force: true });
	} catch {}
}

function persistSupervisorState(agent: AgentState): void {
	ensureAgentFilesystem(agent.id);
	const persisted: PersistedSupervisorState = {
		supervisorPid: process.pid,
		id: agent.id,
		name: agent.name,
		description: agent.description,
		cwd: agent.cwd,
		team: agent.team,
		persistent: agent.persistent,
		autoClaim: agent.autoClaim,
		paused: agent.paused,
		model: agent.model,
		status: agent.status,
		tmuxWindow: agent.tmuxWindow,
		createdAt: agent.createdAt,
		lastRunStartedAt: agent.lastRunStartedAt,
		runCount: agent.runCount,
		result: agent.result,
		exitCode: agent.exitCode,
		lastActivity: agent.lastActivity,
		recentActivities: [...agent.recentActivities],
		turnCount: agent.turnCount,
		toolUseCount: agent.toolUseCount,
		queuedMessages: agent.queuedMessages,
		childPhase: agent.childPhase,
		currentTaskId: agent.currentTaskId,
		lastUpdateTime: agent.lastUpdateTime,
	};
	writeJsonAtomic(agentSupervisorFile(agent.id), persisted);
}

function loadPersistedSupervisorState(
	id: string,
): PersistedSupervisorState | null {
	return readJsonFile<PersistedSupervisorState>(agentSupervisorFile(id));
}

function normalizePersistedSupervisorState(
	raw: unknown,
	expectedId: string,
): PersistedSupervisorState | null {
	if (!raw || typeof raw !== "object") return null;
	const state = raw as Partial<PersistedSupervisorState>;
	if (!isValidAgentId(expectedId) || state.id !== expectedId) return null;
	if (typeof state.supervisorPid !== "number" || typeof state.cwd !== "string")
		return null;
	if (typeof state.name !== "string" || typeof state.description !== "string")
		return null;
	if (
		state.status !== "running" &&
		state.status !== "done" &&
		state.status !== "error" &&
		state.status !== "killed"
	)
		return null;
	if (
		state.childPhase !== "starting" &&
		state.childPhase !== "waiting" &&
		state.childPhase !== "running" &&
		state.childPhase !== "done" &&
		state.childPhase !== "error" &&
		state.childPhase !== "killed"
	)
		return null;
	return {
		supervisorPid: state.supervisorPid,
		id: expectedId,
		name: state.name,
		description: state.description,
		cwd: state.cwd,
		team:
			typeof state.team === "string" && state.team.trim()
				? state.team
				: undefined,
		persistent: Boolean(state.persistent),
		autoClaim: Boolean(state.autoClaim),
		paused: Boolean(state.paused),
		model:
			typeof state.model === "string" && state.model.trim()
				? state.model
				: undefined,
		status: state.status,
		tmuxWindow:
			typeof state.tmuxWindow === "string" && state.tmuxWindow.trim()
				? state.tmuxWindow
				: undefined,
		createdAt:
			typeof state.createdAt === "number" ? state.createdAt : Date.now(),
		lastRunStartedAt:
			typeof state.lastRunStartedAt === "number"
				? state.lastRunStartedAt
				: Date.now(),
		runCount: typeof state.runCount === "number" ? state.runCount : 0,
		result: typeof state.result === "string" ? state.result : undefined,
		exitCode: typeof state.exitCode === "number" ? state.exitCode : undefined,
		lastActivity:
			typeof state.lastActivity === "string" ? state.lastActivity : undefined,
		recentActivities: Array.isArray(state.recentActivities)
			? state.recentActivities.filter(
					(value): value is string => typeof value === "string",
				)
			: [],
		turnCount: typeof state.turnCount === "number" ? state.turnCount : 0,
		toolUseCount:
			typeof state.toolUseCount === "number" ? state.toolUseCount : 0,
		queuedMessages:
			typeof state.queuedMessages === "number" ? state.queuedMessages : 0,
		childPhase: state.childPhase,
		currentTaskId:
			typeof state.currentTaskId === "number" ? state.currentTaskId : undefined,
		lastUpdateTime:
			typeof state.lastUpdateTime === "number"
				? state.lastUpdateTime
				: undefined,
	};
}

function normalizeProgressSnapshot(
	raw: unknown,
	expectedId: string,
): AgentProgressSnapshot | null {
	if (!raw || typeof raw !== "object") return null;
	const snapshot = raw as Partial<AgentProgressSnapshot>;
	if (!isValidAgentId(expectedId) || snapshot.agentId !== expectedId)
		return null;
	if (
		typeof snapshot.name !== "string" ||
		typeof snapshot.description !== "string"
	)
		return null;
	if (
		snapshot.phase !== "starting" &&
		snapshot.phase !== "waiting" &&
		snapshot.phase !== "running" &&
		snapshot.phase !== "done" &&
		snapshot.phase !== "error" &&
		snapshot.phase !== "killed"
	)
		return null;
	return {
		agentId: expectedId,
		name: snapshot.name,
		description: snapshot.description,
		cwd:
			typeof snapshot.cwd === "string" && snapshot.cwd.trim()
				? snapshot.cwd
				: undefined,
		team:
			typeof snapshot.team === "string" && snapshot.team.trim()
				? snapshot.team
				: undefined,
		persistent: Boolean(snapshot.persistent),
		autoClaim: Boolean(snapshot.autoClaim),
		paused: Boolean(snapshot.paused),
		currentTaskId:
			typeof snapshot.currentTaskId === "number"
				? snapshot.currentTaskId
				: undefined,
		runCount: typeof snapshot.runCount === "number" ? snapshot.runCount : 0,
		phase: snapshot.phase,
		turnCount: typeof snapshot.turnCount === "number" ? snapshot.turnCount : 0,
		toolUseCount:
			typeof snapshot.toolUseCount === "number" ? snapshot.toolUseCount : 0,
		queuedMessages:
			typeof snapshot.queuedMessages === "number" ? snapshot.queuedMessages : 0,
		lastActivity:
			typeof snapshot.lastActivity === "string"
				? snapshot.lastActivity
				: undefined,
		recentActivities: Array.isArray(snapshot.recentActivities)
			? snapshot.recentActivities.filter(
					(value): value is string => typeof value === "string",
				)
			: [],
		lastAssistantText:
			typeof snapshot.lastAssistantText === "string"
				? snapshot.lastAssistantText
				: undefined,
		finalResult:
			typeof snapshot.finalResult === "string"
				? snapshot.finalResult
				: undefined,
		updatedAt:
			typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : Date.now(),
	};
}

function listRestorableAgentsForCwd(cwd: string): PersistedSupervisorState[] {
	if (!existsSync(AGENT_DIR)) return [];
	try {
		return readdirSync(AGENT_DIR)
			.map((entry) =>
				normalizePersistedSupervisorState(
					loadPersistedSupervisorState(entry),
					entry,
				),
			)
			.filter((state): state is PersistedSupervisorState => state !== null)
			.filter(
				(state) => state.supervisorPid === process.pid && state.cwd === cwd,
			)
			.sort((a, b) => a.createdAt - b.createdAt);
	} catch {
		return [];
	}
}

function cleanupSupervisorRuntimeFilesForCurrentProcess(): void {
	if (!existsSync(AGENT_DIR)) return;
	try {
		for (const entry of readdirSync(AGENT_DIR)) {
			const state = normalizePersistedSupervisorState(
				loadPersistedSupervisorState(entry),
				entry,
			);
			if (!state || state.supervisorPid !== process.pid) continue;
			deleteAgentFilesystem(entry);
		}
	} catch {}
}

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30) || "agent";
}

function describeToolActivity(toolName: string, input: unknown): string {
	const inputRecord = isRecord(input) ? input : undefined;
	switch (toolName) {
		case "read":
			return typeof inputRecord?.path === "string"
				? `reading ${inputRecord.path}`
				: "reading files";
		case "write":
			return typeof inputRecord?.path === "string"
				? `writing ${inputRecord.path}`
				: "writing files";
		case "edit":
			return typeof inputRecord?.path === "string"
				? `editing ${inputRecord.path}`
				: "editing files";
		case "bash": {
			const command =
				typeof inputRecord?.command === "string"
					? inputRecord.command.trim()
					: "";
			if (!command) return "running bash";
			return `bash: ${truncatePlainText(command.replace(/\s+/g, " "), 80)}`;
		}
		case "grep":
			return typeof inputRecord?.pattern === "string"
				? `searching for ${inputRecord.pattern}`
				: "searching code";
		case "find":
			return typeof inputRecord?.pattern === "string"
				? `finding ${inputRecord.pattern}`
				: "finding files";
		case "ls":
			return typeof inputRecord?.path === "string"
				? `listing ${inputRecord.path}`
				: "listing files";
		default:
			return `using ${toolName}`;
	}
}

function extractMessageRole(message: unknown): string | undefined {
	return (
		getStringProperty(message, "role") ??
		getStringProperty(getNestedRecord(message, "message"), "role")
	);
}

function extractMessageContent(message: unknown): unknown[] {
	const directContent = isRecord(message) ? message.content : undefined;
	const nestedContent = getNestedRecord(message, "message")?.content;
	const content = directContent ?? nestedContent;
	return Array.isArray(content) ? content : [];
}

function extractAssistantText(message: unknown): string | undefined {
	const texts = extractMessageContent(message)
		.flatMap((block) => {
			if (!isRecord(block)) return [];
			if (block.type !== "text") return [];
			return typeof block.text === "string" ? [block.text.trim()] : [];
		})
		.filter(Boolean);
	if (texts.length === 0) return undefined;
	return texts.join("\n\n").trim();
}

function createInitialProgressSnapshot(args: {
	agentId: string;
	name: string;
	description: string;
	cwd?: string;
	team?: string;
	persistent?: boolean;
	autoClaim?: boolean;
	paused?: boolean;
	currentTaskId?: number;
	runCount: number;
	phase?: ChildPhase;
}): AgentProgressSnapshot {
	return {
		agentId: args.agentId,
		name: args.name,
		description: args.description,
		cwd: args.cwd,
		team: args.team,
		persistent: args.persistent,
		autoClaim: args.autoClaim,
		paused: args.paused,
		currentTaskId: args.currentTaskId,
		runCount: args.runCount,
		phase: args.phase ?? "starting",
		turnCount: 0,
		toolUseCount: 0,
		queuedMessages: countInboxMessages(args.agentId),
		recentActivities: [],
		updatedAt: Date.now(),
	};
}

function applyProgressSnapshot(
	agent: AgentState,
	snapshot: AgentProgressSnapshot,
): boolean {
	let changed = false;
	const set = <K extends keyof AgentState>(key: K, value: AgentState[K]) => {
		if (agent[key] !== value) {
			agent[key] = value;
			changed = true;
		}
	};

	set("queuedMessages", snapshot.queuedMessages);
	set("lastActivity", snapshot.lastActivity);
	set("turnCount", snapshot.turnCount);
	set("toolUseCount", snapshot.toolUseCount);
	set("childPhase", snapshot.phase);
	set("lastUpdateTime", snapshot.updatedAt);
	set("currentTaskId", snapshot.currentTaskId);
	set("paused", Boolean(snapshot.paused));

	const latestResult = snapshot.finalResult ?? snapshot.lastAssistantText;
	if (latestResult !== undefined && agent.result !== latestResult) {
		agent.result = latestResult;
		changed = true;
	}

	const nextRecent = Array.isArray(snapshot.recentActivities)
		? [...snapshot.recentActivities]
		: [];
	if (JSON.stringify(agent.recentActivities) !== JSON.stringify(nextRecent)) {
		agent.recentActivities = nextRecent;
		changed = true;
	}

	return changed;
}

function statusIcon(status: AgentStatus, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "◌");
		case "done":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "killed":
			return theme.fg("dim", "⊘");
	}
}

function agentSummaryLine(agent: AgentState): string {
	const activity =
		agent.lastActivity ??
		(agent.status === "running" ? "running" : agent.status);
	const queued =
		agent.queuedMessages > 0 ? ` · queued ${agent.queuedMessages}` : "";
	const team = agent.team ? ` · team:${agent.team}` : "";
	const task = agent.currentTaskId ? ` · task #${agent.currentTaskId}` : "";
	const mode = agent.persistent
		? agent.autoClaim
			? " · worker:auto"
			: " · worker"
		: "";
	const paused = agent.paused ? " · paused" : "";
	return sanitizeForDisplay(
		`${activity}${queued}${team}${task}${mode}${paused}`,
		400,
	);
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const isOverlayOnlySubagent =
		process.env[SUBAGENT_UI_MODE_ENV] === SUBAGENT_UI_MODE_OVERLAY;
	const childAgentId = process.env[SUBAGENT_ID_ENV];
	const childAgentName = process.env[SUBAGENT_NAME_ENV] ?? "agent";
	const childAgentDescription =
		process.env[SUBAGENT_DESCRIPTION_ENV] ?? "subagent task";
	const childRunCount = Number(process.env[SUBAGENT_RUN_COUNT_ENV] ?? "1") || 1;
	const childTeam = process.env[SUBAGENT_TEAM_ENV]?.trim() || undefined;
	const childPersistent = process.env[SUBAGENT_PERSISTENT_ENV] === "1";
	const childAutoClaim = process.env[SUBAGENT_AUTOCLAIM_ENV] === "1";
	const childPausedInitial = process.env[SUBAGENT_PAUSED_ENV] === "1";

	mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });

	if (isOverlayOnlySubagent && childAgentId) {
		ensureAgentFilesystem(childAgentId);

		let childCtx: ExtensionContext | null = null;
		let inboxTimer: ReturnType<typeof setInterval> | null = null;
		let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
		let isProcessingWork = false;
		let currentClaimedTaskId: number | undefined;
		let currentClaimedTaskCompleted = false;
		let childPaused = childPausedInitial;
		let childProgress = createInitialProgressSnapshot({
			agentId: childAgentId,
			name: childAgentName,
			description: childAgentDescription,
			cwd: process.cwd(),
			team: childTeam,
			persistent: childPersistent,
			autoClaim: childAutoClaim,
			paused: childPaused,
			currentTaskId: undefined,
			runCount: childRunCount,
			phase: "waiting",
		});

		const progressPath = agentProgressFile(childAgentId);
		const writeChildProgress = (patch: Partial<AgentProgressSnapshot>) => {
			childProgress = {
				...childProgress,
				cwd: childCtx?.cwd ?? childProgress.cwd ?? process.cwd(),
				team: childTeam,
				persistent: childPersistent,
				autoClaim: childAutoClaim,
				paused: childPaused,
				currentTaskId: currentClaimedTaskId,
				...patch,
				queuedMessages: countInboxMessages(childAgentId),
				updatedAt: Date.now(),
			};
			writeJsonAtomic(progressPath, childProgress);
		};

		const cancelShutdown = () => {
			if (shutdownTimer) {
				clearTimeout(shutdownTimer);
				shutdownTimer = null;
			}
		};

		const scheduleShutdown = () => {
			if (!childCtx || childPersistent) return;
			cancelShutdown();
			shutdownTimer = setTimeout(() => {
				if (!childCtx || childPersistent) return;
				if (
					!childCtx.isIdle() ||
					childCtx.hasPendingMessages() ||
					countInboxMessages(childAgentId) > 0
				) {
					scheduleShutdown();
					return;
				}
				childCtx.shutdown();
			}, CHILD_SHUTDOWN_DELAY_MS);
		};

		const processNextWork = async () => {
			if (!childCtx || isProcessingWork) return;
			isProcessingWork = true;
			try {
				const next = popNextInboxMessage(childAgentId);
				if (next) {
					const message = next.message.trim();
					if (!message) {
						try {
							unlinkSync(next.path);
						} catch {}
						writeChildProgress({
							queuedMessages: countInboxMessages(childAgentId),
						});
						return;
					}

					if (message.startsWith(CONTROL_PREFIX)) {
						try {
							const control = JSON.parse(
								message.slice(CONTROL_PREFIX.length),
							) as { type?: string };
							if (control.type === "pause") {
								childPaused = true;
								writeChildProgress({
									phase: childCtx.isIdle() ? "waiting" : childProgress.phase,
									lastActivity: "worker paused",
									recentActivities: [
										"worker paused",
										...childProgress.recentActivities,
									].slice(0, MAX_RECENT_ACTIVITIES),
								});
							} else if (control.type === "resume") {
								childPaused = false;
								writeChildProgress({
									phase: childCtx.isIdle() ? "waiting" : childProgress.phase,
									lastActivity: "worker resumed",
									recentActivities: [
										"worker resumed",
										...childProgress.recentActivities,
									].slice(0, MAX_RECENT_ACTIVITIES),
								});
							}
						} catch (error) {
							logDiagnostic("failed to parse control message", error);
						} finally {
							try {
								unlinkSync(next.path);
							} catch {}
						}
						return;
					}

					cancelShutdown();
					try {
						if (childCtx.isIdle()) {
							pi.sendUserMessage(message);
						} else {
							pi.sendUserMessage(message, { deliverAs: "steer" });
						}
						unlinkSync(next.path);
						const activity = `queued follow-up: ${truncatePlainText(message.replace(/\s+/g, " "), 90)}`;
						writeChildProgress({
							phase: childCtx.isIdle() ? "running" : childProgress.phase,
							lastActivity: activity,
							recentActivities: [
								activity,
								...childProgress.recentActivities,
							].slice(0, MAX_RECENT_ACTIVITIES),
						});
					} catch (error) {
						logDiagnostic("failed to deliver follow-up to child", error);
						writeChildProgress({
							queuedMessages: countInboxMessages(childAgentId),
						});
					}
					return;
				}

				if (
					childPersistent &&
					childAutoClaim &&
					!childPaused &&
					currentClaimedTaskId === undefined &&
					childCtx.isIdle()
				) {
					const claimed = await claimNextSharedTask(
						childCtx.cwd,
						childAgentName,
						{
							team: childTeam,
							checkBusy: true,
							agentId: childAgentId,
						},
					);
					if (claimed.success && claimed.task) {
						const nextMessage = peekNextInboxMessage(childAgentId)?.trim();
						if (nextMessage?.startsWith(CONTROL_PREFIX)) {
							const control = JSON.parse(
								nextMessage.slice(CONTROL_PREFIX.length),
							) as { type?: string };
							if (control.type === "pause") {
								await releaseOwnedTasks(childCtx.cwd, childAgentName, {
									team: childTeam,
									agentId: childAgentId,
								}).catch(() => undefined);
								writeChildProgress({
									phase: "waiting",
									lastActivity: "worker paused",
									recentActivities: [
										"worker paused",
										...childProgress.recentActivities,
									].slice(0, MAX_RECENT_ACTIVITIES),
								});
								return;
							}
						}
						currentClaimedTaskId = claimed.task.id;
						currentClaimedTaskCompleted = false;
						const prompt = buildTaskPrompt(claimed.task);
						pi.sendUserMessage(prompt);
						const activity = `auto-claimed task #${claimed.task.id}: ${claimed.task.title}`;
						writeChildProgress({
							phase: "running",
							currentTaskId: currentClaimedTaskId,
							lastActivity: activity,
							recentActivities: [
								activity,
								...childProgress.recentActivities,
							].slice(0, MAX_RECENT_ACTIVITIES),
						});
						return;
					}
				}

				writeChildProgress({
					phase: childPersistent ? "waiting" : childProgress.phase,
					queuedMessages: 0,
					currentTaskId: currentClaimedTaskId,
					lastActivity: childPaused
						? "worker paused"
						: childProgress.lastActivity,
				});
			} finally {
				isProcessingWork = false;
			}
		};

		pi.on("session_start", async (_event, currentCtx) => {
			childCtx = currentCtx;
			if (currentCtx.hasUI) {
				currentCtx.ui.setEditorComponent(
					(tui, theme, keybindings) =>
						new OverlayOnlySubagentEditor(tui, theme, keybindings),
				);
			}
			writeChildProgress({
				phase: "waiting",
				cwd: currentCtx.cwd,
				team: childTeam,
				persistent: childPersistent,
				autoClaim: childAutoClaim,
			});
			void processNextWork();
			inboxTimer = setInterval(() => {
				void processNextWork();
			}, CHILD_INBOX_POLL_MS);
		});

		pi.on("agent_start", async () => {
			cancelShutdown();
			currentClaimedTaskCompleted = false;
			writeChildProgress({
				phase: "running",
				finalResult: undefined,
				lastAssistantText: undefined,
				recentActivities: [],
				toolUseCount: 0,
				turnCount: 0,
			});
		});

		pi.on("turn_start", async () => {
			writeChildProgress({
				phase: "running",
				turnCount: childProgress.turnCount + 1,
			});
		});

		pi.on("tool_call", async (event: ToolCallEvent) => {
			const activity = describeToolActivity(event.toolName, event.input);
			writeChildProgress({
				phase: "running",
				toolUseCount: childProgress.toolUseCount + 1,
				lastActivity: activity,
				recentActivities: [activity, ...childProgress.recentActivities].slice(
					0,
					MAX_RECENT_ACTIVITIES,
				),
			});
		});

		pi.on("message_end", async (event) => {
			const role = extractMessageRole(event.message);
			if (role !== "assistant") return;
			const text = extractAssistantText(event.message);
			if (!text) return;
			let finalText = text;
			if (currentClaimedTaskId !== undefined) {
				const marker = getTaskDoneMarker(currentClaimedTaskId);
				if (text.trimEnd().endsWith(marker)) {
					currentClaimedTaskCompleted = true;
					finalText = text.replace(marker, "").trim();
				}
			}
			writeChildProgress({
				lastAssistantText: finalText,
				finalResult: finalText,
			});
		});

		pi.on("agent_end", async () => {
			if (
				childCtx &&
				currentClaimedTaskId !== undefined &&
				currentClaimedTaskCompleted
			) {
				await markTaskDone(childCtx.cwd, currentClaimedTaskId, {
					agentId: childAgentId,
				}).catch(() => undefined);
				currentClaimedTaskId = undefined;
				currentClaimedTaskCompleted = false;
			}
			const hasQueued = countInboxMessages(childAgentId) > 0;
			writeChildProgress({
				phase: childPersistent ? "waiting" : hasQueued ? "waiting" : "done",
				currentTaskId: currentClaimedTaskId,
				finalResult:
					childProgress.finalResult ?? childProgress.lastAssistantText,
			});
			if (childPersistent) {
				void processNextWork();
			} else {
				scheduleShutdown();
			}
		});

		pi.on("session_shutdown", async () => {
			if (inboxTimer) {
				clearInterval(inboxTimer);
				inboxTimer = null;
			}
			cancelShutdown();
			if (childCtx && (childPersistent || childTeam || childAutoClaim)) {
				await releaseOwnedTasks(childCtx.cwd, childAgentName, {
					team: childTeam,
					agentId: childAgentId,
				}).catch(() => undefined);
			}
		});

		return;
	}

	// ── Supervisor mode state ───────────────────────────────────────

	const agents: Map<string, AgentState> = new Map();
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let ctx: ExtensionContext | null = null;
	const tmuxSession = `pi-agents-${process.pid}`;
	const tmuxAvailable = !!TMUX_BIN;

	if (!TMUX_BIN) {
		logDiagnostic("tmux not found in PATH. spawn_agent will not work.");
	}
	if (!PI_BIN) {
		logDiagnostic("pi not found in PATH. spawn_agent will not work.");
	}

	function getAgent(nameOrId: string): AgentState | undefined {
		const byId = agents.get(nameOrId);
		if (byId) return byId;
		for (const agent of agents.values()) {
			if (agent.name === nameOrId) return agent;
		}
		return undefined;
	}

	function getAgentsForTeam(team: string): AgentState[] {
		return Array.from(agents.values()).filter((agent) => agent.team === team);
	}

	function removeAgent(agent: AgentState): void {
		if (agent.tmuxWindow && tmuxWindowExists(agent.tmuxWindow)) {
			tmuxKillWindow(agent.tmuxWindow);
		}
		if (agent.persistent || agent.team || agent.autoClaim) {
			void releaseOwnedTasks(agent.cwd, agent.name, {
				team: agent.team,
				agentId: agent.id,
			}).catch(() => undefined);
		}
		deleteAgentFilesystem(agent.id);
		agents.delete(agent.id);
	}

	function restoreAgentState(state: PersistedSupervisorState): AgentState {
		ensureAgentFilesystem(state.id);
		const agent: AgentState = {
			id: state.id,
			name: state.name,
			description: state.description,
			cwd: state.cwd,
			team: state.team,
			persistent: state.persistent,
			autoClaim: state.autoClaim,
			paused: !!state.paused,
			model: state.model,
			status: state.status,
			tmuxWindow: state.tmuxWindow,
			createdAt: state.createdAt,
			lastRunStartedAt: state.lastRunStartedAt,
			runCount: state.runCount,
			sessionFile: agentSessionFile(state.id),
			statusFile: agentStatusFile(state.id),
			progressFile: agentProgressFile(state.id),
			result: state.result,
			exitCode: state.exitCode,
			lastActivity: state.lastActivity,
			recentActivities: [...state.recentActivities],
			turnCount: state.turnCount,
			toolUseCount: state.toolUseCount,
			queuedMessages: state.queuedMessages,
			childPhase: state.childPhase,
			currentTaskId: state.currentTaskId,
			lastUpdateTime: state.lastUpdateTime,
		};
		updateAgentProgress(agent);
		return agent;
	}

	function tmuxExec(cmd: string): string {
		if (!TMUX_BIN) return "";
		try {
			return execSync(`"${TMUX_BIN}" ${cmd}`, {
				encoding: "utf-8",
				timeout: 5000,
			}).trim();
		} catch {
			return "";
		}
	}

	function tmuxSessionExists(): boolean {
		if (!TMUX_BIN) return false;
		try {
			execSync(`"${TMUX_BIN}" has-session -t "${tmuxSession}" 2>/dev/null`, {
				timeout: 3000,
			});
			return true;
		} catch {
			return false;
		}
	}

	function ensureTmuxSession(): void {
		if (!tmuxSessionExists()) {
			tmuxExec(`new-session -d -s "${tmuxSession}" -n supervisor`);
		}
	}

	function tmuxCreateWindow(name: string): string {
		const safeName = sanitizeName(name);
		ensureTmuxSession();
		const target = `${tmuxSession}:${safeName}`;
		tmuxExec(`new-window -d -t "${tmuxSession}" -n "${safeName}"`);
		tmuxExec(
			`set-window-option -t '${target.replace(/'/g, "'\\''")}' allow-rename off`,
		);
		tmuxExec(
			`set-window-option -t '${target.replace(/'/g, "'\\''")}' automatic-rename off`,
		);
		return target;
	}

	function tmuxSendKeys(target: string, text: string): void {
		const escaped = target.replace(/'/g, "'\\''");
		const textEscaped = text.replace(/'/g, "'\\''");
		tmuxExec(`send-keys -t '${escaped}' '${textEscaped}' Enter`);
	}

	function tmuxKillWindow(target: string): void {
		const escaped = target.replace(/'/g, "'\\''");
		tmuxExec(`kill-window -t '${escaped}'`);
	}

	function tmuxWindowExists(target?: string): boolean {
		if (!TMUX_BIN || !target) return false;
		try {
			const escaped = target.replace(/'/g, "'\\''");
			execSync(`"${TMUX_BIN}" list-panes -t '${escaped}' 2>/dev/null`, {
				timeout: 3000,
			});
			return true;
		} catch {
			return false;
		}
	}

	function getTeamSummaries(cwd: string): Array<{
		name: string;
		description?: string;
		workers: AgentState[];
		openTasks: number;
		doneTasks: number;
		busyWorkers: number;
	}> {
		const board = loadBoard(cwd);
		return listTeams(cwd).map((team) => {
			const workers = getAgentsForTeam(team.name);
			const teamTasks = board.tasks.filter((task) => task.team === team.name);
			return {
				name: team.name,
				description: team.description,
				workers,
				openTasks: teamTasks.filter((task) => task.status !== "done").length,
				doneTasks: teamTasks.filter((task) => task.status === "done").length,
				busyWorkers: workers.filter(
					(worker) =>
						worker.status === "running" || worker.currentTaskId !== undefined,
				).length,
			};
		});
	}

	function updateWidget() {
		if (!ctx?.hasUI) return;
		const items = Array.from(agents.values());
		if (items.length === 0) {
			ctx.ui.setWidget("agents", undefined);
			return;
		}

		ctx.ui.setWidget("agents", (_tui, theme) => ({
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				const running = items.filter((agent) => agent.status === "running");
				const archivedCount = items.length - running.length;
				const summary =
					theme.fg("dim", "─── agents ") +
					theme.fg(
						"muted",
						running.length > 0
							? `${running.length} running`
							: `${archivedCount} resumable`,
					) +
					(archivedCount > 0 && running.length > 0
						? theme.fg("muted", ` · ${archivedCount} resumable`)
						: "") +
					theme.fg("dim", " ─── ") +
					theme.fg("muted", "alt+a details");

				if (running.length === 0) {
					return [truncateToWidth(summary, safeWidth)];
				}

				const pills = running.map((agent) => {
					const queued =
						agent.queuedMessages > 0
							? theme.fg("muted", ` +${agent.queuedMessages}`)
							: "";
					return `${statusIcon(agent.status, theme)} ${theme.fg("text", sanitizeForDisplay(agent.name, 60))}${queued}`;
				});

				const separator = theme.fg("dim", "  ");
				const pillPrefix = theme.fg("dim", "    ");
				const prefixWidth = visibleWidth(pillPrefix);
				const maxPillWidth = Math.max(1, safeWidth - prefixWidth);
				const lines = [truncateToWidth(summary, safeWidth)];
				let currentLine = pillPrefix;
				let currentWidth = prefixWidth;

				for (const pill of pills) {
					const safePill = truncateToWidth(pill, maxPillWidth);
					const pillWidth = visibleWidth(safePill);
					const needsSeparator = currentWidth > prefixWidth;
					const separatorWidth = needsSeparator ? visibleWidth(separator) : 0;

					if (
						needsSeparator &&
						currentWidth + separatorWidth + pillWidth > safeWidth
					) {
						lines.push(truncateToWidth(currentLine, safeWidth));
						currentLine = pillPrefix + safePill;
						currentWidth = prefixWidth + pillWidth;
						continue;
					}

					if (needsSeparator) {
						currentLine += separator;
						currentWidth += separatorWidth;
					}
					currentLine += safePill;
					currentWidth += pillWidth;
				}

				if (currentWidth > prefixWidth) {
					lines.push(truncateToWidth(currentLine, safeWidth));
				}
				return lines;
			},
			invalidate() {},
		}));
	}

	function createAgentState(args: {
		id: string;
		name: string;
		description: string;
		cwd: string;
		team?: string;
		persistent?: boolean;
		autoClaim?: boolean;
		paused?: boolean;
		model?: string;
	}): AgentState {
		ensureAgentFilesystem(args.id);
		const state: AgentState = {
			id: args.id,
			name: args.name,
			description: args.description,
			cwd: args.cwd,
			team: args.team,
			persistent: !!args.persistent,
			autoClaim: !!args.autoClaim,
			paused: !!args.paused,
			model: args.model,
			status: "running",
			createdAt: Date.now(),
			lastRunStartedAt: Date.now(),
			runCount: 0,
			sessionFile: agentSessionFile(args.id),
			statusFile: agentStatusFile(args.id),
			progressFile: agentProgressFile(args.id),
			recentActivities: [],
			turnCount: 0,
			toolUseCount: 0,
			queuedMessages: 0,
			childPhase: "starting",
		};
		persistSupervisorState(state);
		return state;
	}

	function writeStartingSnapshot(
		agent: AgentState,
		phase: ChildPhase,
		activity?: string,
	) {
		const snapshot = createInitialProgressSnapshot({
			agentId: agent.id,
			name: agent.name,
			description: agent.description,
			cwd: agent.cwd,
			team: agent.team,
			persistent: agent.persistent,
			autoClaim: agent.autoClaim,
			paused: agent.paused,
			currentTaskId: agent.currentTaskId,
			runCount: agent.runCount,
			phase,
		});
		if (activity) {
			snapshot.lastActivity = activity;
			snapshot.recentActivities = [activity];
		}
		writeJsonAtomic(agent.progressFile, snapshot);
		persistSupervisorState(agent);
	}

	function launchAgentRun(
		agent: AgentState,
		opts?: { initialPrompt?: string },
	) {
		if (!tmuxAvailable || !PI_BIN) {
			throw new Error(
				`Cannot launch agent: ${!tmuxAvailable ? "tmux not found" : "pi not found"} in PATH.`,
			);
		}

		ensureAgentFilesystem(agent.id);
		agent.runCount += 1;
		agent.status = "running";
		agent.exitCode = undefined;
		agent.result = undefined;
		agent.lastRunStartedAt = Date.now();
		agent.currentTaskId = undefined;
		agent.lastActivity = opts?.initialPrompt
			? "starting task"
			: agent.persistent
				? "waiting for work"
				: "waiting for queued follow-up";
		agent.recentActivities = agent.lastActivity ? [agent.lastActivity] : [];
		agent.turnCount = 0;
		agent.toolUseCount = 0;
		agent.queuedMessages = countInboxMessages(agent.id);
		agent.childPhase = opts?.initialPrompt ? "starting" : "waiting";
		agent.lastUpdateTime = Date.now();
		agent.cleanupScheduled = false;

		try {
			unlinkSync(agent.statusFile);
		} catch {}
		if (opts?.initialPrompt) {
			writeFileSync(agentPromptFile(agent.id), opts.initialPrompt, {
				mode: 0o600,
			});
		} else {
			try {
				unlinkSync(agentPromptFile(agent.id));
			} catch {}
		}

		writeStartingSnapshot(agent, agent.childPhase, agent.lastActivity);

		const windowName = `${agent.name}-${agent.runCount}-${randomUUID().slice(0, 4)}`;
		const tmuxTarget = tmuxCreateWindow(windowName);
		agent.tmuxWindow = tmuxTarget;

		const quotedCwd = `'${agent.cwd.replace(/'/g, "'\\''")}'`;
		const quotedPi = `'${PI_BIN.replace(/'/g, "'\\''")}'`;
		const quotedStatusFile = `'${agent.statusFile.replace(/'/g, "'\\''")}'`;
		const quotedSessionFile = `'${agent.sessionFile.replace(/'/g, "'\\''")}'`;
		const envParts = [
			`${SUBAGENT_UI_MODE_ENV}='${SUBAGENT_UI_MODE_OVERLAY.replace(/'/g, "'\\''")}'`,
			`${SUBAGENT_ID_ENV}='${agent.id.replace(/'/g, "'\\''")}'`,
			`${SUBAGENT_NAME_ENV}='${agent.name.replace(/'/g, "'\\''")}'`,
			`${SUBAGENT_DESCRIPTION_ENV}='${agent.description.replace(/'/g, "'\\''")}'`,
			`${SUBAGENT_RUN_COUNT_ENV}='${String(agent.runCount)}'`,
			`${SUBAGENT_TEAM_ENV}='${(agent.team ?? "").replace(/'/g, "'\\''")}'`,
			`${SUBAGENT_PERSISTENT_ENV}='${agent.persistent ? "1" : "0"}'`,
			`${SUBAGENT_AUTOCLAIM_ENV}='${agent.autoClaim ? "1" : "0"}'`,
			`${SUBAGENT_PAUSED_ENV}='${agent.paused ? "1" : "0"}'`,
		].join(" ");
		const modelFlag = agent.model
			? ` --model '${agent.model.replace(/'/g, "'\\''")}'`
			: "";
		const promptArg = opts?.initialPrompt
			? ` "$(cat '${agentPromptFile(agent.id).replace(/'/g, "'\\''")}')"`
			: "";
		const cmd =
			`cd ${quotedCwd} && env ${envParts} ${quotedPi}${modelFlag} --session ${quotedSessionFile}${promptArg}; ` +
			`exit_code=$?; { echo "EXIT:${"$"}exit_code"; echo "__AGENT_DONE__"; } > ${quotedStatusFile}`;

		tmuxSendKeys(tmuxTarget, cmd);
		persistSupervisorState(agent);
		startPolling();
		updateWidget();
	}

	function scheduleWindowCleanup(agent: AgentState) {
		if (agent.cleanupScheduled) return;
		agent.cleanupScheduled = true;
		setTimeout(() => {
			const current = agents.get(agent.id);
			if (!current) return;
			current.cleanupScheduled = false;
			if (current.status === "running") return;
			if (current.tmuxWindow && tmuxWindowExists(current.tmuxWindow)) {
				tmuxKillWindow(current.tmuxWindow);
			}
			current.tmuxWindow = undefined;
			try {
				unlinkSync(agentPromptFile(current.id));
			} catch {}
			persistSupervisorState(current);
			updateWidget();
		}, WINDOW_CLEANUP_DELAY_MS);
	}

	function updateAgentProgress(agent: AgentState): boolean {
		let changed = false;
		const previousTaskId = agent.currentTaskId;
		const previousPaused = agent.paused;
		const snapshot = normalizeProgressSnapshot(
			readJsonFile<unknown>(agent.progressFile),
			agent.id,
		);
		if (snapshot) {
			changed = applyProgressSnapshot(agent, snapshot) || changed;
		}
		const queuedMessages = countInboxMessages(agent.id);
		if (agent.queuedMessages !== queuedMessages) {
			agent.queuedMessages = queuedMessages;
			changed = true;
		}
		if (changed) {
			persistSupervisorState(agent);
			if (
				agent.currentTaskId !== previousTaskId &&
				agent.currentTaskId !== undefined
			) {
				if (ctx?.hasUI)
					ctx.ui.notify(
						`${agent.name} claimed task #${agent.currentTaskId}`,
						"info",
					);
			}
			if (agent.paused !== previousPaused) {
				if (ctx?.hasUI)
					ctx.ui.notify(
						`Worker ${agent.name} ${agent.paused ? "paused" : "resumed"}`,
						"info",
					);
			}
		}
		return changed;
	}

	function buildCompletionNotification(agent: AgentState): string {
		const emoji =
			agent.status === "done" ? "✓" : agent.status === "killed" ? "⊘" : "✗";
		const lines = [
			`Agent "${agent.name}" ${agent.status} ${emoji}`,
			"",
			`Task: ${agent.description}`,
		];
		if (agent.team) lines.push(`Team: ${agent.team}`);
		if (agent.currentTaskId)
			lines.push(`Current task: #${agent.currentTaskId}`);
		if (agent.lastActivity) lines.push(`Last activity: ${agent.lastActivity}`);
		if (agent.turnCount > 0 || agent.toolUseCount > 0) {
			lines.push(
				`Runs: ${agent.runCount} · turns ${agent.turnCount} · tools ${agent.toolUseCount}`,
			);
		}
		if (agent.result) {
			lines.push(
				"",
				`Result:\n${truncatePlainText(agent.result, MAX_RESULT_PREVIEW_CHARS)}`,
			);
		}
		return lines.join("\n");
	}

	function finishAgent(
		agent: AgentState,
		status: AgentStatus,
		resultOverride?: string,
	) {
		agent.status = status;
		agent.exitCode = status === "done" ? 0 : agent.exitCode;
		if (resultOverride) agent.result = resultOverride;
		updateAgentProgress(agent);
		if (
			status !== "done" &&
			(agent.persistent || agent.team || agent.autoClaim)
		) {
			void releaseOwnedTasks(agent.cwd, agent.name, {
				team: agent.team,
				agentId: agent.id,
			}).catch(() => undefined);
			agent.currentTaskId = undefined;
		}
		persistSupervisorState(agent);
		scheduleWindowCleanup(agent);
		updateWidget();
		pi.sendMessage({
			customType: "agent-notification",
			content: buildCompletionNotification(agent),
			display: true,
		});
	}

	function startPolling() {
		if (pollTimer) return;

		pollTimer = setInterval(() => {
			let changed = false;

			for (const agent of agents.values()) {
				changed = updateAgentProgress(agent) || changed;

				if (agent.status !== "running") continue;

				if (existsSync(agent.statusFile)) {
					const statusContent = readFileSync(agent.statusFile, "utf-8").trim();
					if (statusContent.includes("__AGENT_DONE__")) {
						const exitMatch = statusContent.match(/EXIT:(\d+)/);
						const rawCode = exitMatch?.[1]
							? Number.parseInt(exitMatch[1], 10)
							: Number.NaN;
						agent.exitCode = Number.isNaN(rawCode) ? 1 : rawCode;
						finishAgent(agent, agent.exitCode === 0 ? "done" : "error");
						changed = true;
					}
					continue;
				}

				if (agent.tmuxWindow && !tmuxWindowExists(agent.tmuxWindow)) {
					agent.result =
						agent.result ??
						"Agent window disappeared before writing a completion marker.";
					finishAgent(agent, "error", agent.result);
					changed = true;
				}
			}

			if (changed) updateWidget();

			const hasRunning = Array.from(agents.values()).some(
				(agent) => agent.status === "running",
			);
			if (!hasRunning && pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
		}, POLL_INTERVAL_MS);
	}

	function killAgent(agent: AgentState): boolean {
		if (agent.status !== "running" || !agent.tmuxWindow) return false;
		tmuxKillWindow(agent.tmuxWindow);
		agent.status = "killed";
		agent.childPhase = "killed";
		agent.lastActivity = "terminated by supervisor";
		if (agent.persistent || agent.team || agent.autoClaim) {
			void releaseOwnedTasks(agent.cwd, agent.name, {
				team: agent.team,
				agentId: agent.id,
			}).catch(() => undefined);
			agent.currentTaskId = undefined;
		}
		persistSupervisorState(agent);
		scheduleWindowCleanup(agent);
		updateWidget();
		if (ctx?.hasUI) ctx.ui.notify(`Worker ${agent.name} stopped`, "info");
		return true;
	}

	function sendWorkerControl(
		agent: AgentState,
		type: "pause" | "resume",
	): boolean {
		if (!agent.persistent) return false;
		if (agent.status !== "running") return false;
		if (type === "pause" && agent.paused) return false;
		if (type === "resume" && !agent.paused) return false;
		agent.paused = type === "pause";
		agent.lastActivity = type === "pause" ? "worker paused" : "worker resumed";
		persistSupervisorState(agent);
		if (agent.status === "running") {
			enqueueInboxMessage(
				agent.id,
				`${CONTROL_PREFIX}${JSON.stringify({ type })}`,
			);
			agent.queuedMessages = countInboxMessages(agent.id);
		}
		updateWidget();
		if (ctx?.hasUI)
			ctx.ui.notify(
				`Worker ${agent.name} ${type === "pause" ? "paused" : "resumed"}`,
				"info",
			);
		return true;
	}

	function renderDetailOverlay(
		agent: AgentState,
		width: number,
		theme: Theme,
	): string[] {
		const innerW = Math.max(20, width - 2);
		const lines: string[] = [];
		const pushWrapped = (label: string, value?: string) => {
			if (!value) return;
			const wrapped = wrapTextWithAnsi(
				`${theme.fg("accent", label)} ${sanitizeForDisplay(value, MAX_OVERLAY_RESULT_CHARS)}`,
				innerW,
			);
			for (const line of wrapped) lines.push(line);
		};

		pushWrapped("Status:", `${agent.status} (${agent.childPhase})`);
		pushWrapped("Task:", agent.description);
		pushWrapped("Session:", agent.sessionFile);
		pushWrapped(
			"Runs:",
			`${agent.runCount} · turns ${agent.turnCount} · tools ${agent.toolUseCount}`,
		);
		pushWrapped(
			"Queue:",
			agent.queuedMessages > 0
				? `${agent.queuedMessages} queued follow-up(s)`
				: "empty",
		);
		if (agent.team) pushWrapped("Team:", agent.team);
		if (agent.persistent)
			pushWrapped(
				"Worker mode:",
				agent.autoClaim ? "persistent auto-claim" : "persistent manual",
			);
		if (agent.currentTaskId)
			pushWrapped("Current task:", `#${agent.currentTaskId}`);
		if (agent.model) pushWrapped("Model:", agent.model);
		if (agent.lastActivity) pushWrapped("Last activity:", agent.lastActivity);

		if (agent.recentActivities.length > 0) {
			lines.push("");
			lines.push(theme.fg("accent", "Recent activity:"));
			for (const activity of agent.recentActivities) {
				for (const line of wrapTextWithAnsi(
					`• ${sanitizeForDisplay(activity, MAX_OVERLAY_RESULT_CHARS)}`,
					innerW,
				))
					lines.push(line);
			}
		}

		if (agent.result) {
			lines.push("");
			lines.push(theme.fg("accent", "Latest result:"));
			for (const line of wrapTextWithAnsi(
				sanitizeForDisplay(
					truncatePlainText(agent.result, MAX_OVERLAY_RESULT_CHARS),
					MAX_OVERLAY_RESULT_CHARS,
				),
				innerW,
			)) {
				lines.push(line);
			}
		}

		return lines;
	}

	async function openAgentDetails(uiCtx: ExtensionContext, agent: AgentState) {
		await uiCtx.ui.custom<void>(
			(_tui, theme, _kb, done) => ({
				render(width: number): string[] {
					const innerW = Math.max(1, width - 2);
					const lines: string[] = [];
					const header = ` ${statusIcon(agent.status, theme)} ${theme.fg("accent", theme.bold(sanitizeForDisplay(agent.name, 60)))} ${theme.fg("dim", agentSummaryLine(agent))}`;
					lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
					lines.push(padRow(header, innerW, theme));
					lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

					for (const line of renderDetailOverlay(agent, width, theme)) {
						lines.push(padRow(line, innerW, theme));
					}

					const termH = process.stdout.rows || 40;
					const targetHeight = Math.floor(termH * 0.75);
					while (lines.length < targetHeight - 2) {
						lines.push(
							theme.fg("border", "│") +
								" ".repeat(innerW) +
								theme.fg("border", "│"),
						);
					}

					lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));
					lines.push(
						padRow(
							` ${theme.fg("dim", "esc close · send_message resumes finished agents")}`,
							innerW,
							theme,
						),
					);
					lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
					return lines;
				},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter))
						done();
				},
				invalidate() {},
			}),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "85%",
					minWidth: 60,
					maxHeight: "80%",
				},
			},
		);
	}

	async function openAgentTerminal(uiCtx: ExtensionContext, agent: AgentState) {
		if (!TMUX_BIN || !agent.tmuxWindow || !tmuxWindowExists(agent.tmuxWindow)) {
			await openAgentDetails(uiCtx, agent);
			return;
		}

		await uiCtx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				let paneLines: string[] = [];
				let refreshTimer: ReturnType<typeof setInterval> | null = null;

				function capturePane() {
					if (!agent.tmuxWindow || !TMUX_BIN) return;
					try {
						const escaped = agent.tmuxWindow.replace(/'/g, "'\\''");
						const output = execSync(
							`"${TMUX_BIN}" capture-pane -p -e -t '${escaped}'`,
							{
								encoding: "utf-8",
								timeout: 2000,
							},
						);
						// Terminal capture is full of ANSI/control bytes — sanitize each
						// line BEFORE it reaches the renderer's width math (gotchas §16).
						paneLines = output.split("\n").map(sanitizePaneLine);
						tui.requestRender();
					} catch (error) {
						logDiagnostic("capture-pane failed", error);
						paneLines = [theme.fg("dim", "pane closed")];
					}
				}

				function cleanup() {
					if (refreshTimer) {
						clearInterval(refreshTimer);
						refreshTimer = null;
					}
				}

				capturePane();
				refreshTimer = setInterval(capturePane, 500);

				return {
					render(width: number): string[] {
						const innerW = Math.max(1, width - 2);
						const termH = process.stdout.rows || 40;
						const maxH = Math.floor(termH * 0.9);
						const lines: string[] = [];
						const headerText = ` ${statusIcon(agent.status, theme)} ${theme.fg("accent", theme.bold(sanitizeForDisplay(agent.name, 60)))} ${theme.fg("dim", agentSummaryLine(agent))}`;
						lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
						lines.push(padRow(headerText, innerW, theme));
						lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

						const contentH = Math.max(0, maxH - 5);
						const visible = paneLines.slice(-contentH);
						for (const line of visible) {
							const vis = visibleWidth(line);
							if (vis > innerW) {
								lines.push(
									theme.fg("border", "│") +
										truncateToWidth(line, innerW) +
										theme.fg("border", "│"),
								);
							} else {
								lines.push(
									theme.fg("border", "│") +
										line +
										" ".repeat(Math.max(0, innerW - vis)) +
										theme.fg("border", "│"),
								);
							}
						}
						for (let i = visible.length; i < contentH; i++) {
							lines.push(
								theme.fg("border", "│") +
									" ".repeat(innerW) +
									theme.fg("border", "│"),
							);
						}

						lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));
						lines.push(
							padRow(
								` ${theme.fg("dim", "esc close · live monitor · use send_message to steer")}`,
								innerW,
								theme,
							),
						);
						lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
						return lines;
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape)) {
							cleanup();
							done();
						}
					},
					invalidate() {},
					dispose() {
						cleanup();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "95%", maxHeight: "90%" },
			},
		);
	}

	function padRow(content: string, innerW: number, theme: Theme): string {
		const vis = visibleWidth(content);
		return (
			theme.fg("border", "│") +
			content +
			" ".repeat(Math.max(0, innerW - vis)) +
			theme.fg("border", "│")
		);
	}

	async function spawnAgentWithConfig(args: {
		rawName: string;
		description: string;
		prompt: string;
		modelInput?: string;
		team?: string;
		persistent?: boolean;
		autoClaim?: boolean;
		cwd: string;
		modelRegistry: ExtensionContext["modelRegistry"];
		signal?: AbortSignal;
	}): Promise<SpawnAgentResult> {
		const {
			rawName,
			description,
			prompt,
			modelInput,
			team,
			persistent,
			autoClaim,
			cwd,
			modelRegistry,
			signal,
		} = args;

		if (!tmuxAvailable || !PI_BIN) {
			return {
				content: [
					{
						type: "text",
						text: `Cannot spawn agent: ${!tmuxAvailable ? "tmux not found" : "pi not found"} in PATH.`,
					},
				],
				details: { error: true },
			};
		}

		const name = sanitizeName(rawName);
		if (Array.from(agents.values()).some((agent) => agent.name === name)) {
			return {
				content: [
					{
						type: "text",
						text: `Agent name "${name}" is already in use. Reuse it with send_message or choose another name.`,
					},
				],
				details: { error: true },
			};
		}

		let model: string | undefined;
		if (modelInput) {
			const available = modelRegistry.getAvailable();
			const query = modelInput.toLowerCase();
			let match = available.find((m) => m.id.toLowerCase() === query);
			if (!match) {
				const fuzzy = available.filter((m) =>
					m.id.toLowerCase().includes(query),
				);
				if (fuzzy.length === 1) match = fuzzy[0];
				else if (fuzzy.length > 1) {
					return {
						content: [
							{
								type: "text",
								text: `Ambiguous model "${modelInput}". Matches: ${fuzzy.map((m) => m.id).join(", ")}`,
							},
						],
						details: { error: true },
					};
				}
			}
			if (!match) {
				const byName = available.filter(
					(m) =>
						m.name.toLowerCase().includes(query) ||
						m.provider.toLowerCase().includes(query),
				);
				if (byName.length === 1) match = byName[0];
			}
			if (!match) {
				return {
					content: [
						{
							type: "text",
							text: `Model "${modelInput}" not found. Available: ${available.map((m) => m.id).join(", ")}`,
						},
					],
					details: { error: true },
				};
			}
			model = match.id;
		}

		if (signal?.aborted) {
			return {
				content: [{ type: "text", text: "Cancelled." }],
				details: { error: true },
			};
		}

		const normalizedTeam = normalizeTeamInput(team);
		const effectivePersistent = Boolean(persistent || autoClaim);
		const effectiveAutoClaim = Boolean(autoClaim);

		const id = `${name}-${randomUUID().slice(0, 8)}`;
		const agent = createAgentState({
			id,
			name,
			description,
			cwd,
			team: normalizedTeam,
			persistent: effectivePersistent,
			autoClaim: effectiveAutoClaim,
			model,
		});
		agents.set(id, agent);

		try {
			launchAgentRun(agent, { initialPrompt: prompt });
		} catch (error) {
			agents.delete(id);
			deleteAgentFilesystem(id);
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

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					const current = agents.get(id);
					if (current) killAgent(current);
				},
				{ once: true },
			);
		}

		return {
			content: [
				{
					type: "text",
					text: `Spawned agent "${name}" (id: ${id}). It is being monitored in tmux and can be resumed later with send_message.${normalizedTeam ? ` Team: ${normalizedTeam}.` : ""}${effectivePersistent ? ` Persistent worker mode is enabled${effectiveAutoClaim ? " with auto-claim." : "."}` : ""}`,
				},
			],
			details: {
				agentId: id,
				name,
				tmuxWindow: agent.tmuxWindow,
				team: normalizedTeam,
				persistent: effectivePersistent,
				autoClaim: effectiveAutoClaim,
			},
		};
	}

	// ── Tools ───────────────────────────────────────────────────────

	const spawnAgentTool = defineTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a subagent pi instance in a tmux window to handle a task autonomously. " +
			"The agent runs with its own session transcript, live monitor, hidden editor, and resumable queued follow-ups. " +
			"Optional team/persistent worker mode lets idle agents auto-claim shared tasks from the project task board. " +
			"Use for tasks that don't need your full context: research, implementation, testing, etc.",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Short name for the agent (e.g. 'research', 'tests', 'impl-auth')",
			}),
			description: Type.String({
				description:
					"Brief description of what this agent will do (3-10 words)",
			}),
			prompt: Type.String({
				description:
					"Complete task instructions for the agent. Be thorough — the agent has no context from this conversation.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"Model override for this agent (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5'). Omit to inherit the supervisor's model.",
				}),
			),
			team: Type.Optional(
				Type.String({
					description:
						"Optional team namespace for shared tasks and persistent workers.",
				}),
			),
			persistent: Type.Optional(
				Type.Boolean({
					description:
						"Keep the agent alive while idle so it can receive more work.",
				}),
			),
			autoClaim: Type.Optional(
				Type.Boolean({
					description:
						"When persistent, automatically claim the next shared unowned task in the same team namespace.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, toolCtx) {
			const {
				name: rawName,
				description,
				prompt,
				model: modelInput,
				team,
				persistent,
				autoClaim,
			} = params;

			return spawnAgentWithConfig({
				rawName,
				description,
				prompt,
				modelInput,
				team,
				persistent,
				autoClaim,
				cwd: toolCtx.cwd,
				modelRegistry: toolCtx.modelRegistry,
				signal,
			});
		},

		renderCall(args, theme, context) {
			const text =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			let s = theme.fg("toolTitle", theme.bold("spawn "));
			s += theme.fg("accent", sanitizeForDisplay(args.name || "", 60));
			if (args.model)
				s += theme.fg("muted", ` [${sanitizeForDisplay(args.model, 60)}]`);
			if (args.team)
				s += theme.fg("muted", ` [team:${sanitizeForDisplay(args.team, 60)}]`);
			if (args.persistent)
				s += theme.fg("muted", args.autoClaim ? " [worker:auto]" : " [worker]");
			if (args.description)
				s += theme.fg("dim", ` — ${sanitizeForDisplay(args.description, 120)}`);
			text.setText(s);
			return text;
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Spawning…"), 0, 0);
			const details = result.details as
				| { error?: boolean; name?: string }
				| undefined;
			if (details?.error) {
				const first = result.content[0];
				const msg = first?.type === "text" ? first.text : "error";
				return new Text(theme.fg("error", sanitizeForDisplay(msg, 200)), 0, 0);
			}
			return new Text(
				`${theme.fg("success", "●")} ${theme.fg("text", sanitizeForDisplay(details?.name || "agent", 60))}${theme.fg("dim", " launched")}`,
				0,
				0,
			);
		},
	});
	pi.registerTool(spawnAgentTool);

	const sendMessageTool = defineTool({
		name: "send_message",
		label: "Send Message",
		description:
			"Send a follow-up message to a subagent through its queued inbox. " +
			"If the agent already stopped, it is resumed from its saved session transcript and the message is delivered there.",
		parameters: Type.Object({
			to: Type.String({ description: "Agent name or ID to send to" }),
			message: Type.String({ description: "The follow-up message to queue" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _toolCtx) {
			const { to, message } = params;
			const agent = getAgent(to);
			if (!agent) {
				const names =
					Array.from(agents.values())
						.map((item) => item.name)
						.join(", ") || "(none)";
				return {
					content: [
						{
							type: "text",
							text: `Agent "${to}" not found. Known agents: ${names}`,
						},
					],
					details: { error: true },
				};
			}

			if (agent.status === "running") {
				enqueueInboxMessage(agent.id, message);
				agent.queuedMessages = countInboxMessages(agent.id);
				updateWidget();
				return {
					content: [
						{
							type: "text",
							text: `Queued follow-up for agent "${agent.name}". It will be delivered at the next safe turn boundary.`,
						},
					],
					details: { agentName: agent.name },
				};
			}

			try {
				launchAgentRun(agent);
				enqueueInboxMessage(agent.id, message);
				agent.queuedMessages = countInboxMessages(agent.id);
				updateWidget();
				return {
					content: [
						{
							type: "text",
							text: `Agent "${agent.name}" was resumed from its saved session and the follow-up was queued.`,
						},
					],
					details: { agentName: agent.name, resumed: true },
				};
			} catch (error) {
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
			let s = theme.fg("toolTitle", theme.bold("→ "));
			s += theme.fg("accent", sanitizeForDisplay(args.to || "", 60));
			if (args.message) {
				const msg =
					args.message.length > 60
						? `${args.message.slice(0, 57)}…`
						: args.message;
				s += theme.fg("dim", ` "${sanitizeForDisplay(msg, 80)}"`);
			}
			text.setText(s);
			return text;
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
			const details = result.details as
				| { error?: boolean; resumed?: boolean }
				| undefined;
			if (details?.error) return new Text(theme.fg("error", "failed"), 0, 0);
			if (details?.resumed)
				return new Text(theme.fg("success", "resumed"), 0, 0);
			return new Text(theme.fg("success", "queued"), 0, 0);
		},
	});
	pi.registerTool(sendMessageTool);

	const workerControlTool = defineTool({
		name: "worker_control",
		label: "Worker Control",
		description:
			"Pause or resume a persistent worker so it stops or restarts auto-claiming shared tasks.",
		parameters: Type.Object({
			to: Type.String({ description: "Persistent worker name or ID" }),
			action: StringEnum(["pause", "resume"] as const, {
				description: "Pause or resume the worker",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _toolCtx) {
			const { to, action } = params;
			const agent = getAgent(to);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Worker "${to}" not found.` }],
					details: { error: true },
				};
			}
			if (!agent.persistent) {
				return {
					content: [
						{
							type: "text",
							text: `Agent "${agent.name}" is not a persistent worker.`,
						},
					],
					details: { error: true },
				};
			}
			if (!sendWorkerControl(agent, action)) {
				return {
					content: [
						{
							type: "text",
							text: `Worker "${agent.name}" is already ${action === "pause" ? "paused" : "active"}.`,
						},
					],
					details: { error: true },
				};
			}
			return {
				content: [{ type: "text", text: `Worker "${agent.name}" ${action}d.` }],
				details: { worker: agent.name, action },
			};
		},
		renderCall(args, theme, context) {
			const text =
				context.lastComponent instanceof Text
					? context.lastComponent
					: new Text("", 0, 0);
			text.setText(
				theme.fg("toolTitle", theme.bold(`${args.action || "control"} `)) +
					theme.fg("accent", sanitizeForDisplay(args.to || "", 60)),
			);
			return text;
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
			const details = result.details as
				| { error?: boolean; action?: string }
				| undefined;
			if (details?.error) return new Text(theme.fg("error", "failed"), 0, 0);
			return new Text(
				theme.fg("success", details?.action === "pause" ? "paused" : "resumed"),
				0,
				0,
			);
		},
	});
	pi.registerTool(workerControlTool);

	const teamCreateTool = defineTool({
		name: "team_create",
		label: "Team Create",
		description:
			"Create or update a named team namespace for shared task coordination and persistent workers.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name / namespace" }),
			description: Type.Optional(
				Type.String({
					description: "Optional description of the team purpose",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _toolCtx) {
			if (!ctx)
				return {
					content: [
						{ type: "text", text: "Subagents extension is not ready yet." },
					],
					details: { error: true },
				};
			try {
				const teamName = normalizeTeamInput(params.team);
				if (!teamName) {
					return {
						content: [{ type: "text", text: "Error: team name is required." }],
						details: { error: true },
					};
				}
				const result = await createTeam(ctx.cwd, teamName, params.description);
				const members = getAgentsForTeam(teamName).map((agent) => agent.name);
				if (ctx.hasUI)
					ctx.ui.notify(
						`${result.created ? "Created" : "Updated"} team ${teamName}`,
						"info",
					);
				return {
					content: [
						{
							type: "text",
							text: `${result.created ? "Created" : "Updated"} team "${teamName}".${members.length > 0 ? ` Current workers: ${members.join(", ")}.` : ""}`,
						},
					],
					details: { team: teamName, created: result.created },
				};
			} catch (error) {
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
	});
	pi.registerTool(teamCreateTool);

	const teamDeleteTool = defineTool({
		name: "team_delete",
		label: "Team Delete",
		description:
			"Delete a team namespace, stop its workers, and optionally delete its team-scoped tasks.",
		parameters: Type.Object({
			team: Type.String({ description: "Team name / namespace" }),
			deleteTasks: Type.Optional(
				Type.Boolean({
					description:
						"Delete tasks in this team instead of preserving them as unowned shared tasks.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _toolCtx) {
			if (!ctx)
				return {
					content: [
						{ type: "text", text: "Subagents extension is not ready yet." },
					],
					details: { error: true },
				};
			try {
				const teamName = normalizeTeamInput(params.team);
				if (!teamName) {
					return {
						content: [{ type: "text", text: "Error: team name is required." }],
						details: { error: true },
					};
				}
				const deleted = await deleteTeam(ctx.cwd, teamName);
				const teamAgents = getAgentsForTeam(teamName);
				const hasImplicitTeamState =
					teamAgents.length > 0 ||
					loadBoard(ctx.cwd).tasks.some((task) => task.team === teamName);
				if (!deleted.deleted && !hasImplicitTeamState) {
					return {
						content: [{ type: "text", text: `Team "${teamName}" not found.` }],
						details: { error: true },
					};
				}
				for (const agent of teamAgents) removeAgent(agent);
				const taskResult = await reassignOrDeleteTeamTasks(ctx.cwd, teamName, {
					deleteTasks: Boolean(params.deleteTasks),
				});
				updateWidget();
				if (ctx.hasUI) ctx.ui.notify(`Deleted team ${teamName}`, "info");
				return {
					content: [
						{
							type: "text",
							text: `Deleted team "${teamName}".${deleted.deleted ? "" : " (implicit namespace)"} Removed ${teamAgents.length} worker(s). ${taskResult.deleted > 0 ? `Deleted ${taskResult.deleted} task(s).` : `Detached ${taskResult.detached} task(s) from the team.`}`,
						},
					],
					details: {
						team: teamName,
						removedAgents: teamAgents.length,
						deletedTasks: taskResult.deleted,
						detachedTasks: taskResult.detached,
					},
				};
			} catch (error) {
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
	});
	pi.registerTool(teamDeleteTool);

	pi.events.on("subagents:spawn-request", (payload: unknown) => {
		if (!ctx || !isSpawnRequestPayload(payload)) return;
		void spawnAgentWithConfig({
			rawName: typeof payload.name === "string" ? payload.name : "agent",
			description:
				typeof payload.description === "string"
					? payload.description
					: "subagent task",
			prompt: typeof payload.prompt === "string" ? payload.prompt : "",
			modelInput: typeof payload.model === "string" ? payload.model : undefined,
			team: typeof payload.team === "string" ? payload.team : undefined,
			persistent: Boolean(payload.persistent),
			autoClaim: Boolean(payload.autoClaim),
			cwd:
				typeof payload.cwd === "string" && payload.cwd.trim()
					? payload.cwd
					: ctx.cwd,
			modelRegistry: ctx.modelRegistry,
		})
			.then((result) => payload.resolve(result))
			.catch((error) => {
				logDiagnostic("spawn-request handler failed", error);
				payload.resolve({
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: { error: true },
				});
			});
	});

	// ── Commands ─────────────────────────────────────────────────────

	pi.registerCommand("agents", {
		description: "Manage subagents: list, teams, kill, kill-all",
		handler: async (args, cmdCtx) => {
			if (!cmdCtx.hasUI) return;
			const cmd = args?.trim() || "list";

			if (cmd === "list") {
				const list = Array.from(agents.values());
				if (list.length === 0) {
					cmdCtx.ui.notify("No agents", "info");
					return;
				}
				const lines = list.map((agent) => {
					const elapsed = Math.floor(
						(Date.now() - agent.lastRunStartedAt) / 1000,
					);
					const time =
						elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;
					const team = agent.team ? ` team:${agent.team}` : "";
					const mode = agent.persistent
						? agent.autoClaim
							? " worker:auto"
							: " worker"
						: "";
					const currentTask = agent.currentTaskId
						? ` task:#${agent.currentTaskId}`
						: "";
					const queue =
						agent.queuedMessages > 0 ? ` queued:${agent.queuedMessages}` : "";
					const icon =
						agent.status === "running"
							? "◌"
							: agent.status === "done"
								? "✓"
								: agent.status === "killed"
									? "⊘"
									: "✗";
					return sanitizeForDisplay(
						`${icon} ${agent.name} (${agent.status}, ${time})${team}${mode}${currentTask}${queue} — ${agent.lastActivity ?? agent.childPhase}`,
						400,
					);
				});
				cmdCtx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (cmd === "teams") {
				if (!ctx) return;
				let summaries: ReturnType<typeof getTeamSummaries>;
				try {
					summaries = getTeamSummaries(ctx.cwd);
				} catch (error) {
					cmdCtx.ui.notify(
						sanitizeForDisplay(
							error instanceof Error ? error.message : String(error),
							200,
						),
						"error",
					);
					return;
				}
				if (summaries.length === 0) {
					cmdCtx.ui.notify("No teams", "info");
					return;
				}
				const lines: string[] = [];
				for (const summary of summaries) {
					lines.push(
						`• ${summary.name}${summary.description ? ` — ${summary.description}` : ""}`,
					);
					lines.push(
						`  workers: ${summary.workers.length} total, ${summary.busyWorkers} busy · tasks: ${summary.openTasks} open, ${summary.doneTasks} done`,
					);
					if (summary.workers.length === 0) lines.push("  no workers");
					else {
						summary.workers.forEach((agent) => {
							lines.push(
								`  - ${agent.name} (${agent.status})${agent.currentTaskId ? ` task #${agent.currentTaskId}` : ""}${agent.persistent ? (agent.autoClaim ? " worker:auto" : " worker") : ""}`,
							);
						});
					}
				}
				cmdCtx.ui.notify(
					lines.map((l) => sanitizeForDisplay(l, 400)).join("\n"),
					"info",
				);
				return;
			}

			if (cmd === "kill-all") {
				let killed = 0;
				for (const agent of agents.values()) {
					if (killAgent(agent)) killed++;
				}
				cmdCtx.ui.notify(
					killed > 0
						? `Killed ${killed} running agent(s)`
						: "No running agents to kill",
					"info",
				);
				return;
			}

			if (cmd.startsWith("pause ") || cmd.startsWith("resume ")) {
				const action = cmd.startsWith("pause ") ? "pause" : "resume";
				const target = cmd.slice(action.length + 1).trim();
				const agent = getAgent(target);
				if (!agent) {
					cmdCtx.ui.notify(`Agent "${target}" not found`, "error");
					return;
				}
				if (!agent.persistent) {
					cmdCtx.ui.notify(
						`Agent "${agent.name}" is not a persistent worker`,
						"error",
					);
					return;
				}
				if (!sendWorkerControl(agent, action)) {
					cmdCtx.ui.notify(
						`Worker "${agent.name}" is already ${action === "pause" ? "paused" : "active"}`,
						"info",
					);
					return;
				}
				cmdCtx.ui.notify(`Worker "${agent.name}" ${action}d`, "info");
				return;
			}

			if (cmd.startsWith("kill ")) {
				const target = cmd.slice(5).trim();
				const agent = getAgent(target);
				if (!agent) {
					cmdCtx.ui.notify(`Agent "${target}" not found`, "error");
					return;
				}
				if (!killAgent(agent)) {
					cmdCtx.ui.notify(`Agent "${agent.name}" is not running`, "info");
					return;
				}
				cmdCtx.ui.notify(`Agent "${agent.name}" killed`, "info");
				return;
			}

			cmdCtx.ui.notify(
				"Usage: /agents [list|teams|pause <name>|resume <name>|kill <name>|kill-all]",
				"info",
			);
		},
	});

	// ── Team overview overlay ───────────────────────────────────────

	pi.registerCommand("teams", {
		description: "Open team overview overlay",
		handler: async (_args, cmdCtx) => {
			if (cmdCtx.mode !== "tui") return;
			if (!ctx) return;
			let initialSummaries: ReturnType<typeof getTeamSummaries>;
			try {
				initialSummaries = getTeamSummaries(cmdCtx.cwd);
			} catch (error) {
				cmdCtx.ui.notify(
					sanitizeForDisplay(
						error instanceof Error ? error.message : String(error),
						200,
					),
					"error",
				);
				return;
			}
			if (initialSummaries.length === 0) {
				cmdCtx.ui.notify("No teams", "info");
				return;
			}

			const action = await cmdCtx.ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					let teamIdx = 0;
					let workerIdx = 0;
					let refreshTimer: ReturnType<typeof setInterval> | null = setInterval(
						() => tui.requestRender(),
						REFRESH_INTERVAL_MS,
					);
					const cleanup = () => {
						if (refreshTimer) {
							clearInterval(refreshTimer);
							refreshTimer = null;
						}
					};
					const getState = () => {
						let summaries: ReturnType<typeof getTeamSummaries>;
						try {
							summaries = getTeamSummaries(cmdCtx.cwd);
						} catch (error) {
							logDiagnostic("getTeamSummaries failed in overlay", error);
							summaries = [];
						}
						if (teamIdx >= summaries.length)
							teamIdx = Math.max(0, summaries.length - 1);
						const selectedTeam = summaries[teamIdx];
						const workers = selectedTeam?.workers ?? [];
						if (workerIdx >= workers.length)
							workerIdx = Math.max(0, workers.length - 1);
						const selectedWorker = workers[workerIdx];
						return { summaries, selectedTeam, workers, selectedWorker };
					};
					return {
						render(width: number): string[] {
							const { summaries, selectedTeam, workers, selectedWorker } =
								getState();
							const innerW = Math.max(70, width - 2);
							const lines: string[] = [];
							const pad = (s: string) =>
								s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
							const row = (content: string) =>
								theme.fg("border", "│") +
								pad(truncateToWidth(` ${content}`, innerW)) +
								theme.fg("border", "│");
							lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
							lines.push(row(theme.fg("accent", theme.bold("Teams"))));
							for (let i = 0; i < summaries.length; i++) {
								const summary = summaries[i];
								if (!summary) continue;
								const pointer = i === teamIdx ? theme.fg("accent", "❯ ") : "  ";
								lines.push(
									row(
										`${pointer}${theme.fg(i === teamIdx ? "accent" : "text", sanitizeForDisplay(summary.name, 80))}${summary.description ? theme.fg("dim", ` — ${sanitizeForDisplay(summary.description, 120)}`) : ""}`,
									),
								);
							}
							lines.push(row(""));
							if (selectedTeam) {
								lines.push(
									row(
										theme.fg(
											"muted",
											`workers ${selectedTeam.workers.length} · busy ${selectedTeam.busyWorkers} · open tasks ${selectedTeam.openTasks} · done tasks ${selectedTeam.doneTasks}`,
										),
									),
								);
								if (workers.length === 0) {
									lines.push(row(theme.fg("dim", " no workers in this team")));
								} else {
									for (let i = 0; i < workers.length; i++) {
										const worker = workers[i];
										if (!worker) continue;
										const selected = selectedWorker?.id === worker.id;
										const pointer = selected ? theme.fg("accent", "› ") : "  ";
										const paused = worker.paused ? " · paused" : "";
										lines.push(
											row(
												`${pointer}${statusIcon(worker.status, theme)} ${sanitizeForDisplay(worker.name, 80)}${worker.currentTaskId ? ` · task #${worker.currentTaskId}` : ""}${worker.persistent ? (worker.autoClaim ? " · worker:auto" : " · worker") : ""}${paused}`,
											),
										);
									}
								}
							}
							const detail = selectedWorker
								? `enter inspect · p ${selectedWorker.paused ? "resume" : "pause"} worker · k kill worker · esc close`
								: `enter inspect · esc close`;
							lines.push(row(""));
							lines.push(
								row(theme.fg("dim", `↑↓ teams · ←→ workers · ${detail}`)),
							);
							lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
							return lines;
						},
						handleInput(data: string) {
							const { summaries, workers, selectedWorker } = getState();
							if (matchesKey(data, Key.escape)) {
								cleanup();
								done(null);
								return;
							}
							if (matchesKey(data, Key.up)) {
								teamIdx = Math.max(0, teamIdx - 1);
								workerIdx = 0;
							} else if (matchesKey(data, Key.down)) {
								teamIdx = Math.min(summaries.length - 1, teamIdx + 1);
								workerIdx = 0;
							} else if (matchesKey(data, Key.left)) {
								workerIdx = Math.max(0, workerIdx - 1);
							} else if (matchesKey(data, Key.right)) {
								workerIdx = Math.min(workers.length - 1, workerIdx + 1);
							} else if (matchesKey(data, Key.enter) && selectedWorker) {
								cleanup();
								done(`inspect:${selectedWorker.id}`);
								return;
							} else if (data === "p" && selectedWorker) {
								cleanup();
								done(`pause-toggle:${selectedWorker.id}`);
								return;
							} else if (data === "k" && selectedWorker) {
								cleanup();
								done(`kill:${selectedWorker.id}`);
								return;
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
					overlayOptions: {
						anchor: "center",
						width: "80%",
						minWidth: 70,
						maxHeight: "80%",
					},
				},
			);

			if (!action) return;
			const [kind, id] = action.split(":");
			const worker = id ? agents.get(id) : undefined;
			if (!worker) return;
			if (kind === "inspect") {
				if (
					worker.status === "running" &&
					worker.tmuxWindow &&
					tmuxWindowExists(worker.tmuxWindow)
				)
					await openAgentTerminal(cmdCtx, worker);
				else await openAgentDetails(cmdCtx, worker);
			} else if (kind === "pause-toggle") {
				sendWorkerControl(worker, worker.paused ? "resume" : "pause");
			} else if (kind === "kill") {
				killAgent(worker);
			}
		},
	});

	// ── Keyboard shortcut ───────────────────────────────────────────

	pi.registerShortcut("alt+a", {
		description: "Open subagent monitor",
		handler: async (shortcutCtx) => {
			if (shortcutCtx.mode !== "tui") return;
			const items = Array.from(agents.values());
			if (items.length === 0) {
				shortcutCtx.ui.notify("No agents", "info");
				return;
			}

			const selectedAction = await shortcutCtx.ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					let focusIdx = 0;
					return {
						render(width: number): string[] {
							const safeWidth = Math.max(1, width);
							const currentItems = Array.from(agents.values());
							const lines: string[] = [];
							lines.push(theme.fg("accent", theme.bold("  Agents")));
							lines.push(
								theme.fg(
									"dim",
									`  ${"─".repeat(Math.max(1, Math.min(52, safeWidth - 4)))}`,
								),
							);
							if (currentItems.length === 0) {
								lines.push(theme.fg("dim", "  No agents"));
							} else {
								if (focusIdx >= currentItems.length)
									focusIdx = currentItems.length - 1;
								for (let i = 0; i < currentItems.length; i++) {
									const agent = currentItems[i];
									if (!agent) continue;
									const focused = i === focusIdx;
									const pointer = focused ? theme.fg("accent", "❯ ") : "  ";
									const safeName = sanitizeForDisplay(agent.name, 60);
									const name = focused
										? theme.fg("accent", theme.bold(safeName))
										: safeName;
									const worker = agent.persistent
										? theme.fg(
												"muted",
												agent.autoClaim ? " [worker:auto]" : " [worker]",
											)
										: "";
									const team = agent.team
										? theme.fg(
												"muted",
												` [team:${sanitizeForDisplay(agent.team, 60)}]`,
											)
										: "";
									const summary = theme.fg("dim", agentSummaryLine(agent));
									lines.push(
										truncateToWidth(
											`${pointer}${statusIcon(agent.status, theme)} ${name}${worker}${team} ${summary}`,
											safeWidth,
										),
									);
								}
							}
							const termH = process.stdout.rows || 40;
							const targetH = Math.floor(termH * 0.6);
							while (lines.length < targetH - 2) lines.push("");
							lines.push("");
							lines.push(
								theme.fg(
									"dim",
									"  ↑↓ navigate · enter inspect · p pause/resume worker · esc close",
								),
							);
							return lines;
						},
						handleInput(data: string) {
							const currentItems = Array.from(agents.values());
							if (matchesKey(data, Key.up)) {
								focusIdx = Math.max(0, focusIdx - 1);
								tui.requestRender();
							} else if (matchesKey(data, Key.down)) {
								focusIdx = Math.min(currentItems.length - 1, focusIdx + 1);
								tui.requestRender();
							} else if (matchesKey(data, Key.enter)) {
								const selected = currentItems[focusIdx];
								done(selected ? `inspect:${selected.id}` : null);
							} else if (data === "p") {
								const selected = currentItems[focusIdx];
								if (selected?.persistent) done(`pause-toggle:${selected.id}`);
							} else if (matchesKey(data, Key.escape)) {
								done(null);
							}
						},
						invalidate() {},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "60%",
						minWidth: 52,
						maxHeight: "60%",
					},
				},
			);

			if (!selectedAction) return;
			const [kind, id] = selectedAction.split(":");
			const agent = id ? agents.get(id) : undefined;
			if (!agent) return;
			if (kind === "pause-toggle") {
				sendWorkerControl(agent, agent.paused ? "resume" : "pause");
				return;
			}
			if (
				agent.status === "running" &&
				agent.tmuxWindow &&
				tmuxWindowExists(agent.tmuxWindow)
			) {
				await openAgentTerminal(shortcutCtx, agent);
				return;
			}
			await openAgentDetails(shortcutCtx, agent);
		},
	});

	// ── Lifecycle ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, startCtx) => {
		ctx = startCtx;
		agents.clear();
		for (const state of listRestorableAgentsForCwd(startCtx.cwd)) {
			const restored = restoreAgentState(state);
			agents.set(restored.id, restored);
		}
		if (Array.from(agents.values()).some((agent) => agent.status === "running"))
			startPolling();
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		ctx = null;
	});
}
