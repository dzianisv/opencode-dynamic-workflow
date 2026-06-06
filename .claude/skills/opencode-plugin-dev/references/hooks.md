# Hooks Interface Reference

> Generated from `@opencode-ai/plugin` source, then enriched against a local
> clone of `sst/opencode` at commit `4519a1da3`. 2026-06-06.
> Ground truth: `packages/plugin/src/index.ts`, `packages/plugin/src/tool.ts`,
> `packages/plugin/src/shell.ts`, the v1 SDK `packages/sdk/js/src/gen/types.gen.ts`,
> and the runtime dispatch in `packages/opencode/src/plugin/index.ts` +
> trigger call-sites under `packages/opencode/src/session`. `file:line` refs
> below are into that clone. Trust this file over any vendored snapshot.

A plugin is a function returning a `Hooks` object. opencode calls each hook you
provide; omit the ones you do not need. All hooks are async and return `Promise<void>`.

## Disk location and registration (authoritative)

- Plugin files auto-load from these directories. The glob is `{plugin,plugins}/*.{ts,js}`
  (`config/plugin.ts:21`): **both** singular `plugin/` and plural `plugins/` load,
  one level deep, only `.ts`/`.js`. Plural is the convention; singular is not a mistake.
  - Project: `.opencode/plugins/` (or `.opencode/plugin/`)
  - Global: `~/.config/opencode/plugins/` (or `~/.config/opencode/plugin/`)
- Or register by name in `opencode.json` under the `plugin` array (npm packages
  installed automatically with Bun at startup; local file paths also accepted):
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["opencode-wakatime", "@my-org/custom-plugin", "./local-plugin.ts"]
  }
  ```
- Config type allows per-plugin options as a tuple:
  `plugin?: Array<string | [string, PluginOptions]>` where
  `PluginOptions = Record<string, unknown>`.

## Plugin / PluginInput / PluginModule shapes

```typescript
import type { createOpencodeClient, Project } from "@opencode-ai/sdk"
import type { BunShell } from "@opencode-ai/plugin" // shell.ts

export type WorkspaceInfo = {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  projectID: string
}

export type WorkspaceAdapter = {
  name: string
  description: string
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(config: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(config: WorkspaceInfo): Promise<void>
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
}

export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string          // session cwd; prefer over process.cwd()
  worktree: string           // git worktree root
  experimental_workspace: {  // register custom workspace adapters (remote/sandbox)
    register(type: string, adapter: WorkspaceAdapter): void
  }
  serverUrl: URL             // base URL of the running opencode server
  $: BunShell                // Bun shell tagged-template runner — see caveat
}

export type PluginOptions = Record<string, unknown>

// The plugin function. options is the per-plugin config from opencode.json (tuple form).
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

// Module-level export shape (when a package exports a structured plugin module).
export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never   // TUI plugins are a separate surface; not via this module field
}
```

> **`$` is `undefined` outside Bun.** The type is non-optional, but core sets it
> `typeof Bun === "undefined" ? undefined : Bun.$` (with a `@ts-expect-error`,
> `plugin/index.ts:161-162`). Guard before use — `if (!$) return` — or a plugin
> using `$` unguarded crashes in a non-Bun host. Its method catalog is just Bun's
> `$` API; see Bun docs.

Idiomatic entry point:

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ client, project, directory, worktree, $, serverUrl }) => {
  return {
    // ...hooks
  }
}
```

## Logging (authoritative shape — body-wrapped)

`client.app.log` takes a `body`-wrapped payload. Flat calls are wrong.

```typescript
await client.app.log({
  body: {
    service: "my-plugin",            // required
    level: "info",                   // "debug" | "info" | "warn" | "error"
    message: "Plugin initialized",   // required
    extra: { sessionID, foo: "bar" } // optional Record<string, unknown>
  },
})
```

Discipline: route all diagnostics through `client.app.log`. Writing to
`console.log`/`stdout` corrupts the TUI render and the JSON-RPC stream.

## Hooks interface (complete, current)

