/**
 * Agent definitions: the `.md` persona file format and its loader.
 *
 * Format-compatible with pi's own `resolveAgent` reader (same YAML frontmatter +
 * body, same `.pi/agents/*.md` and `~/.pi/agent/agents/*.md` locations). This module
 * does NOT fold into the engine's resolver — it stays an independent, format-matching
 * reader so the extension owns its own discovery and lifecycle.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The thinking-level vocabulary pi accepts (mirrors `ThinkingLevel` in
 * `@earendil-works/pi-agent-core` — kept local to avoid a transitive type import). */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export type AgentSource = "global" | "project";

export interface AgentDef {
	/** filename without `.md` */
	id: string;
	/** display name from frontmatter (falls back to id) */
	name: string;
	/** one-liner from frontmatter */
	description: string;
	/** optional preferred model id/name */
	model?: string;
	/** optional preferred thinking level (raw frontmatter string) */
	thinking?: string;
	/** the persona prompt — everything after the frontmatter */
	body: string;
	source: AgentSource;
}

/** Persisted across restarts via `pi.appendEntry("agent-persona", …)`. */
export interface PersistedPersonaState {
	agentId: string | null;
	restoreModelId?: string | null;
	restoreThinking?: ThinkingLevel | null;
}

export function normalizeThinking(level: unknown): ThinkingLevel | null {
	return level === "off" ||
		level === "minimal" ||
		level === "low" ||
		level === "medium" ||
		level === "high" ||
		level === "xhigh"
		? level
		: null;
}

export function parseFrontmatter(content: string): {
	meta: Record<string, string>;
	body: string;
} {
	const meta: Record<string, string> = {};
	let body = content;

	if (content.startsWith("---")) {
		const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
		if (match) {
			const frontmatter = match[1]?.trim() ?? "";
			body = content.slice(match[0].length).trim();

			for (const line of frontmatter.split("\n")) {
				const colonIdx = line.indexOf(":");
				if (colonIdx === -1) continue;
				const key = line.slice(0, colonIdx).trim();
				let value = line.slice(colonIdx + 1).trim();
				// Strip surrounding quotes
				if (
					(value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))
				) {
					value = value.slice(1, -1);
				}
				meta[key] = value;
			}
		}
	}

	return { meta, body };
}

async function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
): Promise<AgentDef[]> {
	const agents: AgentDef[] = [];
	let entries: string[];

	try {
		entries = await readdir(dir);
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		try {
			const content = await readFile(join(dir, entry), "utf-8");
			const { meta, body } = parseFrontmatter(content);

			if (!body.trim()) continue;

			const id = entry.replace(/\.md$/, "");
			agents.push({
				id,
				name: meta.name || id,
				description: meta.description || "",
				model: meta.model,
				thinking: meta.thinking,
				body,
				source,
			});
		} catch {
			// Skip unreadable files
		}
	}

	return agents;
}

/**
 * Load agents from the user dir (honoring `$PI_AGENT_DIR`) and the project dir,
 * project-local entries overriding global ones with the same id. Sorted by name.
 */
export async function loadAgents(cwd: string): Promise<AgentDef[]> {
	const userBase = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	const globalDir = join(userBase, "agents");
	const projectDir = join(cwd, ".pi", "agents");

	const [globalAgents, projectAgents] = await Promise.all([
		loadAgentsFromDir(globalDir, "global"),
		loadAgentsFromDir(projectDir, "project"),
	]);

	// Project-local agents override global ones with the same id.
	const agentMap = new Map<string, AgentDef>();
	for (const a of globalAgents) agentMap.set(a.id, a);
	for (const a of projectAgents) agentMap.set(a.id, a);
	return [...agentMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}
