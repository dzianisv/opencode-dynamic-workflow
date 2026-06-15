# pi extension gotchas

> The production traps. Each is grounded in the pinned `pi-mono` snapshot; verify
> against the installed pi. Read before shipping.

## 1. The factory registers — it does not act

The default-export factory runs during **load**, before the runtime binds. Action
methods (`pi.sendMessage`, `pi.sendUserMessage`, `pi.appendEntry`, `ctx.*`) **throw**
`"Extension runtime not initialized. Action methods cannot be called during extension
loading."` there (`loader.ts:125-127`). Only registration is valid in the factory:
`on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`,
`registerMessageRenderer`, `registerProvider`/`unregisterProvider`.

```typescript
export default function (pi: ExtensionAPI) {
  // ❌ pi.sendMessage(...)               // throws — runtime not bound yet
  // ❌ const watcher = chokidar.watch()  // do NOT start background resources here either
  pi.on("session_start", async (_e, ctx) => {
    // ✅ now action methods work; start watchers/sockets/timers here
  })
}
```

**Background resources start in `session_start`, not the factory** — the factory may
run in an invocation that never opens a session (`pi --list-models`, install hooks).
Register an **idempotent** `session_shutdown` to tear them down.

The one async exception: an `async` factory's returned Promise is **awaited before
`session_start`, before `resources_discover`, and before queued `registerProvider()`
registrations flush.** That ordering is exactly what makes "discover remote models,
*then* `registerProvider`" safe in the factory instead of racing `session_start`. It is
still **registration-only** — action methods (`ctx.*`, `pi.sendMessage`, …) throw there.

## 2. Stale context after reload / session replacement

After `ctx.reload()`, `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()`, any
captured `pi` or command `ctx` is **stale and throws** (`runner.ts:510-524`):

```
"This extension ctx is stale after session replacement or reload."
```

- **reload:** `await ctx.reload(); return;` — treat as terminal. Code after it runs in
  the *old* frame against invalidated state.
- **replacement (new/fork/switch):** do post-switch work inside the `withSession(ctx =>
  …)` callback using **its** `ctx`. The callback runs after `session_shutdown` +
  rebind, so your own shutdown cleanup may already have run — capture only plain data
  (strings, ids) across the boundary, never a `SessionManager` or `ctx` reference.

```typescript
pi.registerCommand("handoff", { handler: async (_args, ctx) => {
  const kickoff = "Continue in the new session"          // ✅ plain string survives
  await ctx.newSession({ withSession: async (ctx) => {   // ✅ fresh ctx
    await ctx.sendUserMessage(kickoff)
  }})
}})
```

## 3. Tool errors are thrown, never returned

`execute` signals failure by **throwing**. A returned `{ isError: true }` is ignored.
The thrown error is caught, the result is marked `isError`, and it is reported to the
LLM so it can recover.

```typescript
async execute(_id, params) {
  if (!valid(params.x)) throw new Error(`bad input: ${params.x}`)   // ✅ sets isError
  return { content: [{ type: "text", text: "ok" }], details: {} }
}
```

## 4. `StringEnum`, not `Type.Union`/`Type.Literal`

For string-enum tool params use `StringEnum([...] as const)` from
`@earendil-works/pi-ai`. `Type.Union`/`Type.Literal` serialize in a way Google's API
rejects. Also: pi does not apply schema *defaults* to raw incoming values — coerce
defensively, and treat an omitted optional as possibly `undefined`.

## 5. Tools run in parallel — guard file mutations

Sibling tool calls from one assistant message run **concurrently** by default. Two
tools (yours + built-in `edit`, or two of yours) can read the same file and the last
write wins, silently losing the other. Wrap the **entire** read-modify-write on the
resolved absolute path in `withFileMutationQueue()` so it shares the per-file queue
with built-in `edit`/`write`:

```typescript
const abs = resolve(ctx.cwd, params.path)
return withFileMutationQueue(abs, async () => { /* read → modify → write */ })
```

**Invariant for cross-tool guard policies.** Sibling tool calls from one assistant
message are **preflighted per-call, then executed concurrently**. So in `tool_call`,
`ctx.sessionManager` is synced *through the current assistant message* but is **not**
guaranteed to include the *results* of sibling calls in that same message. Do not write
a `tool_call` policy that reasons about "what did the sibling `edit`/`bash` just
produce?" — those results may not exist yet. Guard on the call's own args and on prior
*turns*, not on uncommitted siblings.

## 6. Always truncate tool output

Unbounded output overflows context, breaks compaction, and degrades the model. The
built-in budget is ~**50KB / 2000 lines** (`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`).
Use `truncateHead` (file reads, search — beginning matters) or `truncateTail` (logs,
command output — end matters), and tell the model where the full output went.

## 7. `ctx.signal` is often `undefined`