```typescript
export interface Hooks {
  dispose?: () => Promise<void>
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: { [key: string]: ToolDefinition }
  auth?: AuthHook
  provider?: ProviderHook

  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>

  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: {
      temperature: number
      topP: number
      topK: number
      maxOutputTokens: number | undefined
      options: Record<string, any>
    },
  ) => Promise<void>

  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>

  // DECLARED BUT NEVER TRIGGERED in the current tree — inert. See "permission.ask" below.
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>

  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>

  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>

  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>

  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => Promise<void>

  "tool.definition"?: (
    input: { toolID: string },
    output: { description: string; parameters: any },
  ) => Promise<void>

  "experimental.chat.messages.transform"?: (
    input: {},
    output: { messages: { info: Message; parts: Part[] }[] },
  ) => Promise<void>

  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: { system: string[] },
  ) => Promise<void>

  "experimental.provider.small_model"?: (
    input: { provider: ProviderV2 },
    output: { model?: ModelV2 },
  ) => Promise<void>

  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>

  "experimental.compaction.autocontinue"?: (
    input: {
      sessionID: string
      agent: string
      model: Model
      provider: ProviderContext
      message: UserMessage
      overflow: boolean
    },
    output: { enabled: boolean },
  ) => Promise<void>

  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
}
```

Mutation contract: for two-arg hooks, **mutate `output` in place** to change
behavior. Reassigning the `output` param (`output = {...}`) does **nothing** — the
core returns the same object reference it handed you (`plugin/index.ts:298`).
Return values are **ignored everywhere except** `experimental.text.complete`, the
only hook whose return is read. `input` is read-only by convention (it is passed by
reference and not copied, so later hooks in the chain do see mutations — undocumented,
do not rely on it). The single-arg hooks (`event`, `config`, `dispose`) are
notification/setup hooks.

---

## Runtime semantics (dispatch, ordering, throw behavior)

These are not in the type surface but govern every hook. Source: the `trigger()`
core at `plugin/index.ts:286-299` and the per-hook call-sites.

### Dispatch contract

- **Sequential, awaited, in registration order.** `trigger()` iterates the hook
  array and `await`s each one fully before the next (`plugin/index.ts:293-296`).
  No concurrency. A slow hook blocks the gated operation.
- **Registration order = internal plugins first, then external in config order**
  (`plugin/index.ts:165-246`; loaded sequentially "so hook registration and
  execution order remains deterministic", comment at `:226-227`). There is **no
  priority API** — order is purely load order.
- **All plugins share ONE `output` object** per call. With N plugins defining the
  same hook, each sees the prior ones' mutations; **last-writer-wins per field**.
  No stop-propagation, no conflict resolution.

### Throw behavior is NOT uniform — it depends on the call-site, not on `trigger`

`trigger` uses `Effect.promise`, which does not catch; a thrown hook becomes a
defect whose fate is decided by the surrounding Effect boundary:

| Hook(s) | Throw outcome |
|---|---|
| `tool.execute.before`/`after` (native + MCP), `shell.env` (bash tool) | AI SDK `tool-error` → tool reported failed to the model, **turn survives**. De-facto veto. |
| `chat.message`, `chat.params`, `chat.headers`, `tool.definition`, `command.execute.before`, `*.transform` (main path), `experimental.text.complete`, **task** `tool.execute.before` | defect → `prompt.ts:139 Effect.catch(Effect.die)` → **hard crash of the request**. Never throw on bad input here. |
| `shell.env` (PTY site) | throw aborts PTY creation. |
| `experimental.session.compacting` / `compaction.autocontinue` / `*.transform` (compaction site) | throw propagates to the compaction caller (harder than a normal compaction stop). |
| `config`, `dispose` | throw **swallowed** (logged). |
| `event` | throw escapes into the listener fiber — no per-hook catch (the riskiest). Wrap the body in try/catch. |
| `provider.models` | throw propagates into provider init. |

### Firing cadence & hot-path warnings

| Hook | Where it fires / how often |
|---|---|
| `experimental.chat.messages.transform` | **per agentic step** (`prompt.ts:1408`) — many times per turn; also in compaction (`compaction.ts:360`). Keep it cheap. |
| `experimental.text.complete` | per completed text block (`processor.ts:813`) — possibly many per turn. The ONLY hook whose return is consumed. |
| `tool.definition` | per tool, per request (trigger at `registry.ts:336`), `concurrency:"unbounded"` (`registry.ts:356`) — different tools' chains interleave (one tool's chain is still ordered). |
| `shell.env` | 3 sites, **different input shapes**: PTY (`cwd` only, `pty-preparation.ts:16`), bash tool (`cwd,sessionID,callID`, `shell.ts:426`), `!`-shell-in-prompt (`cwd,sessionID,callID`, `prompt.ts:601`). |
| `experimental.chat.system.transform` | 2 sites: main path with `sessionID` (`request.ts:69`) AND `Agent.generate` with **no** `sessionID` (`agent/agent.ts:365`). |
| `experimental.compaction.autocontinue` | only on the auto + non-replay compaction path (`compaction.ts:476`); `input.overflow` flags hard size-limit overflow. |
| `experimental.provider.small_model` | only when `cfg.small_model` is unset (`provider.ts:1869,1880`). |

