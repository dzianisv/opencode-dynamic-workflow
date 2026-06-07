/**
 * semantic-release `prepareCmd`: stamp the computed version into both PUBLISHED
 * plugin manifests (lockstep — one version for the set) and build the bundles.
 *
 * `@drawers/core` stays npm-private; the build inlines it (see scripts/build.ts).
 * Runs BEFORE publish; the version-bumped package.jsons are committed back to main
 * by @semantic-release/git afterwards.
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
	"packages/background-agents/package.json",
	"packages/workflows/package.json",
];

for (const path of MANIFESTS) {
	const json = JSON.parse(await Bun.file(path).text());
	json.version = version;
	await Bun.write(path, `${JSON.stringify(json, null, "\t")}\n`);
	console.log(`set ${json.name} → ${version}`);
}

await $`bun run scripts/build.ts`;
console.log(`prepared release ${version}`);
