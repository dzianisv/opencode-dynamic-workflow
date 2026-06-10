import type { FsFacade } from "@drawers/core";

/**
 * One installed skill, as discovered by scanning the opencode skill roots for
 * `SKILL.md` files and parsing their frontmatter. The shape is the shared
 * contract consumed by the `workflow_skills` discovery tool and, later, the
 * `resolveSkills` embedding seam — both depend on it staying fixed.
 */
export interface SkillInfo {
	/** Frontmatter `name` — the canonical, namespaced id (e.g. "ring:writing-trds"). */
	name: string;
	/** Frontmatter `description`; "" when absent. */
	description: string;
	/** Absolute dir containing SKILL.md — Phase 2 passes this for bundled-resource resolution. */
	dir: string;
	source: "user" | "project";
}

/** Join two path segments with a single separator (no node:path dependency). */
function joinPath(base: string, rel: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	const r = rel.startsWith("/") ? rel.slice(1) : rel;
	return `${b}/${r}`;
}

/** A node:fs/promises-backed default facade (used when no fs is injected). */
function nodeFs(): FsFacade {
	// Lazy require so the module stays import-light for the in-memory test path.
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

/**
 * The user-level opencode skill root: `$XDG_CONFIG_HOME/opencode/skill`, falling
 * back to `$HOME/.config/opencode/skill`. `process.env` access is fine here —
 * this is the plugin layer, not the runtime layer.
 */
function resolveUserConfigDir(): string {
	const base = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`;
	return joinPath(base, "opencode/skill");
}

/**
 * The frontmatter block is the text between the first `---` line and the next
 * `---` line. Returns the inner text, or undefined when there is no closed block.
 */
function sliceFrontmatter(content: string): string | undefined {
	const lines = content.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			start = i;
			break;
		}
	}
	if (start === -1) {
		return undefined;
	}
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			return lines.slice(start + 1, i).join("\n");
		}
	}
	return undefined;
}

/** Strip a single pair of matching surrounding quotes (single or double). */
function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' || first === "'") && first === last) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * A focused line scanner for a single top-level `key: value` in a frontmatter
 * block — avoids a YAML dependency for the two fields we need. Returns the
 * trimmed, unquoted value, or undefined when the key is absent.
 */
function scanField(frontmatter: string, key: string): string | undefined {
	const prefix = `${key}:`;
	for (const raw of frontmatter.split("\n")) {
		const line = raw.trimStart();
		if (line.startsWith(prefix)) {
			return unquote(line.slice(prefix.length).trim());
		}
	}
	return undefined;
}

/**
 * Recursively collect the directories of every file named exactly `SKILL.md`
 * under `root`. Directories are detected by TRYING `readdir` on each child:
 * success → dir (recurse); a throw → file. A `readdir` throw on `root` itself
 * (missing root) yields nothing — a user with no skills is normal, not an error.
 */
async function findSkillDirs(fs: FsFacade, root: string): Promise<string[]> {
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const name of names) {
		const child = joinPath(root, name);
		let isDir = true;
		let grandchildren: string[] = [];
		try {
			grandchildren = await fs.readdir(child);
		} catch {
			isDir = false;
		}
		if (isDir) {
			for (const sub of await collectFromDir(fs, child, grandchildren)) {
				dirs.push(sub);
			}
		} else if (name === "SKILL.md") {
			dirs.push(root);
		}
	}
	return dirs;
}

/**
 * Continue the {@link findSkillDirs} walk for an already-listed directory,
 * reusing the `readdir` result so each child is statted at most once.
 */
async function collectFromDir(
	fs: FsFacade,
	dir: string,
	names: string[],
): Promise<string[]> {
	const dirs: string[] = [];
	for (const name of names) {
		const child = joinPath(dir, name);
		if (name === "SKILL.md") {
			// A SKILL.md may itself be a directory in theory; only count files.
			let isDir = false;
			try {
				await fs.readdir(child);
				isDir = true;
			} catch {
				isDir = false;
			}
			if (!isDir) {
				dirs.push(dir);
			}
			continue;
		}
		let grandchildren: string[];
		try {
			grandchildren = await fs.readdir(child);
		} catch {
			continue; // a non-SKILL.md file: skip.
		}
		for (const sub of await collectFromDir(fs, child, grandchildren)) {
			dirs.push(sub);
		}
	}
	return dirs;
}

/** Parse a single SKILL.md into a {@link SkillInfo}, or undefined when unusable. */
async function parseSkill(
	fs: FsFacade,
	dir: string,
	source: "user" | "project",
): Promise<SkillInfo | undefined> {
	const content = await fs.readFile(joinPath(dir, "SKILL.md"), "utf-8");
	const frontmatter = sliceFrontmatter(content);
	if (frontmatter === undefined) {
		return undefined;
	}
	const name = scanField(frontmatter, "name")?.trim() ?? "";
	if (name.length === 0) {
		return undefined;
	}
	const description = scanField(frontmatter, "description") ?? "";
	return { name, description, dir, source };
}

/**
 * Load every installed skill from the user and project `.opencode/skill` roots.
 *
 * Walks each root recursively for files named exactly `SKILL.md`, parses
 * `name`/`description` from the frontmatter block, and skips files with no
 * frontmatter or no `name`. Non-`SKILL.md` resources (e.g. `shared-patterns/*`)
 * are ignored. On a name collision the project skill wins over the user skill.
 * A missing root degrades to nothing — never an error. The result is sorted by
 * `name` for stable output.
 */
export async function loadSkillCatalog(deps: {
	directory: string;
	fs?: FsFacade;
	configDir?: string;
}): Promise<SkillInfo[]> {
	const fs = deps.fs ?? nodeFs();
	const userRoot = deps.configDir ?? resolveUserConfigDir();
	const projectRoot = joinPath(deps.directory, ".opencode/skill");

	const byName = new Map<string, SkillInfo>();
	// User first, project second: project last-write-wins on a name collision.
	for (const [root, source] of [
		[userRoot, "user"],
		[projectRoot, "project"],
	] as const) {
		const dirs = await findSkillDirs(fs, root);
		for (const dir of dirs) {
			const skill = await parseSkill(fs, dir, source);
			if (skill) {
				byName.set(skill.name, skill);
			}
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
