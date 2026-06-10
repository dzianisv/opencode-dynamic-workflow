import type { FsFacade } from "@drawers/core";
import { loadSkillCatalog, type SkillInfo } from "./skill-catalog";

/**
 * Thrown when a requested skill name resolves to no installed skill. The
 * binding is an authoring bug (a typo that binds nothing), so the resolver
 * fails loudly rather than emitting an empty part — the deliberate contrast
 * with `contextDiff`, where empty is a legitimate runtime state.
 */
export class SkillNotFoundError extends Error {
	constructor(
		public readonly name: string,
		public readonly available: string[],
	) {
		super(
			`Unknown skill: "${name}". Installed skills: ${
				available.length > 0 ? available.join(", ") : "(none)"
			}.`,
		);
		this.name = "SkillNotFoundError";
	}
}

/** A node:fs/promises-backed default facade (used when no fs is injected). */
function nodeFs(): FsFacade {
	const fs = require("node:fs/promises") as {
		mkdir: FsFacade["mkdir"];
		readdir: FsFacade["readdir"];
		readFile: FsFacade["readFile"];
		writeFile: FsFacade["writeFile"];
		rename: FsFacade["rename"];
		rm: FsFacade["rm"];
	};
	return fs;
}

/** Join two path segments with a single separator (no node:path dependency). */
function joinPath(base: string, rel: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	const r = rel.startsWith("/") ? rel.slice(1) : rel;
	return `${b}/${r}`;
}

/**
 * Return the body of a SKILL.md with its leading frontmatter block removed —
 * the complement of the catalog's private `sliceFrontmatter`. Everything after
 * the second `---` line is the body. When there is no closed frontmatter block,
 * the whole content is the body. The result is `trim`ed, mirroring
 * oh-my-opencode's `extractSkillTemplate()` returning `body.trim()`.
 */
function stripFrontmatter(content: string): string {
	const lines = content.split("\n");
	let first = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			first = i;
			break;
		}
	}
	if (first === -1) {
		return content.trim();
	}
	for (let i = first + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			return lines
				.slice(i + 1)
				.join("\n")
				.trim();
		}
	}
	return content.trim();
}

const STANDING_INSTRUCTION = [
	"The following skill is available for this task. Its bundled resources live under",
	"the skill dir below; read sibling files (e.g. shared-patterns/*.md) by relative",
	"path from that dir when the body references them.",
].join("\n");

/** Frame a resolved skill into the fixed contextPart text shape (Epic 2.1). */
function frameSkill(skill: SkillInfo, body: string): string {
	return [
		`<skill name="${skill.name}">`,
		`<description>${skill.description}</description>`,
		STANDING_INSTRUCTION,
		"",
		`<skill-dir>${skill.dir}</skill-dir>`,
		"",
		body,
		"</skill>",
	].join("\n");
}

/**
 * Resolve canonical skill names to synthetic text contextParts, one per name in
 * request order. Each part carries the framed `SKILL.md` body (frontmatter
 * stripped) plus the skill's absolute dir, ready to ride a synthetic part onto a
 * child launch exactly like `contextDiff` does.
 *
 * Disk access lives here (the plugin layer), never in the runtime. An unknown
 * name throws {@link SkillNotFoundError} — fail-loud, never skip or emit empty.
 * Repeated names are NOT de-duped (the author's call).
 */
export async function resolveSkillParts(
	names: string[],
	deps: { directory: string; fs?: FsFacade; configDir?: string },
): Promise<Array<{ type: "text"; text: string; synthetic: true }>> {
	const fs = deps.fs ?? nodeFs();
	const catalog = await loadSkillCatalog(deps);
	const byName = new Map<string, SkillInfo>();
	for (const skill of catalog) {
		byName.set(skill.name, skill);
	}

	const parts: Array<{ type: "text"; text: string; synthetic: true }> = [];
	for (const name of names) {
		const skill = byName.get(name);
		if (skill === undefined) {
			throw new SkillNotFoundError(
				name,
				catalog.map((s) => s.name),
			);
		}
		const content = await fs.readFile(joinPath(skill.dir, "SKILL.md"), "utf-8");
		const body = stripFrontmatter(content);
		parts.push({
			type: "text",
			text: frameSkill(skill, body),
			synthetic: true,
		});
	}
	return parts;
}
