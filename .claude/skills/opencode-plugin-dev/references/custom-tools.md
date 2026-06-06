# Custom Tools Reference

> Conforms to `hooks.md` ground truth (`@opencode-ai/plugin` `tool.ts`,
> `sst/opencode@dev`, 2026-06-06). Trust `hooks.md` over any snapshot, including
> this one if they ever diverge.

Custom tools are functions the model can call by name. You register them under
the `tool` hook of the object your plugin returns. Each tool is built with the
`tool()` helper.

## The `tool()` helper

Import it from `@opencode-ai/plugin`. Do **not** import `zod` directly and do
**not** look for `client.registerTool()` — that function does not exist.

```typescript
import { type Plugin, tool } from "@opencode-ai/plugin"
```

`tool()` takes three fields:

| Field | Type | Notes |
|---|---|---|
| `description` | `string` | What the tool does. The model reads this to decide when to call it — write it for the model, not for humans. |
| `args` | `z.ZodRawShape` | A plain object mapping arg names to schemas built with `tool.schema.*`. |
| `execute` | `(args, context) => Promise<ToolResult>` | The implementation. `args` is fully typed from your schema. |

`tool.schema` **is** zod, re-exported. So `tool.schema.string()`,
`tool.schema.number()`, `tool.schema.enum([...])`, `.optional()`, `.default()`,
`.describe()` are all the usual zod methods. Use `.describe()` liberally — that
text becomes the parameter hint the model sees.

Two source facts behind this (`tool.ts:50,52`): `tool()` is an **identity
helper** — it returns its input object unchanged. It exists only so TypeScript can
infer `args` → the `execute(args, ...)` parameter type; it does no runtime work.
And `tool.schema = z` is literally the **whole zod module** re-hung on the
function. The consequence: the zod *version* is pinned by `@opencode-ai/plugin`'s
catalog dep, and your plugin inherits it — do not install your own `zod` expecting
a different version to interop.

```typescript
export const GreetPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      greet: tool({
        description: "Greet a person, optionally shouting",
        args: {
          name: tool.schema.string().describe("who to greet"),
          loud: tool.schema.boolean().optional().describe("uppercase the result"),
        },
        async execute(args, context) {
          const msg = `Hello ${args.name} from ${context.directory}`
          return args.loud ? msg.toUpperCase() : msg
        },
      }),
    },
  }
}
```

`ToolDefinition` is exactly `ReturnType<typeof tool>`. You rarely need to name
it, but it is what the `tool` hook expects as values.

## `args` via `tool.schema.*`

Common patterns:

```typescript
args: {
  url:    tool.schema.string().url().describe("valid URL"),
  count:  tool.schema.number().min(1).max(100).default(10),
  mode:   tool.schema.enum(["fast", "thorough"]).default("fast"),
  tags:   tool.schema.array(tool.schema.string()).optional(),
  opts:   tool.schema.object({ retries: tool.schema.number() }).optional(),
}
```

- An empty object `args: {}` is valid for a no-argument tool.
- `.optional()` makes the arg `T | undefined`; `.default(v)` makes it required
  in the schema but auto-filled when omitted. Prefer `.default()` when a sane
  default exists — it removes a decision from the model.
- The shape is `z.ZodRawShape` — a flat record of schemas. opencode wraps it in
  a `z.ZodObject` for you. Do not pass a pre-built `z.object(...)`.

## `execute(args, context)` and `ToolContext`

`args` is `z.infer` of your schema — fully typed, already validated. The second
argument is the `ToolContext`:

```typescript
type ToolContext = {
  sessionID: string                 // session this call belongs to
  messageID: string                 // the assistant message that issued the call
  agent: string                     // agent name that invoked the tool
  directory: string                 // session cwd — prefer over process.cwd()
  worktree: string                  // git worktree root
  abort: AbortSignal                // fires when the user cancels the turn
  metadata(input: { title?: string; metadata?: any }): void  // set live title/metadata
  ask(...): Promise<...>            // request a permission mid-execution
}
```

Notes that matter:

- **`directory` / `worktree`** are the correct way to resolve paths. Reading
  `process.cwd()` is wrong — the server's cwd is not the user's project cwd.
- **`abort`** is a real `AbortSignal`. Forward it to `fetch`, child processes,
  and long loops so cancellation actually cancels:
  ```typescript
  async execute(args, ctx) {
    const res = await fetch(args.url, { signal: ctx.abort })
    return await res.text()
  }
  ```
- **`metadata({ title })`** updates what the UI shows for an in-progress call —
  useful for long tools ("Fetching page 3/10").
