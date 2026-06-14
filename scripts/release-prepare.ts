/**
 * semantic-release `prepareCmd`: stamp the computed version into all PUBLISHED
 * plugin manifests (lockstep — one version for the set) and build the bundles.
 *
 * opencode's `@drawers/core` stays npm-private; the build inlines it (see
 * scripts/build.ts). pi's `@drawers/pi-core` IS published (pi loads TS via jiti,
 * so it can't be inlined) — it gets the same version stamp here, and the publish
 * step pins each pi plugin's workspace ref to it. Runs BEFORE publish; the
 * version-bumped package.jsons are committed back to main by @semantic-release/git.
 *
 * Usage: `bun run scripts/release-prepare.ts <version>`
 */

import { $ } from "bun";

const version = process.argv[2];
if (!version) {
	console.error("usage: release-prepare <version>");
	process.exit(1);
}

const MANIFESTS = [
	"packages/opencode/background-agents/package.json",
	"packages/opencode/workflows/package.json",
	"packages/opencode/cadence/package.json",
	"packages/opencode/statusline/package.json",
	"packages/pi/core/package.json",
	"packages/pi/background-agents/package.json",
	"packages/pi/cadence/package.json",
	"packages/pi/workflows/package.json",
	"packages/pi/statusline/package.json",
];

for (const path of MANIFESTS) {
	const json = JSON.parse(await Bun.file(path).text());
	json.version = version;
	await Bun.write(path, `${JSON.stringify(json, null, "\t")}\n`);
	console.log(`set ${json.name} → ${version}`);
}

await $`bun run scripts/build.ts`;
console.log(`prepared release ${version}`);
