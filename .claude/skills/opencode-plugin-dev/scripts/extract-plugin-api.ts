#!/usr/bin/env bun
/**
 * extract-plugin-api.ts — regenerate references/hooks.md + references/events.md
 * from the opencode plugin source. Bun only, no deps beyond Bun builtins.
 *
 * RECOMMENDED: run against a local monorepo checkout with --source. It is the
 * canonical source of truth (newer than any pushed ref), needs no network, and
 * can't be skewed by a stale/renamed remote branch:
 *
 *   bun run extract-plugin-api.ts --source /path/to/opencode   # ← prefer this
 *
 * DEFAULT (no flags): fetches the source files straight from GitHub raw, for when
 * no local checkout is handy. Tries each --ref in order until one resolves every
 * required file:
 *
 *   bun run extract-plugin-api.ts                               # GitHub-raw fallback
 *   bun run extract-plugin-api.ts --ref anomalyco/opencode@dev  # override remote ref(s), repeatable
 *   bun run extract-plugin-api.ts --ref sst/opencode@v1.16.2
 *
 * A ref is "<org>/<repo>@<branch-or-tag>". Defaults try sst/opencode then
 * anomalyco/opencode, both at @dev. On any failure it exits non-zero with an
 * actionable message and writes nothing — it never falls back to stale refs.
 *
 * Source files (current layout — VERIFIED against the monorepo, line refs are the
 * regex anchors below):
 *   packages/plugin/src/index.ts                — Hooks (:222), PluginInput (:56), Plugin (:74), AuthHook (:88)
 *   packages/plugin/src/tool.ts                 — tool() helper / ToolDefinition
 *   packages/plugin/src/shell.ts                — BunShell ($) type
 *   packages/sdk/js/src/gen/types.gen.ts        — v1 Event union (:704; what plugins receive)
 */

import { existsSync } from "node:fs"
import { join, dirname } from "node:path"

const REQUIRED = {
  pluginIndex: "packages/plugin/src/index.ts",
  pluginTool: "packages/plugin/src/tool.ts",
  pluginShell: "packages/plugin/src/shell.ts",
  sdkTypes: "packages/sdk/js/src/gen/types.gen.ts",
} as const

const REFERENCES_DIR = join(dirname(import.meta.dir), "references")

// ---- arg parsing -----------------------------------------------------------

function parseArgs(argv: string[]) {
  const refs: string[] = []
  let source: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--source") source = argv[++i]
    else if (a === "--ref") refs.push(argv[++i])
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "extract-plugin-api.ts — regenerate references/hooks.md + events.md",
          "",
          "RECOMMENDED (local checkout — canonical, offline, can't go stale):",
          "  bun run extract-plugin-api.ts --source /path/to/opencode",
          "",
          "Fallback (GitHub raw):",
          "  bun run extract-plugin-api.ts                  # default refs",
          "  bun run extract-plugin-api.ts --ref org/repo@branch   # override, repeatable",
          "",
          "See the header comment in this file for full details.",
        ].join("\n"),
      )
      process.exit(0)
    } else die(`unknown argument: ${a}`)
  }
  if (refs.length === 0) refs.push("sst/opencode@dev", "anomalyco/opencode@dev")
  return { refs, source }
}

function die(message: string): never {
  console.error(`extract-plugin-api: ${message}`)
  process.exit(1)
}

// ---- source acquisition -----------------------------------------------------

type Sources = Record<keyof typeof REQUIRED, string> & { provenance: string }

async function readLocal(source: string): Promise<Sources> {
  const root = source
  const out: Partial<Sources> = {}
  for (const [key, rel] of Object.entries(REQUIRED) as [keyof typeof REQUIRED, string][]) {
    const p = join(root, rel)
    if (!existsSync(p)) {
      die(`--source ${root} is missing ${rel}. Point --source at the opencode monorepo root.`)
    }
    out[key] = await Bun.file(p).text()
  }
  return { ...(out as Sources), provenance: `local checkout: ${root}` }
}