### Subagent / headless coverage

The full hook set fires **inside** subagent sessions (they run the same
`prompt`/`processor`/`session/tools` machinery) and in headless `opencode run`
(`cli/cmd/run.ts:787` → the same `prompt` route — no hook is TUI-gated).
Additionally, the **parent's** `tool.execute.before`/`after` fire for the `task`-tool
dispatch (`prompt.ts:340`/`:419`). So a tool guard filtering by `input.tool` double-
fires: once for the `task` dispatch in the parent, once per tool inside the subagent.
Most hook inputs carry no "is subagent" flag — only `chat.message` carries `agent`.

### `config` runs before providers are read

By design: `provider.ts:1342-1345` calls `plugin.list()` so the `config` hook has
already mutated `cfg` before the provider layer reads it. A `config` hook **can**
inject providers/models the provider layer then honors.

---

## Hook-by-hook

### `dispose`
- **Signature**: `() => Promise<void>`
- **Fires**: when the plugin is torn down (server shutdown / instance disposal).
- **Use**: flush buffers, close handles, cancel timers. No mutation surface.

### `event`
- **Signature**: `(input: { event: Event }) => Promise<void>`
- **Fires**: for every server event whose `location.directory` matches this instance's
  directory (`plugin/index.ts:259` filters the rest out). Discriminate on
  `input.event.type`; payload is `input.event.properties`. See `events.md` for the
  union, the runtime-vs-type gap, and which events the directory filter silently drops.
- **Use**: passive observation. Cannot mutate or block. **Wrap the body in try/catch** —
  this hook is fire-and-forget (`void`, not awaited) and a throw escapes into the
  listener fiber with no per-hook catch (the riskiest throw site of any hook).
```typescript
event: async ({ event }) => {
  if (event.type === "session.idle") {
    await client.app.log({ body: { service: "my-plugin", level: "info", message: `idle ${event.properties.sessionID}` } })
  }
}
```

### `config`
- **Signature**: `(input: Config) => Promise<void>`
- **Fires**: once on config load, **before providers are read** (`provider.ts:1342-1345`
  calls `plugin.list()` so `config` mutations land first). `Config` is the SDK config
  minus `plugin`, plus the typed `plugin` tuple array.
- **Use**: mutate `input` to inject defaults (providers, agents, keybinds) at startup.
  Because it runs before the provider layer reads `cfg`, a `config` hook **can** inject
  providers/models the provider layer then honors. A throw here is swallowed (logged).

### `tool`
- **Signature**: `{ [name: string]: ToolDefinition }`
- **Fires**: registers custom tools the model can call. A name matching a
  built-in **overrides** the built-in.
- **Use**: define tools with the `tool()` helper (see Custom tools below).

### `auth`
- **Signature**: `AuthHook` (see Auth section).
- **Use**: register OAuth or API-key auth flows for a custom provider.

### `provider`
- **Signature**: `ProviderHook = { id: string; models?: (provider: ProviderV2, ctx: { auth?: Auth }) => Promise<Record<string, ModelV2>> }`
- **Fires**: lets a plugin contribute/augment the model list for a provider id.
- **Use**: dynamically expose models (e.g. fetched from an API at startup).

### `chat.message`
- **Fires**: when a new user message is received, before processing.
- **Mutate `output.message` / `output.parts`** to rewrite or inject context into
  the incoming message. `input.model` may be undefined; `variant` distinguishes
  message variants.

### `chat.params`
- **Fires**: just before parameters are sent to the LLM.
- **Mutate `output`** to override sampling: `temperature`, `topP`, `topK`,
  `maxOutputTokens` (currently in the signature; may be `undefined` to defer to
  default), and provider-specific `options`.
```typescript
"chat.params": async (input, output) => {
  if (input.agent === "build") output.temperature = 0.1
}
```

### `chat.headers`
- **Fires**: before the LLM HTTP request; lets you set request headers.
- **Mutate `output.headers`** (e.g. inject a proxy/telemetry header). Same input
  context as `chat.params`.
- **Plugin headers WIN LAST** (`request.ts:177-191`): the final set is
  `{...opencode affinity/session headers, ...model.headers, ...your headers}`.
  Powerful and dangerous — you can clobber `x-opencode-session`, `User-Agent`,
  or auth-relevant headers. Spread carefully; do not replace the whole object.