- **`ask()`** lets a tool request permission while running, rather than blocking
  at the start. Use it when permission depends on a value you only learn at
  runtime.

`ctx` (the plugin-level `PluginInput`) is in closure scope, so you can use
`ctx.client`, `ctx.$`, etc. inside `execute`. The two are distinct: `ctx` is the
plugin environment, `context` is per-call.

## Return value: `ToolResult`

`execute` may return either:

- a `string` — used directly as the tool output, or
- an object `{ title?; output; metadata?; attachments? }` for richer results:

```typescript
async execute(args) {
  return {
    title: `Read ${args.path}`,
    output: await Bun.file(args.path).text(),
    metadata: { bytes: 1234 },
  }
}
```

The older snapshot claiming `execute` returns only `Promise<string>` is stale —
the object form is supported.

`attachments` (undocumented upstream) is `ToolAttachment[]`, each entry
(`tool.ts:29-34`):

```typescript
type ToolAttachment = {
  type: "file"       // only "file" today
  mime: string       // e.g. "image/png", "application/pdf"
  url: string        // where the file lives (data: URI or resolvable URL)
  filename?: string
}
```

Use it to hand the model a file alongside the text output (e.g. a generated image
or report) rather than inlining bytes into `output`.

## Multiple tools and tool naming

The `tool` hook is a record, so export as many as you want. The **key** is the
tool name the model calls:

```typescript
return {
  tool: {
    "db.query":  tool({ /* ... */ }),
    "db.migrate": tool({ /* ... */ }),
    listFiles:    tool({ /* ... */ }),
  },
}
```

- The key is the canonical name — the model sees and invokes exactly that
  string. Pick names that are unambiguous in a crowded tool list.
- **A custom tool whose name matches a built-in overrides the built-in.** This
  is deliberate (e.g. wrap `bash` with policy) but easy to do by accident — do
  not name a tool `read`, `write`, `bash`, `grep`, etc. unless you mean to
  shadow it. The resolution rule is **last-writer-wins by name**: plugins
  register internal-first, then in config order (same order hooks fire — see
  `hooks.md`), so a *later* plugin can also shadow an *earlier* plugin's tool of
  the same name, not just shadow a built-in.
- Namespacing with a prefix (`db.`, `myco.`) keeps your tools grouped and avoids
  collisions across plugins.

## Error handling

Two strategies, pick per tool:

1. **Throw** to signal a hard failure. opencode surfaces the error to the model,
   which can react (retry, change approach). Prefer this for genuinely
   exceptional conditions.
2. **Return an error string** when the failure is an expected outcome the model
   should reason over (e.g. "no results found"), not a crash.

```typescript
async execute(args, ctx) {
  if (ctx.abort.aborted) throw new Error("cancelled")
  try {
    const r = await ctx.$`some-command ${args.input}`
    return r.text()
  } catch (e) {
    // expected, recoverable: hand the model a message instead of crashing
    return `command failed: ${e instanceof Error ? e.message : String(e)}`
  }
}
```

Do not swallow errors silently and return a fake success — that makes the model
believe a failed action worked. Either throw or return an honest error string.

Never `console.log` inside a tool. It corrupts the TUI render and the JSON-RPC
stream. Route diagnostics through `ctx.client.app.log` (body-wrapped — see
`hooks.md`).

## When a custom tool beats a hook

| Use a **custom tool** when | Use a **hook** when |
|---|---|
| You want to give the model a **new capability** it can choose to invoke. | You want to **observe or modify** existing behavior the model already does. |
| The action has explicit inputs the model fills in (`args`). | You react to events/tool calls you do not initiate. |
| The model should decide *when* to run it. | The behavior must happen *every time* a condition occurs, regardless of model intent. |
| Example: "fetch this URL", "run this query". | Example: redact secrets from any tool output (`tool.execute.after`), block dangerous bash (`tool.execute.before` — throw to veto). |

Rule of thumb: a tool is a verb the model can call; a hook is a rule the runtime
enforces. If you find yourself adding a tool the model "should always use before
X", you probably want a hook instead.

## Recipe: tool that messages its own session

`execute` has `context.sessionID`, so a tool can post into its session via the
client:

```typescript
sendPrompt: tool({
  description: "Send a follow-up prompt to the current session",
  args: { text: tool.schema.string().describe("text to send") },
  async execute(args, context) {
    await ctx.client.session.prompt({
      path: { id: context.sessionID },
      body: { noReply: true, parts: [{ type: "text", text: args.text }] },
    })
    return "sent"
  },
}),
```
