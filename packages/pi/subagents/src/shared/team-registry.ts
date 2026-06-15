import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	getLegacyProjectKey,
	getProjectKey,
	sanitizePathComponent,
} from "./task-board";

export interface TeamRecord {
	name: string;
	description?: string;
	createdAt: number;
	updatedAt: number;
}

interface TeamRegistryFile {
	version: 1;
	projectKey: string;
	projectRoot: string;
	teams: TeamRecord[];
	updatedAt: number;
}

const TODOS_DIR = join(homedir(), ".pi", "todos");
const LOCK_TIMEOUT_MS = 4000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRegistryPath(cwd: string): string {
	mkdirSync(TODOS_DIR, { recursive: true, mode: 0o700 });
	const preferred = join(TODOS_DIR, `${getProjectKey(cwd)}.teams.json`);
	if (existsSync(preferred)) return preferred;
	const legacy = join(TODOS_DIR, `${getLegacyProjectKey(cwd)}.teams.json`);
	if (existsSync(legacy)) return legacy;
	return preferred;
}

function getPreferredRegistryPath(cwd: string): string {
	return join(TODOS_DIR, `${getProjectKey(cwd)}.teams.json`);
}

function getLockPath(cwd: string): string {
	return `${getRegistryPath(cwd)}.lock`;
}

function defaultRegistry(cwd: string): TeamRegistryFile {
	return {
		version: 1,
		projectKey: getProjectKey(cwd),
		projectRoot: cwd,
		teams: [],
		updatedAt: Date.now(),
	};
}

function normalizeTeamName(name: string): string {
	return sanitizePathComponent(name).toLowerCase();
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

function loadRegistry(cwd: string): TeamRegistryFile {
	const path = getRegistryPath(cwd);
	if (!existsSync(path)) return defaultRegistry(cwd);
	try {
		const parsed = JSON.parse(
			readFileSync(path, "utf-8"),
		) as Partial<TeamRegistryFile>;
		return {
			version: 1,
			projectKey:
				typeof parsed.projectKey === "string"
					? parsed.projectKey
					: getProjectKey(cwd),
			projectRoot:
				typeof parsed.projectRoot === "string" ? parsed.projectRoot : cwd,
			teams: Array.isArray(parsed.teams)
				? parsed.teams
						.map((team) => ({
							name:
								typeof team?.name === "string"
									? normalizeTeamName(team.name)
									: "",
							description:
								typeof team?.description === "string" && team.description.trim()
									? team.description
									: undefined,
							createdAt:
								typeof team?.createdAt === "number"
									? team.createdAt
									: Date.now(),
							updatedAt:
								typeof team?.updatedAt === "number"
									? team.updatedAt
									: Date.now(),
						}))
						.filter((team) => team.name.length > 0)
				: [],
			updatedAt:
				typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
		};
	} catch {
		const quarantined = quarantineUnreadableFile(path);
		throw new Error(
			quarantined
				? `Team registry is unreadable. Preserved at ${quarantined}`
				: `Team registry is unreadable: ${path}`,
		);
	}
}

function saveRegistry(cwd: string, registry: TeamRegistryFile): void {
	registry.updatedAt = Date.now();
	const preferred = getPreferredRegistryPath(cwd);
	const current = getRegistryPath(cwd);
	if (current !== preferred && existsSync(current) && !existsSync(preferred)) {
		try {
			renameSync(current, preferred);
		} catch {}
	}
	registry.projectKey = getProjectKey(cwd);
	writeJsonAtomic(preferred, registry);
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
				throw new Error(`Timed out acquiring team registry lock for ${cwd}`);
			}
			await sleep(LOCK_RETRY_MS);
		}
	}
}

async function withRegistryLock<T>(
	cwd: string,
	fn: (registry: TeamRegistryFile) => T | Promise<T>,
): Promise<T> {
	const release = await acquireLock(cwd);
	try {
		const registry = loadRegistry(cwd);
		const result = await fn(registry);
		saveRegistry(cwd, registry);
		return result;
	} finally {
		release();
	}
}

export function listTeams(cwd: string): TeamRecord[] {
	return [...loadRegistry(cwd).teams].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

export async function createTeam(
	cwd: string,
	name: string,
	description?: string,
): Promise<{ team: TeamRecord; created: boolean }> {
	const normalized = normalizeTeamName(name);
	return withRegistryLock(cwd, (registry) => {
		const existing = registry.teams.find((team) => team.name === normalized);
		if (existing) {
			if (description !== undefined)
				existing.description = description || undefined;
			existing.updatedAt = Date.now();
			return { team: existing, created: false };
		}
		const team: TeamRecord = {
			name: normalized,
			description: description?.trim() || undefined,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		registry.teams.push(team);
		return { team, created: true };
	});
}

export async function deleteTeam(
	cwd: string,
	name: string,
): Promise<{ team: TeamRecord | null; deleted: boolean }> {
	const normalized = normalizeTeamName(name);
	return withRegistryLock(cwd, (registry) => {
		const idx = registry.teams.findIndex((team) => team.name === normalized);
		if (idx === -1) return { team: null, deleted: false };
		const [team] = registry.teams.splice(idx, 1);
		return { team: team ?? null, deleted: true };
	});
}

export function normalizeTeamInput(
	name: string | undefined,
): string | undefined {
	if (!name?.trim()) return undefined;
	return normalizeTeamName(name);
}