### `permission.ask` (INERT — declared, never triggered)
- This hook is in the `Hooks` type (`index.ts:261`) but **no `plugin.trigger("permission.ask")`
  call-site exists anywhere** in `packages/opencode/src` (verified: `rg 'permission\.ask'`
  returns only the type decl). Permission flows through the `Permission.ask` *service*
  (`processor.ts:542`), not this hook. A `permission.ask` hook will **silently never fire** —
  do not rely on it. (Kept documented so authors who see it in the type know why it does nothing.)
- **To auto-approve / deny, use one of the two real mechanisms:**
  1. **Pre-emptive veto** — throw in `tool.execute.before`. Throwing fails just that tool call
     (turn survives, model sees a tool-error); see the throw-semantics table above.
  2. **Answer the live prompt** — listen for the `permission.asked` event and reply via the SDK:
```typescript
event: async ({ event }) => {
  if (event.type === "permission.asked") {
    const { sessionID, id } = event.properties // permission request id + session
    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionID, permissionID: id },
      body: { response: "once" }, // "once" | "always" | "reject"
    })
  }
}
```

### `command.execute.before`
- **Fires**: before a slash/custom command runs. `input.command` is the command
  name, `input.arguments` the raw arg string.
- **Mutate `output.parts`** to inject message parts the command will operate on.

### `tool.execute.before`
- **Fires**: before any tool runs — native (`tools.ts:91`), MCP (`tools.ts:132`), and
  the `task` tool dispatch (`prompt.ts:340`, `input.tool === "task"`).
- **Mutate `output.args`** to rewrite tool arguments. `output.args` **is** the object
  handed to `item.execute(args, ctx)` (`tools.ts:96`), so the tool observes the mutation.
- **Throwing** aborts as a `tool-error` (turn survives, model sees a failed tool) — a
  de-facto veto, NOT a session crash — EXCEPT on the `task` dispatch, where a before-throw
  is outside the catch and hard-crashes the request (see throw-semantics table).
```typescript
"tool.execute.before": async (input, output) => {
  if (input.tool === "bash" && /rm -rf \//.test(output.args.command)) {
    throw new Error("blocked dangerous command")
  }
}
```

### `shell.env`
- **Fires** at 3 sites with **different input shapes**: PTY creation (`cwd` only,
  `pty-preparation.ts:16`), the bash tool (`cwd,sessionID,callID`, `shell.ts:426`), and
  `!`-shell-in-prompt (`cwd,sessionID,callID`, `prompt.ts:601`). Check for `sessionID`
  before relying on it.
- **Mutate `output.env`** to inject or scrub env vars for spawned shells.
- **Precedence**: at the bash-tool site your env wins over `process.env`
  (`shell.ts:431-434`); at the PTY site `TERM`/`OPENCODE_TERMINAL` override your values
  (`pty-preparation.ts:17-23`).

### `tool.execute.after`
- **Fires**: after a tool finishes. `input.args` carries the (possibly rewritten)
  arguments — present in the current API.
- **Mutate `output`** (`title`, `output`, `metadata`) to rewrite the result the
  model and UI see (e.g. redact secrets, truncate, annotate).
- **MCP caveat**: for MCP tools the after-hook output is the **raw MCP result**
  (`tools.ts:150`), before conversion to text/attachments. Native and MCP paths
  differ in the shape you receive.

### `tool.definition`
- **Fires**: when tool schemas are assembled for the LLM. `input.toolID` is the
  tool name.
- **Mutate `output.description` / `output.parameters`** to rewrite how a tool is
  described or its JSON-schema params before the model sees them.
- **Undocumented seed field `jsonSchema`**: the type lists only `{description, parameters}`,
  but the runtime seeds `{description, parameters, jsonSchema}` (`registry.ts:331-335`).
  Selection logic (`registry.ts:337-340`): mutating `output.parameters` re-derives the
  schema and **drops** `jsonSchema`; mutating `output.jsonSchema` while leaving
  `parameters` identity unchanged injects a **raw JSON schema directly**. The `jsonSchema`
  path is the escape hatch the typed surface hides.

### `experimental.chat.messages.transform`
- **Fires**: as message history is prepared for the model, **per agentic step**
  (`prompt.ts:1408`, re-fires every loop iteration of one turn) and during compaction
  (`compaction.ts:360`). `input` is empty `{}` — **zero session/model context**, yet full
  power to rewrite the model's entire message view. Context-blindness is real; you cannot
  tell which session/agent/step you are in from this hook.
- **Mutate `output.messages`** (each `{ info: Message; parts: Part[] }`) to
  filter, reorder, or rewrite history (e.g. drop large tool outputs). Per-step firing
  means keep this cheap.