It is defined during active-turn events (`tool_call`, `tool_result`, `message_update`,
`turn_end`) and `undefined` in idle/non-turn contexts (session events, shortcuts fired
while idle, commands while idle). Guard before threading it into `fetch`/model calls,
and pass it through so Esc can cancel your async work.

## 8. Mode / hasUI guards

| | `tui` | `rpc` | `json` | `print` (`-p`) |
|--|--|--|--|--|
| `ctx.hasUI` | true | true | false | false |
| dialogs (`select`/`confirm`/`input`/`editor`) | ✅ | ✅ (JSON protocol) | no-op | no-op |
| `ctx.ui.custom()` / terminal input / `setEditorComponent` | ✅ | **unsupported, resolves `undefined`** / no-op | no-op | no-op |
| fire-and-forget (`notify`/`setStatus`/`setWidget`/`setTitle`) | ✅ | ✅ | no-op | no-op |

Guard real-TUI features with `ctx.mode === "tui"`; guard dialogs whose result drives
control flow with `ctx.hasUI` (and provide a non-interactive fallback — e.g. block by
default when you cannot confirm).

**The `custom()` trap is silent.** In RPC mode `ctx.ui.custom()` is implemented as
unsupported and resolves to `undefined` — but its declared type is `Promise<T>`, so
TypeScript hands you a `T` you never got, with no error. A custom tool that `await`s
`ctx.ui.custom()` without an `if (!ctx.hasUI)` branch keeps running on a bogus value.
The rule: gate interactive UI behind `if (!ctx.hasUI) { … }`, and inside a **custom
tool** the fallback must still **return valid tool content** (text the LLM can use) —
never `await` a prompt that will never resolve.

## 9. Session-control methods are command-only

`waitForIdle`, `newSession`, `fork`, `switchSession`, `navigateTree`, `reload` live on
`ExtensionCommandContext` (command handlers), not `ExtensionContext` (event handlers) —
calling them from an event handler can deadlock. To let the model trigger one, expose
a tool that queues the command: `pi.sendUserMessage("/my-command", { deliverAs: "followUp" })`.

## 10. The "turn finished" boundary

`message_update` streams and the parts reorder; do not treat the last one as "done".
Use `turn_end` (one LLM response + its tools) or `agent_end` (the whole prompt) as the
reliable boundary.

## 11. State + branching

In-memory state is lost on `/reload` and diverges across `/tree` branches. Store
durable state in the tool result's `details`, and **reconstruct** it on `session_start`
*and* `session_tree` by walking `ctx.sessionManager.getBranch()` for your tool's results.
(`pi.appendEntry` persists non-LLM-visible state the same way.)

## 12. The model sometimes prefixes paths with `@`

Built-in tools strip a leading `@` before resolving a path. If your tool takes a path,
normalize `@foo` → `foo` too.

## 13. `before_provider_request` edits are invisible to `getSystemPrompt()`

`getSystemPrompt()` returns pi's *system-prompt string*, not the serialized provider
payload. If you rewrite system instructions at the payload level in
`before_provider_request`, `getSystemPrompt()` will not reflect it. Likewise, later-
loaded extensions can still change what is ultimately sent after your handler runs.

## 14. Never `console.log` while a TUI is mounted

This is the single most common cause of "my extension breaks the TUI". The TUI is a
**differential renderer**: it owns the screen and diffs each frame against an internal
model of the terminal. A raw write to stdout/stderr — `console.log`/`error`/`warn`,
`process.stdout.write`, a chatty library — lands **mid-frame**, desyncs that model, and
every subsequent diff is computed against a wrong baseline. Result: garbled output,
ghost lines, a misplaced cursor. It applies to **all** extension code that can run
under a live TUI: hooks, tools, renderers, providers, command handlers.

- Surface user-facing text via `ctx.ui.notify(...)` / `ctx.ui.setStatus(...)` (§8).
- Route diagnostics to a **file sink** (see §15).
- Guard any unavoidable stdout debug behind `if (!ctx.hasUI)` — RPC / `json` / `print`
  modes don't own the screen, so stdout is free there.

## 15. There is no centralized logger — bring a file sink

Upstream oh-my-pi tells engine devs to `import { logger } from "@oh-my-pi/pi-utils"`
(writes to `~/.omp/logs`). **That module does not exist in our SDK** —
`@earendil-works/pi-coding-agent`'s barrel exports no logger, and `@oh-my-pi/pi-utils`
is not a dependency. Don't reach for it; it won't resolve. Bring your own
**file-based** sink — append with `node:fs` to a file under the agent data dir:

```typescript
import { appendFileSync } from "node:fs"
const log = (msg: string) => appendFileSync(`${process.env.HOME}/.pi/agent/my-ext.log`,
  `${new Date().toISOString()} ${msg}\n`)
```

The invariant that transfers verbatim from upstream is the **destination, not the
API**: logs go to a file, **never** the console while a TUI is mounted (§14).

