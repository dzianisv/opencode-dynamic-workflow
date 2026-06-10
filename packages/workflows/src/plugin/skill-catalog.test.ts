import { describe, expect, test } from "bun:test";
import type { FsFacade } from "@drawers/core";
import { loadSkillCatalog } from "./skill-catalog";

/**
 * An in-memory {@link FsFacade} over a flat `path -> content` map. Directories are
 * implicit (any path that is a strict prefix of a stored file's path, split on
 * `/`). `readdir` lists the immediate child names of a dir and THROWS on a file
 * path or an unknown path — mirroring how the real facade lets the catalog
 * distinguish dirs from files (a `readdir` throw means "this is a file").
 */
function memFs(files: Record<string, string>): FsFacade {
	const has = (p: string) => Object.hasOwn(files, p);
	const norm = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);
	return {
		mkdir: async () => undefined,
		writeFile: async (path, data) => {
			files[path] = data;
		},
		rename: async () => undefined,
		rm: async () => undefined,
		readFile: async (path) => {
			const content = files[path];
			if (content === undefined) {
				throw new Error(`ENOENT: ${path}`);
			}
			return content;
		},
		readdir: async (path) => {
			const dir = norm(path);
			if (has(dir)) {
				// It is a file, not a directory.
				throw new Error(`ENOTDIR: ${dir}`);
			}
			const prefix = `${dir}/`;
			const children = new Set<string>();
			for (const full of Object.keys(files)) {
				if (full.startsWith(prefix)) {
					const rest = full.slice(prefix.length);
					const name = rest.split("/")[0];
					if (name) {
						children.add(name);
					}
				}
			}
			if (children.size === 0) {
				throw new Error(`ENOENT: ${dir}`);
			}
			return [...children];
		},
	};
}

const USER = "/home/u/.config/opencode/skill";
const PROJECT = "/proj/.opencode/skill";

function run(files: Record<string, string>) {
	return loadSkillCatalog({
		directory: "/proj",
		configDir: USER,
		fs: memFs(files),
	});
}

describe("loadSkillCatalog", () => {
	test("parses a valid SKILL.md (name, description, dir, source)", async () => {
		const skills = await run({
			[`${USER}/pm-team/writing-trds/SKILL.md`]: [
				"---",
				"name: ring:writing-trds",
				'description: "Write technical requirement docs"',
				"---",
				"# Writing TRDs",
				"body",
			].join("\n"),
		});
		expect(skills).toHaveLength(1);
		expect(skills[0]).toEqual({
			name: "ring:writing-trds",
			description: "Write technical requirement docs",
			dir: `${USER}/pm-team/writing-trds`,
			source: "user",
		});
	});

	test("excludes non-SKILL.md files like shared-patterns/foo.md", async () => {
		const skills = await run({
			[`${USER}/dev-team/x/shared-patterns/foo.md`]: [
				"---",
				"name: should-not-load",
				"---",
				"body",
			].join("\n"),
		});
		expect(skills).toEqual([]);
	});

	test("skips a SKILL.md with no frontmatter block", async () => {
		const skills = await run({
			[`${USER}/team/no-fm/SKILL.md`]: "# No frontmatter here\njust a body",
		});
		expect(skills).toEqual([]);
	});

	test("skips a SKILL.md with frontmatter but no name", async () => {
		const skills = await run({
			[`${USER}/team/no-name/SKILL.md`]: [
				"---",
				'description: "has a description but no name"',
				"---",
				"body",
			].join("\n"),
		});
		expect(skills).toEqual([]);
	});

	test("project skill overrides a same-named user skill (precedence)", async () => {
		const skills = await run({
			[`${USER}/team/dup/SKILL.md`]: [
				"---",
				"name: ring:dup",
				'description: "user version"',
				"---",
			].join("\n"),
			[`${PROJECT}/team/dup/SKILL.md`]: [
				"---",
				"name: ring:dup",
				'description: "project version"',
				"---",
			].join("\n"),
		});
		expect(skills).toHaveLength(1);
		expect(skills[0]).toEqual({
			name: "ring:dup",
			description: "project version",
			dir: `${PROJECT}/team/dup`,
			source: "project",
		});
	});

	test("missing root degrades to empty, never throws", async () => {
		// No skill files at all → both roots' readdir throws → empty result.
		await expect(run({})).resolves.toEqual([]);
	});

	test("sorts by name and parses bare (unquoted) description values", async () => {
		const skills = await run({
			[`${USER}/a/zebra/SKILL.md`]: [
				"---",
				"name: ring:zebra",
				"description: bare value to end of line",
				"---",
			].join("\n"),
			[`${USER}/a/alpha/SKILL.md`]: ["---", "name: ring:alpha", "---"].join(
				"\n",
			),
		});
		expect(skills.map((s) => s.name)).toEqual(["ring:alpha", "ring:zebra"]);
		expect(skills[0]?.description).toBe("");
		expect(skills[1]?.description).toBe("bare value to end of line");
	});
});