### `experimental.chat.system.transform`
- **Fires** at 2 sites: the main chat path with `sessionID` (`request.ts:69`) AND the
  `Agent.generate` path with **no** `sessionID` (`agent/agent.ts:365`, used when
  generating an agent definition, not a normal turn). `input.sessionID` being absent
  tells you which path you are on.
- **Mutate `output.system`** (array of system-prompt strings) to append/replace
  system instructions. Note: entry 0 (the header) is preserved specially on the main
  path — pushing extra entries works; the rest are re-collapsed (`request.ts:74-78`).

### `experimental.provider.small_model`
- **Fires**: when opencode selects the "small/fast" model for a provider (used for
  titles, summaries, cheap helper calls).
- **Mutate `output.model`** to override which `ModelV2` is used as the small model.

### `experimental.session.compacting`
- **Fires**: before session compaction starts.
- **Mutate `output.context`** (extra strings appended to the default prompt) or set
  `output.prompt` to fully replace the compaction prompt.

### `experimental.compaction.autocontinue`
- **Fires**: after compaction succeeds, before the synthetic "continue" user turn
  is added. `input.overflow` indicates compaction was triggered by context overflow.
- **Mutate `output.enabled`** (defaults `true`); set `false` to skip the synthetic
  auto-continue turn.

### `experimental.text.complete`
- **Fires**: after a text part completes. `input` identifies the part.
- **Mutate `output.text`** to post-process assistant text (e.g. link rewriting).

---

## Auth hook (full type)

```typescript
type Rule = { key: string; op: "eq" | "neq"; value: string }

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | { type: "text"; key: string; message: string; placeholder?: string
              validate?: (value: string) => string | undefined
              when?: Rule
              /** @deprecated use `when` */ condition?: (inputs: Record<string, string>) => boolean }
          | { type: "select"; key: string; message: string
              options: Array<{ label: string; value: string; hint?: string }>
              when?: Rule
              /** @deprecated use `when` */ condition?: (inputs: Record<string, string>) => boolean }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array</* same text|select prompt shape as above */>
        authorize?(inputs?: Record<string, string>): Promise<
          | { type: "success"; key: string; provider?: string; metadata?: Record<string, string> }
          | { type: "failed" }
        >
      }
  )[]
}

export type AuthOAuthResult = { url: string; instructions: string } & (
  | { method: "auto"; callback(): Promise<
        | ({ type: "success"; provider?: string } &
            ( { refresh: string; access: string; expires: number; accountId?: string; enterpriseUrl?: string }
            | { key: string; metadata?: Record<string, string> } ))
        | { type: "failed" }> }
  | { method: "code"; callback(code: string): Promise<
        | ({ type: "success"; provider?: string } &
            ( { refresh: string; access: string; expires: number; accountId?: string; enterpriseUrl?: string }
            | { key: string; metadata?: Record<string, string> } ))
        | { type: "failed" }> }
)
// `AuthOuathResult` (typo) is kept as a deprecated alias of `AuthOAuthResult`.
```

Notes vs older snapshots: prompts now use `when: Rule` (the `condition` callback is
deprecated); success results carry optional `metadata`, and OAuth tokens carry
optional `accountId` / `enterpriseUrl`.

---

## Custom tools (`tool()` helper)

Use the `tool()` helper from `@opencode-ai/plugin`. Args are declared with
`tool.schema.*` (re-exported zod), **not** raw zod imports and **not** a
`parameters` field. There is no `client.registerTool()` — that API does not exist.

```typescript
import { type Plugin, tool } from "@opencode-ai/plugin"

export const CustomToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      greet: tool({
        description: "Greet someone from the current directory",
        args: {
          name: tool.schema.string().describe("who to greet"),
          loud: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          // context: ToolContext { sessionID, messageID, agent, directory, worktree, abort, metadata(), ask() }
          const msg = `Hello ${args.name} from ${context.directory}`
          return args.loud ? msg.toUpperCase() : msg
        },
      }),
    },
  }
}
```

`ToolDefinition` is `ReturnType<typeof tool>`. `execute` returns a `ToolResult`:
a `string`, or `{ title?; output; metadata?; attachments? }`. The `ToolContext`
exposes `directory`/`worktree` (prefer over `process.cwd()`), an `abort` signal,
`metadata({ title?, metadata? })`, and `ask()` for in-tool permission requests.

`ask`'s real signature (`tool.ts:22-27`) and the attachment shape (`tool.ts:29-34`):

```typescript
ask(input: {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}): Promise<void>

type ToolAttachment = { type: "file"; mime: string; url: string; filename?: string }
```
