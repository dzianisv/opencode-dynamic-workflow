/**
 * semantic-release `publishCmd`: publish both plugins to npm.
 *
 * Each package's `devDependencies` (which include the private `@drawers/core` via
 * the `workspace:*` protocol npm cannot resolve) are stripped from the manifest
 * ONLY for the publish, then restored — so the tarball carries no workspace
 * protocol and main keeps the build-time devDeps. Consumers never see devDeps
 * anyway; runtime deps + the optional opentui peers stay. Auth comes from the CI
 * `.npmrc` (NODE_AUTH_TOKEN = NPM_TOKEN).
 *
 * Usage: `bun run scripts/release-publish.ts <version>`
 */

import { $ } from "bun";

const version = process.argv[2] ?? "(unknown)";

const PACKAGES = ["packages/background-agents", "packages/workflows"];

for (const dir of PACKAGES) {
	const pkgPath = `${dir}/package.json`;
	const original = await Bun.file(pkgPath).text();
	const json = JSON.parse(original);
	delete json.devDependencies;
	await Bun.write(pkgPath, `${JSON.stringify(json, null, "\t")}\n`);
	try {
		await $`npm publish`.cwd(dir);
		console.log(`published ${json.name}@${version}`);
	} finally {
		await Bun.write(pkgPath, original);
	}
}