## 16. Sanitize every render path — especially error branches

Two things corrupt a renderer: **tabs** (break width math — the renderer measures
columns, a `\t` is one char but many columns) and **absolute home paths** (leak the
user's home dir into the UI). pi has `replaceTabs()` and `shortenPath()` in
`dist/core/tools/render-utils`, but **they are not re-exported from the public barrel
on 0.79.x** — do them by hand:

```typescript
import os from "node:os"
import { truncateToWidth } from "@earendil-works/pi-tui"   // width-safe truncation lives in pi-tui

const tabSafe = text.replace(/\t/g, "  ")                  // tabs → spaces BEFORE measuring/truncating
const line    = truncateToWidth(tabSafe, width)            // then truncate by visible width
const shown   = abs.startsWith(os.homedir())               // collapse home for displayed paths
  ? "~" + abs.slice(os.homedir().length) : abs
```

Apply the **full** sanitization (tab-replace → `truncateToWidth` → home-collapse) to
**every** branch a renderer can take: file previews, command output, search results,
**both added and removed diff lines**, streaming previews, **and error messages**.
Error strings are the most-forgotten and most-dangerous path — failure messages
frequently embed raw file content (e.g. a patch-apply failure echoing unmatched source
lines), so an unsanitized `catch` branch corrupts the display exactly when the user is
debugging. (The width-safety / same-array-reference / per-line-reset mechanics live in
`ui.md` — this section is only about *which branches* you must cover.)

## 17. Streaming previews have two render paths — fix both

A tool-call preview is rendered along **two independent paths**, and fixing one does
not fix the other:

1. **Live stream** — `renderCall(args, theme, ctx)` while `ctx.isPartial` is true and
   args may be incomplete (`ctx.argsComplete === false`).
2. **Rebuilt transcript** — the same `renderCall` replayed from a finalized session:
   scrollback, branch/fork, session reload. Here a result exists and args are complete.

A `renderCall` that only works once a result exists, or that assumes fully-parsed args,
shows a correct live preview and a broken/empty rebuilt one (or vice versa). Make
`renderCall` produce a sane preview **from `args` + `ctx` alone, before any result**,
and verify both paths.

Sharp edge: parsed `arguments` only materialize once a JSON object **closes**, so a
preview built solely from parsed args appears **empty until the stream ends** (the bash
inline-env-assignment case is the classic). For an immediate live preview, render
progressively from what's available (gate on `ctx.argsComplete` / `ctx.isPartial`) or
show a stable placeholder — don't block on fully-parsed args.

## 18. Why custom transcript content freezes or vanishes

Native scrollback is **append-only**. Once a row scrolls above the visible window it is
committed to history, and the engine will **never** rewrite it — it can't observe scroll
position, so history is strictly append-only. Two consequences for `MessageRenderer`
authors:

- A custom transcript block that keeps **mutating** after the engine commits it
  **freezes** — the stale snapshot is what lands in scrollback.
- A block **taller than the window** that keeps rewriting an interior row can be
  committed nowhere and repainted nowhere → **silent content loss**.

So: mutable/animated UI must live in a **widget / footer / status / working-indicator**
(the live-region seam the engine repaints in place — see `ui.md`), **not** in a
transcript message. Keep streaming blocks short, or **finalize** completed sub-sections
so their rows stop mutating before they scroll off. This is also why **widget height
should stay stable** (reserve fixed rows, pad with blanks): variable-height live content
interacts badly with per-resize-step window math and can duplicate rows on resize.

## 19. Don't write per-terminal or per-platform rendering branches

Correctness no longer depends on terminal brand or win32-vs-POSIX — the old viewport
probes and platform forks were deliberately removed; env sniffing now only selects
*cosmetic* optimizations. If a widget looks wrong on one terminal, the bug is almost
certainly **naive width math or unstable height** (§16, §18), not a terminal to
special-case.

- **Full-screen clears fire only on explicit gestures** — resize, session-replace, and
  Ctrl+L. Ordinary frames never clear the screen or home the cursor, so do **not**
  architect a widget that assumes a top-of-screen repaint each frame.
- **On resize the engine erases and replays history at the new geometry** (the ledger
  restarts). Width-keyed caches handle this automatically — a cache miss recomputes.
- For widgets that only make sense at a given width, gate with
  `overlayOptions.visible: (w, h) => w >= 80` rather than rendering cramped.

## 20. Conflicts are reported at load, not swallowed

Registration collisions surface as **startup diagnostics**, they don't fail silently:

- **Duplicate command names across extensions** get numeric suffixes — `/name:1`,
  `/name:2` — assigned in load order.
- A command/tool name **colliding with a built-in** emits a diagnostic/warning rather
  than failing the load.

So when a command "doesn't show up" or "shows up renamed" (`/review` → `/review:2`),
check pi's **startup diagnostics first** before assuming a registration bug.
