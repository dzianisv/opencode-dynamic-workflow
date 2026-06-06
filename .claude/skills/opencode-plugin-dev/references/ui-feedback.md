# UI Feedback Reference

> Surfacing status to the user from a plugin: toasts, persistent inline
> messages, and prompt manipulation. Variant/payload shapes are verified against
> `events.md` (`EventTuiToastShow`) and the v1 `client.tui.*` SDK surface in
> `packages/sdk/js/src/gen/sdk.gen.ts:1026-1143`. Trust `hooks.md` / `events.md`
> over any snapshot. This file = a **server** plugin nudging the TUI over RPC. A
> separate `./tui` plugin surface (own components, `default` export `{ id, tui }`)
> is loaded by the runtime (`plugin/shared.ts:285-301`; `server()` OR `tui()`, never
> both) — though the published `@opencode-ai/plugin` type still pins
> `PluginModule.tui?: never`. To build that surface, see `references/tui.md`; this
> file covers only the server-side `client.tui.*` RPC surface.

Three surfaces, in increasing weight:

1. **Toast** — ephemeral corner popup. Fire-and-forget, auto-dismisses, no history.
2. **Inline message** — persistent text in the chat transcript, excluded from LLM context.
3. **Prompt manipulation** — write into / submit / clear the user's input buffer.

All three are **TUI-only**. Under headless/CLI server runs they no-op or throw.
Wrap every call in try/catch; never let a UI side-effect break core logic.

---

## 1. Toasts — `client.tui.showToast`

```typescript
await client.tui.showToast({
  body: {
    title: "Optional heading",        // optional
    message: "Required message text",  // required
    variant: "success",                // "info" | "success" | "warning" | "error"
    duration: 4000,                    // optional, ms before auto-dismiss
  },
})
```

**Variants** (authoritative — matches the `EventTuiToastShow` payload):

| Variant   | Use for                                   | Visual         |
|-----------|-------------------------------------------|----------------|
| `info`    | Neutral notices, fallbacks                | Blue/neutral   |
| `success` | Confirmed completion                      | Green / check  |
| `warning` | Config issues, recoverable caution        | Yellow/orange  |
| `error`   | Failures, critical problems               | Red            |

> There is **no** `loading` or `default` variant. Snapshots that show those are
> wrong. The four above are the complete set in the current source.

Constraints: no buttons/inputs (non-interactive), keep to 1–3 lines, `\n` for
line breaks, no custom styling beyond the variant. May fail silently.

### Always guard the call

The TUI may not be attached (headless, web, server-only). A throw here must not
propagate:

```typescript
async function toast(
  client: any,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
  title?: string,
  duration?: number,
): Promise<void> {
  try {
    await client.tui.showToast({ body: { title, message, variant, duration } })
  } catch {
    // TUI not available — ignore
  }
}
```

### Don't block init with a startup toast

Firing a toast inside the plugin factory races the TUI before it has attached.
Defer it so the terminal is ready and init isn't blocked:

```typescript
export const ConfigPlugin: Plugin = async ({ client }) => {
  const config = loadConfig()
  if (config.hasErrors) {
    setTimeout(() => {
      toast(
        client,
        `${config.path}\n${config.errorMessage}\nFalling back to defaults`,
        "warning",
        "Plugin: invalid config",
        7000,
      )
    }, 2000) // let the TUI attach first
  }
  return { /* hooks */ }
}
```

### Toast on session lifecycle

`session.idle` is the reliable "turn finished" boundary (see `events.md`). Use it
instead of trailing `message.part.updated` events:

> **Forward-compat note**: `session.idle` is marked `// deprecated` in source
> (`packages/opencode/src/session/status.ts:42`). It still fires today and the v1
> `Event` union the hook is typed against has no successor, so keep using it — but
> expect a `session.status` / step-ended successor in a future major. Recipe stays
> valid for now.

```typescript
event: async ({ event }) => {
  if (event.type === "session.idle") {
    await toast(client, "Session completed", "success")
  }
  if (event.type === "session.error") {
    await toast(client, "Session encountered an error", "error", "Error")
  }
}
```

### Toast on model fallback (from `chat.params`)

`input.model` is a `Model` object (`providerID` / `id`). Compare against the
preference and notify on divergence:

```typescript
"chat.params": async (input, output) => {
  const preferred = getPreferredModel()
  if (preferred && input.model.id !== preferred.id) {
    await toast(
      client,
      `${preferred.provider}/${preferred.id} unavailable\nUsing ${input.model.providerID}/${input.model.id}`,
      "info",
      "Model fallback",
      5000,
    )
  }
}
```