function rawUrl(ref: string, rel: string): string {
  // ref = "org/repo@branch"  ->  https://raw.githubusercontent.com/org/repo/branch/<rel>
  const at = ref.lastIndexOf("@")
  if (at === -1) die(`bad --ref "${ref}" (expected "org/repo@branch")`)
  const slug = ref.slice(0, at)
  const branch = ref.slice(at + 1)
  return `https://raw.githubusercontent.com/${slug}/${branch}/${rel}`
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "extract-plugin-api" } })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

async function readRemote(refs: string[]): Promise<Sources> {
  const attempts: string[] = []
  for (const ref of refs) {
    const out: Partial<Sources> = {}
    let ok = true
    for (const [key, rel] of Object.entries(REQUIRED) as [keyof typeof REQUIRED, string][]) {
      const url = rawUrl(ref, rel)
      const text = await fetchText(url)
      if (text === null) {
        attempts.push(`  ${ref}: could not fetch ${rel} (${url})`)
        ok = false
        break
      }
      out[key] = text
    }
    if (ok) return { ...(out as Sources), provenance: `github raw: ${ref}` }
  }
  die(
    "failed to fetch plugin source from every ref. Tried:\n" +
      attempts.join("\n") +
      "\nFix: pass a reachable --ref \"org/repo@branch\", or use --source <local opencode checkout>.\n" +
      "Refusing to regenerate from stale data.",
  )
}

// ---- extraction (loud on miss; no silent empties) ---------------------------

function extractBlock(content: string, re: RegExp, what: string): string {
  const m = content.match(re)
  if (!m) die(`could not locate ${what} in source — the layout may have changed. Aborting.`)
  return m[0]
}

function extractHooks(index: string): string {
  return extractBlock(index, /export interface Hooks \{[\s\S]*?\n\}/m, "the Hooks interface")
}

function extractPluginInput(index: string): string {
  return extractBlock(index, /export type PluginInput = \{[\s\S]*?\n\}/m, "PluginInput")
}

function extractPluginSig(index: string): string {
  return extractBlock(index, /export type Plugin = [\s\S]*?=> Promise<Hooks>/m, "the Plugin signature")
}

function extractAuthHook(index: string): string {
  const hook = index.match(/export type AuthHook = \{[\s\S]*?\n\}/m)
  if (!hook) die("could not locate AuthHook in source. Aborting.")
  return hook[0]
}

function extractToolHelper(tool: string): string {
  // The whole file is small and load-bearing; embed it verbatim.
  return tool.trim()
}

type EventInfo = { name: string; type: string; fullType: string }

function extractEventUnion(types: string): string[] {
  const m = types.match(/export type Event =\s*([\s\S]*?)(?=\n\nexport |\n\n\/\*\*|\nexport )/m)
  if (!m) die("could not locate the Event union in the SDK types. Aborting.")
  const names = m[1].match(/Event\w+/g) || []
  if (names.length === 0) die("Event union matched but contained no members. Aborting.")
  return names
}

function extractEvents(types: string, unionNames: string[]): EventInfo[] {
  const events: EventInfo[] = []
  for (const name of unionNames) {
    const re = new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\}`, "m")
    const m = types.match(re)
    if (!m) continue
    const t = m[1].match(/type:\s*"([^"]+)"/)
    if (!t) continue
    events.push({ name, type: t[1], fullType: `export type ${name} = {${m[1]}\n}` })
  }
  if (events.length === 0) die("found the Event union but could not resolve any member definitions. Aborting.")
  return events
}

// ---- doc generation ---------------------------------------------------------

function header(provenance: string, sourceFile: string): string {
  const ts = new Date().toISOString()
  return `> Auto-generated by scripts/extract-plugin-api.ts on ${ts}.
> Provenance: ${provenance}.
> Source: \`${sourceFile}\`.
> Regenerate with: \`bun run scripts/extract-plugin-api.ts\`.`
}

