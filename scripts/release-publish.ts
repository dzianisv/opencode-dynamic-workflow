/**
 * semantic-release `publishCmd`: publish every plugin to npm.
 *
 * Two families, two shapes:
 *
 *  - opencode plugins BUNDLE their private engine — `scripts/build.ts` inlines
 *    `@drawers/core` into `dist/*.js`, and the `workspace:*` ref lives only in
 *    `devDependencies`. Deleting devDependencies yields a self-contained tarball
 *    with no workspace protocol.
 *
 *  - pi plugins do NOT bundle — pi loads the TS `src/` via jiti, so the private
 *    engine can't be inlined anywhere. `@drawers/pi-core` is published as a real
 *    package and each plugin's runtime `dependencies["@drawers/pi-core"]` is
 *    rewritten from `workspace:*` to the exact release version (npm cannot resolve
 *    the workspace protocol). pi-core therefore lists BEFORE its dependents.
 *
 * Each manifest is mutated only for the publish, then restored — the tarball
 * carries no workspace protocol while main keeps its build-time devDeps. Auth comes
 * from the CI `.npmrc` (NODE_AUTH_TOKEN = NPM_TOKEN).
 *
 * Usage: `bun run scripts/release-publish.ts <version>`
 */

import { $ } from "bun";

const version = process.argv[2] ?? "(unknown)";

// Publish order matters: @drawers/pi-core must land before the pi plugins that
// depend on it so a consumer's install can resolve the pinned version.
const PACKAGES = [
	"packages/opencode/background-agents",
	"packages/opencode/workflows",
	"packages/opencode/cadence",
	"packages/opencode/statusline",
	"packages/pi/core",
	"packages/pi/background-agents",
	"packages/pi/cadence",
	"packages/pi/workflows",
	"packages/pi/statusline",
];

for (const dir of PACKAGES) {
	const pkgPath = `${dir}/package.json`;
	const original = await Bun.file(pkgPath).text();
	const json = JSON.parse(original);

	delete json.devDependencies;
	// pi plugins carry the engine as a runtime dep; pin the workspace ref to the
	// release version. No-op for packages that don't depend on it.
	if (json.dependencies?.["@drawers/pi-core"]) {
		json.dependencies["@drawers/pi-core"] = version;
	}

	const serialized = `${JSON.stringify(json, null, "\t")}\n`;
	// Guard: npm has no notion of the workspace: protocol — leaking it into a
	// published manifest breaks every consumer install. Fail the release instead.
	if (serialized.includes("workspace:")) {
		throw new Error(
			`${json.name}: unresolved workspace: protocol in publish manifest`,
		);
	}

	await Bun.write(pkgPath, serialized);
	try {
		await $`npm publish`.cwd(dir);
		console.log(`published ${json.name}@${version}`);
	} finally {
		await Bun.write(pkgPath, original);
	}
}