---

## 2. Inline messages — `client.session.prompt` with `noReply`

For detail the user may want to scroll back to (stats, multi-line summaries),
push a message into the transcript that the LLM neither answers nor sees.

```typescript
await client.session.prompt({
  path: { id: sessionID },
  body: {
    noReply: true,        // do NOT trigger an assistant turn
    agent,                // optional — preserve current agent
    model,                // optional — preserve current model (see note)
    parts: [{ type: "text", text: message, ignored: true }],
  },
})
```

Two flags, both required for a status-only message:

| Flag            | Effect                                                          |
|-----------------|----------------------------------------------------------------|
| `noReply: true` | Suppresses the assistant response to this message              |
| `ignored: true` | Shows in the UI but is excluded from conversation context      |

> **Model/agent preservation gotcha**: omitting `model` lets opencode fall back to
> its default for that injected turn, which can silently flip the session's
> active model. If you inject mid-session, pass through the `agent`/`model` you
> captured from `chat.params` to avoid mutating session state. This is a known
> production footgun — the safest default is to forward what you captured.

### Capture session context first

`session.prompt` needs a `sessionID`. Capture session/agent/model from
`chat.params` (or `chat.message`), then reuse them from other hooks:

```typescript
export const StatusPlugin: Plugin = async ({ client }) => {
  let sessionID: string | null = null
  let agent: string | undefined
  let model: { providerID: string; modelID: string } | undefined

  async function status(text: string) {
    if (!sessionID) return
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { noReply: true, agent, model, parts: [{ type: "text", text, ignored: true }] },
      })
    } catch (e: any) {
      await client.app.log({ body: { service: "status-plugin", level: "warn", message: `inline status failed: ${e.message}` } })
    }
  }

  return {
    "chat.params": async (input) => {
      sessionID = input.sessionID
      agent = input.agent
      model = { providerID: input.model.providerID, modelID: input.model.id }
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") await status("▣ MyPlugin | session complete")
    },
  }
}
```

### Formatting conventions

- **Visual prefix** so plugin output is distinguishable from agent text:
  `▣` (status), `→` (list item), `─` (separator).
- **Multi-line** via an array joined on `\n`:
  ```typescript
  const message = [
    "▣ MyPlugin | Operation complete",
    "",
    "▣ Details:",
    "→ Files processed: 5",
    "→ Tokens saved: 1.2K",
    "→ Time: 230ms",
  ].join("\n")
  ```
- **Shorten paths** relative to `ctx.directory` and truncate to ~60 chars; plain
  text only, no markdown styling is rendered.

---

## 3. Prompt manipulation — `client.tui.*`

Write into or drive the user's input buffer. Useful for suggestions, quick-fill,
or scripted command execution.

```typescript
await client.tui.appendPrompt({ body: { text: "suggested text" } }) // insert into input
await client.tui.submitPrompt()                                      // submit current input
await client.tui.clearPrompt()                                       // clear the input buffer
await client.tui.executeCommand({ body: { command: "session.compact" } }) // run a TUI command
```

Other `client.tui.*` surfaces (open dialogs):
`openHelp()`, `openSessions()`, `openThemes()`, `openModels()`.

> The corresponding observation events exist in the `event` hook — `tui.prompt.append`,
> `tui.command.execute`, `tui.toast.show` (see `events.md`). They only fire under
> the TUI: in a headless `opencode run` no TUI emits them, so they never reach your
> `event` hook at all. Do not gate core logic on them.

---

## Choosing a surface

| Need                                          | Use            |
|-----------------------------------------------|----------------|
| Quick ephemeral alert / warning               | Toast          |
| Detailed multi-line status, referenceable     | Inline message |
| Confirmed-done signal at end of turn          | Toast on `session.idle` |
| Suggest text the user can edit before sending | `appendPrompt` |
| Drive a TUI command programmatically          | `executeCommand` |
| Diagnostics / debugging output                | **`client.app.log`** — never a toast, never `console.log` |

## When to notify vs stay silent

- **Notify** on: confirmed completion of long (>~1s) work, recoverable
  fallbacks the user should know about, and genuine errors.
- **Stay silent** on: routine per-step progress, anything high-frequency
  (toasts and inline messages both spam — collapse N steps into one summary),
  and internal diagnostics (those go to `client.app.log`, not the UI).
- **One summary beats many updates**: emit `"All 3 steps completed"` once, not
  three "step done" toasts.
- **Never** route logging/telemetry through toasts. Toasts are for the human;
  `client.app.log` is for the operator. Mixing them spams the user and loses logs.