function generateHooksDoc(
  provenance: string,
  pluginInput: string,
  pluginSig: string,
  hooks: string,
  authHook: string,
  toolHelper: string,
): string {
  return `# Hooks Interface Reference

${header(provenance, "packages/plugin/src/{index,tool,shell}.ts")}

A plugin is a function returning a \`Hooks\` object. opencode calls each hook you
provide; omit the rest. All hooks are async \`Promise<void>\`.

## Disk location and registration

Plugin files auto-load from these directories — the dir name is **plural**:

- Project: \`.opencode/plugins/\`
- Global: \`~/.config/opencode/plugins/\`

Or register by name in \`opencode.json\` under \`plugin\` (npm packages or local paths):

\`\`\`json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["@my-org/plugin", "./local-plugin.ts"] }
\`\`\`

## Plugin signature and input

\`\`\`typescript
${pluginInput}

${pluginSig}
\`\`\`

## Logging (body-wrapped)

Route diagnostics through \`client.app.log\` — never \`console.log\` (it corrupts
the TUI and the JSON-RPC stream).

\`\`\`typescript
await client.app.log({ body: { service: "my-plugin", level: "info", message: "init" } })
\`\`\`

## Hooks interface

\`\`\`typescript
${hooks}
\`\`\`

Mutation contract: two-arg hooks change behavior by **mutating \`output\` in place**;
\`input\` is read-only. Single-arg hooks (\`event\`, \`config\`, \`dispose\`) are
notification/setup hooks.

> **\`PluginModule.tui\` is typed \`never\`, but the runtime loads \`tui()\`.** The
> published \`PluginModule\` pins \`tui?: never\` (\`packages/plugin/src/index.ts:79\`),
> yet \`readV1Plugin\` reads and accepts \`value.tui\` (\`packages/opencode/src/plugin/shared.ts:286,290-292,299-301\`)
> — the type lags the runtime. TUI plugins are a separate \`./tui\` surface; see
> \`references/tui.md\`.

## Auth hook

\`\`\`typescript
${authHook}
\`\`\`

## Custom tools — \`tool()\` helper

Args use \`tool.schema.*\` (re-exported zod), **not** raw zod and **not** a
\`parameters\` field. There is no \`client.registerTool()\`.

\`\`\`typescript
${toolHelper}
\`\`\`
`
}

