import { describe, expect, test } from "bun:test";
import type { FsFacade } from "@drawers/core";
import { resolveSkillParts, SkillNotFoundError } from "./skill-resolver";

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

function run(names: string[], files: Record<string, string>) {
	return resolveSkillParts(names, {
		directory: "/proj",
		configDir: USER,
		fs: memFs(files),
	});
}

const TRDS_DIR = `${USER}/pm-team/writing-trds`;
const PLANS_DIR = `${USER}/pm-team/writing-plans`;

function trdsSkill(): Record<string, string> {
	return {
		[`${TRDS_DIR}/SKILL.md`]: [
			"---",
			"name: ring:writing-trds",
			'description: "Write technical requirement docs"',
			"---",
			"# Writing TRDs",
			"Do the thing.",
		].join("\n"),
	};
}

function plansSkill(): Record<string, string> {
	return {
		[`${PLANS_DIR}/SKILL.md`]: [
			"---",
			"name: ring:writing-plans",
			'description: "Write phased plans"',
			"---",
			"# Writing Plans",
			"Plan the thing.",
		].join("\n"),
	};
}

describe("resolveSkillParts", () => {
	test("a known skill resolves to one framed part", async () => {
		const parts = await run(["ring:writing-trds"], trdsSkill());
		expect(parts).toHaveLength(1);
		const part = parts[0];
		expect(part?.type).toBe("text");
		expect(part?.synthetic).toBe(true);
		const text = part?.text ?? "";
		expect(text).toContain('<skill name="ring:writing-trds">');
		expect(text).toContain(
			"<description>Write technical requirement docs</description>",
		);
		expect(text).toContain(`<skill-dir>${TRDS_DIR}</skill-dir>`);
		expect(text).toContain("# Writing TRDs");
		expect(text).toContain("Do the thing.");
		expect(text).toContain("</skill>");
		// Frontmatter --- lines and the name: line are stripped from the body.
		expect(text).not.toContain("name: ring:writing-trds");
		expect(text).not.toContain("---");
	});

	test("two names resolve to two parts in request order", async () => {
		const files = { ...plansSkill(), ...trdsSkill() };
		const parts = await run(["ring:writing-trds", "ring:writing-plans"], files);
		expect(parts).toHaveLength(2);
		expect(parts[0]?.text).toContain('<skill name="ring:writing-trds">');
		expect(parts[1]?.text).toContain('<skill name="ring:writing-plans">');
	});

	test("every part is {type:'text', synthetic:true}", async () => {
		const files = { ...plansSkill(), ...trdsSkill() };
		const parts = await run(["ring:writing-trds", "ring:writing-plans"], files);
		for (const part of parts) {
			expect(part.type).toBe("text");
			expect(part.synthetic).toBe(true);
		}
	});

	test("an unknown name throws SkillNotFoundError naming it and the installed names", async () => {
		const promise = run(["ring:nope"], trdsSkill());
		await expect(promise).rejects.toBeInstanceOf(SkillNotFoundError);
		try {
			await run(["ring:nope"], trdsSkill());
			throw new Error("should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("ring:nope");
			expect(message).toContain("ring:writing-trds");
		}
	});
});