function generateEventsDoc(provenance: string, events: EventInfo[], unionNames: string[]): string {
  const rows = events.map((e) => `| \`${e.type}\` | \`${e.name}\` |`).join("\n")
  const payloads = events.map((e) => e.fullType).join("\n")
  return `# Event Catalog Reference

${header(provenance, "packages/sdk/js/src/gen/types.gen.ts (v1 Event union)")}

The plugin \`event\` hook imports \`Event\` from \`@opencode-ai/sdk\` (**v1**). This
file reflects that v1 union — the events plugins actually receive. \`event\` is
observational only; to influence behavior use the dedicated hooks in \`hooks.md\`.

\`\`\`typescript
event: async ({ event }) => {
  // event.type — discriminant; event.properties — payload narrowed by type
}
\`\`\`

## Union (${unionNames.length} members)

\`\`\`typescript
export type Event =
${unionNames.map((t) => `  | ${t}`).join("\n")}
\`\`\`

## Quick reference

| \`type\` string | TS type |
|---|---|
${rows}

## Payloads

\`\`\`typescript
${payloads}
\`\`\`

## Gotchas

- Use \`session.idle\` as the "turn finished" signal, not trailing \`message.part.updated\`.
  Source marks it \`// deprecated\` (\`opencode/src/session/status.ts:42\`); it still fires and the
  v1 union has no successor, so keep using it — expect a \`session.status\`/step-ended successor later.
- \`server.connected\` fires once on connect — good for one-time bootstrap.
- \`session.error.error\` is a union of error shapes; both it and \`sessionID\` are optional — narrow first.
- Events carry no "subagent" flag. Correlate via \`Session.parentID\` (fetch by \`sessionID\`).
- \`tui.*\` events only fire under the TUI, not headless/CLI runs.

### Runtime vs. this type — read before trusting the union above

This file is generated from the **v1 SDK \`Event\` union** (the type the \`event\` hook is declared
against). At runtime the hook receives the EventV2 bridge payload as untyped \`{id,type,properties}\`
(\`opencode/src/plugin/index.ts:262\` re-emits EventV2 \`data\` as \`properties\`). Three consequences:

- **\`data\` is renamed to \`properties\`.** EventV2 publishes a \`data\` field; the bridge re-emits it as
  \`properties\` (\`opencode/src/plugin/index.ts:262\`). The \`event.properties\` you read IS the EventV2 \`data\`.
- **The runtime delivers MORE events than this union types.** Not in the v1 union but emitted at
  runtime (narrow by \`event.type\` string / \`as any\`): the entire \`session.next.*\` family (~30 types —
  step/text/reasoning/tool/shell/compaction lifecycle + deltas), \`account.*\`, \`mcp.tools.changed\`,
  \`mcp.browser.open.failed\`, \`project.updated\`, \`question.{asked,replied,rejected}\`, \`permission.v2.*\`,
  \`catalog.model.updated\`, \`models-dev.refreshed\`, \`plugin.added\`,
  \`worktree.{ready,failed}\`, \`workspace.{ready,failed,status}\`, \`ide.installed\`, \`global.disposed\`,
  \`message.part.delta\`, \`tui.session.select\`. (Verified vs \`EventV2.define\` sites in \`opencode/src\`.)
- **Per-token firehose to avoid.** \`message.part.updated\` fires per part mutation (effectively per chunk
  while streaming, \`session.ts:679\`); the v2 \`session.next.*.delta\` family is per-token. Filter early;
  never do work per delta. This is why \`session.idle\` is the right "turn done" boundary.
- **Phantom union members that NEVER fire.** \`permission.updated\` and \`lsp.client.diagnostics\` are in
  the v1 union (so they appear in the table above) but have **no \`EventV2.define\` anywhere in source** —
  they are type-only and never reach the hook. Real permission events: \`permission.asked\` /
  \`permission.replied\` (\`opencode/src/permission/index.ts:14-16\`). Do not write code that waits on the
  phantoms.
- **Global (directory-less) events are dropped.** The hook listener skips any event whose
  \`location.directory\` !== the plugin's bound dir (\`opencode/src/plugin/index.ts:259\`). Global-scope
  events (\`account.*\`, \`installation.*\`, \`global.disposed\`, model-catalog refreshes) carry no
  \`location\`, so they never reach the \`event\` hook despite \`listen\` being global. "React to account
  switch / catalog change" is NOT feasible from this hook.

> If you edit this section, mirror the change in the committed \`references/events.md\` AND keep it inside
> this \`generateEventsDoc\` template — it is the only hand-written block that survives regeneration.
`
}

// ---- main -------------------------------------------------------------------

async function main() {
  const { refs, source } = parseArgs(process.argv.slice(2))
  const src = source ? await readLocal(source) : await readRemote(refs)
  console.log(`extract-plugin-api: source = ${src.provenance}`)

  const pluginInput = extractPluginInput(src.pluginIndex)
  const pluginSig = extractPluginSig(src.pluginIndex)
  const hooks = extractHooks(src.pluginIndex)
  const authHook = extractAuthHook(src.pluginIndex)
  const toolHelper = extractToolHelper(src.pluginTool)

  const unionNames = extractEventUnion(src.sdkTypes)
  const events = extractEvents(src.sdkTypes, unionNames)
  console.log(`extract-plugin-api: ${unionNames.length} events in union, ${events.length} resolved`)

  const hooksDoc = generateHooksDoc(src.provenance, pluginInput, pluginSig, hooks, authHook, toolHelper)
  const eventsDoc = generateEventsDoc(src.provenance, events, unionNames)

  await Promise.all([
    Bun.write(join(REFERENCES_DIR, "hooks.md"), hooksDoc),
    Bun.write(join(REFERENCES_DIR, "events.md"), eventsDoc),
  ])

  console.log("extract-plugin-api: wrote references/hooks.md, references/events.md")
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)))
