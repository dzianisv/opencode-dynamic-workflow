# Event Catalog Reference

> Generated from `@opencode-ai/sdk` (v1), then enriched against a local clone of
> `sst/opencode` at commit `4519a1da3`. 2026-06-06.
> Ground truth: `packages/sdk/js/src/gen/types.gen.ts` (the `Event` union) for the
> TYPE the hook is declared against; `packages/opencode/src/plugin/index.ts` and the
> `EventV2.define` registry under `packages/core/src` + `packages/opencode/src` for
> what the runtime actually delivers. `file:line` refs are into that clone.
> The plugin `event` hook imports `Event` from `@opencode-ai/sdk` (**v1**, not v2),
> so this v1 union is the *type* — but the runtime delivers MORE than the type knows
> (see "Runtime vs type gap" below). Trust this over snapshots.

Events reach a plugin through the `event` hook:

```typescript
event: async ({ event }) => {
  // event.type — discriminant string
  // event.properties — payload, narrowed by type
}
```

`event` is purely observational: you cannot mutate or block from it. To influence
behavior, use the mutation hooks in `hooks.md` (`tool.execute.*`, `chat.*`, etc.).
(Note: `permission.ask` is **not** one of them — it is declared but never triggered;
to act on permissions, throw in `tool.execute.before` or answer the `permission.asked`
event via the SDK. See `hooks.md`.)

## Union (32 members — v1 SDK type, NOT the runtime)

> This is the v1 SDK `Event` union the hook is **typed** against — 32 members, but
> 2 of them are **phantoms** the runtime never emits (`lsp.client.diagnostics`,
> `permission.updated` — see below). At runtime the hook receives ~88 distinct event
> types untyped (see "Runtime vs type gap"). Narrow by `event.type` string, not by
> relying on the union to be exhaustive.

```typescript
export type Event =
  | EventServerInstanceDisposed
  | EventInstallationUpdated
  | EventInstallationUpdateAvailable
  | EventLspClientDiagnostics
  | EventLspUpdated
  | EventMessageUpdated
  | EventMessageRemoved
  | EventMessagePartUpdated
  | EventMessagePartRemoved
  | EventPermissionUpdated
  | EventPermissionReplied
  | EventSessionStatus
  | EventSessionIdle
  | EventSessionCompacted
  | EventFileEdited
  | EventTodoUpdated
  | EventCommandExecuted
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionDeleted
  | EventSessionDiff
  | EventSessionError
  | EventFileWatcherUpdated
  | EventVcsBranchUpdated
  | EventTuiPromptAppend
  | EventTuiCommandExecute
  | EventTuiToastShow
  | EventPtyCreated
  | EventPtyUpdated
  | EventPtyExited
  | EventPtyDeleted
  | EventServerConnected
```

> Not in this v1 union (so the hook does not *type* them) yet **delivered at runtime**:
> `project.updated`, `mcp.tools.changed`, and ~50 more — see "Runtime vs type gap"
> below. They arrive as untyped `{id,type,properties}`; narrow by `event.type` string.
> (`global.disposed` is global-scoped and dropped by the directory filter — see below.)

## Quick reference

| `type` string | TS type | Payload (`properties`) | Typical use |
|---|---|---|---|
| `server.instance.disposed` | `EventServerInstanceDisposed` | `{ directory }` | Per-instance teardown cleanup |
| `installation.updated` | `EventInstallationUpdated` | `{ version }` | React to opencode self-update |
| `installation.update-available` | `EventInstallationUpdateAvailable` | `{ version }` | Notify user a newer build exists |
| `lsp.client.diagnostics` | `EventLspClientDiagnostics` | `{ serverID, path }` | **PHANTOM — no `EventV2.define` in source; never fires.** |
| `lsp.updated` | `EventLspUpdated` | `{ [key]: unknown }` | LSP state changed (opaque) |
| `message.updated` | `EventMessageUpdated` | `{ info: Message }` | Track full message lifecycle |
| `message.removed` | `EventMessageRemoved` | `{ sessionID, messageID }` | Clean up message-keyed state |
| `message.part.updated` | `EventMessagePartUpdated` | `{ part: Part; delta? }` | Stream tokens; watch tool parts |
| `message.part.removed` | `EventMessagePartRemoved` | `{ sessionID, messageID, partID }` | Drop part-keyed state |
| `permission.updated` | `EventPermissionUpdated` | `Permission` | **PHANTOM — no `EventV2.define`; never fires.** Use `permission.asked` (runtime, untyped). |
| `permission.replied` | `EventPermissionReplied` | `{ sessionID, permissionID, response }` | Audit allow/deny decisions (real) |
| `session.status` | `EventSessionStatus` | `{ sessionID, status: SessionStatus }` | Reflect busy/idle in UI |
| `session.idle` | `EventSessionIdle` | `{ sessionID }` | Run post-turn work (the "done" signal — still fires; `// deprecated` in source) |
| `session.compacted` | `EventSessionCompacted` | `{ sessionID }` | Reset context-size assumptions |
| `file.edited` | `EventFileEdited` | `{ file }` | Format/lint on edit, file watch |
| `todo.updated` | `EventTodoUpdated` | `{ sessionID, todos: Todo[] }` | Mirror agent todo list |
| `command.executed` | `EventCommandExecuted` | `{ name, sessionID, arguments, messageID }` | Telemetry on slash/custom commands |
| `session.created` | `EventSessionCreated` | `{ info: Session }` | Initialize per-session state |
| `session.updated` | `EventSessionUpdated` | `{ info: Session }` | Track title/metadata changes |
| `session.deleted` | `EventSessionDeleted` | `{ info: Session }` | Tear down per-session state |
| `session.diff` | `EventSessionDiff` | `{ sessionID, diff: FileDiff[] }` | Surface accumulated file changes |
| `session.error` | `EventSessionError` | `{ sessionID?; error? }` | Capture/report provider & runtime errors |
| `file.watcher.updated` | `EventFileWatcherUpdated` | `{ file, event: "add"\|"change"\|"unlink" }` | Watch external FS changes |
| `vcs.branch.updated` | `EventVcsBranchUpdated` | `{ branch? }` | React to git branch switches |
| `tui.prompt.append` | `EventTuiPromptAppend` | `{ text }` | Observe text appended to the prompt |
| `tui.command.execute` | `EventTuiCommandExecute` | `{ command }` | Hook TUI command invocations |
| `tui.toast.show` | `EventTuiToastShow` | `{ title?, message, variant, duration? }` | Mirror/forward toast notifications |
| `pty.created` | `EventPtyCreated` | `{ info: Pty }` | Track spawned pseudo-terminals |
| `pty.updated` | `EventPtyUpdated` | `{ info: Pty }` | Follow pty state |
| `pty.exited` | `EventPtyExited` | `{ id, exitCode }` | React to terminal process exit |
| `pty.deleted` | `EventPtyDeleted` | `{ id }` | Clean up pty-keyed state |
| `server.connected` | `EventServerConnected` | `{ [key]: unknown }` | First event after connect; bootstrap |

## Payloads in detail

```typescript
// --- lifecycle / install ---
type EventServerConnected      = { type: "server.connected";       properties: { [key: string]: unknown } }
type EventServerInstanceDisposed = { type: "server.instance.disposed"; properties: { directory: string } }
type EventInstallationUpdated  = { type: "installation.updated";   properties: { version: string } }
type EventInstallationUpdateAvailable = { type: "installation.update-available"; properties: { version: string } }

// --- lsp ---
type EventLspClientDiagnostics = { type: "lsp.client.diagnostics"; properties: { serverID: string; path: string } }
type EventLspUpdated           = { type: "lsp.updated";            properties: { [key: string]: unknown } }

// --- messages ---
type EventMessageUpdated     = { type: "message.updated";      properties: { info: Message } }
type EventMessageRemoved     = { type: "message.removed";      properties: { sessionID: string; messageID: string } }
type EventMessagePartUpdated = { type: "message.part.updated"; properties: { part: Part; delta?: string } }
type EventMessagePartRemoved = { type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }

// --- permission ---
type EventPermissionUpdated = { type: "permission.updated"; properties: Permission }
type EventPermissionReplied = { type: "permission.replied"; properties: { sessionID: string; permissionID: string; response: string } }

// --- session ---
type EventSessionStatus    = { type: "session.status";    properties: { sessionID: string; status: SessionStatus } }
type EventSessionIdle      = { type: "session.idle";      properties: { sessionID: string } }
type EventSessionCompacted = { type: "session.compacted"; properties: { sessionID: string } }
type EventSessionCreated   = { type: "session.created";   properties: { info: Session } }
type EventSessionUpdated   = { type: "session.updated";   properties: { info: Session } }
type EventSessionDeleted   = { type: "session.deleted";   properties: { info: Session } }
type EventSessionDiff      = { type: "session.diff";      properties: { sessionID: string; diff: Array<FileDiff> } }
type EventSessionError     = {
  type: "session.error"
  properties: {
    sessionID?: string
    error?: ProviderAuthError | UnknownError | MessageOutputLengthError | MessageAbortedError | ApiError
  }
}

// --- files / vcs / todo / command ---
type EventFileEdited        = { type: "file.edited";         properties: { file: string } }
type EventFileWatcherUpdated = { type: "file.watcher.updated"; properties: { file: string; event: "add" | "change" | "unlink" } }
type EventVcsBranchUpdated  = { type: "vcs.branch.updated";  properties: { branch?: string } }
type EventTodoUpdated       = { type: "todo.updated";        properties: { sessionID: string; todos: Array<Todo> } }
type EventCommandExecuted   = { type: "command.executed";    properties: { name: string; sessionID: string; arguments: string; messageID: string } }

// --- tui ---
type EventTuiPromptAppend  = { type: "tui.prompt.append";  properties: { text: string } }
type EventTuiCommandExecute = {
  type: "tui.command.execute"
  properties: {
    command:
      | "session.list" | "session.new" | "session.share" | "session.interrupt" | "session.compact"
      | "session.page.up" | "session.page.down" | "session.half.page.up" | "session.half.page.down"
      | "session.first" | "session.last" | "prompt.clear" | "prompt.submit" | "agent.cycle"
      | string
  }
}
type EventTuiToastShow = {
  type: "tui.toast.show"
  properties: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; duration?: number }
}

// --- pty ---
type EventPtyCreated = { type: "pty.created"; properties: { info: Pty } }
type EventPtyUpdated = { type: "pty.updated"; properties: { info: Pty } }
type EventPtyExited  = { type: "pty.exited";  properties: { id: string; exitCode: number } }
type EventPtyDeleted = { type: "pty.deleted"; properties: { id: string } }
```

## Runtime vs type gap (read before trusting the union)

The union above is the **v1 SDK type**. At runtime the `event` hook is wired to the
EventV2 bus and behaves differently from what the type implies. Three load-bearing facts,
verified against `packages/opencode/src/plugin/index.ts:258-264`:

- **`data` is renamed to `properties`.** EventV2 publishes a payload with a `data` field;
  the bridge re-emits it to the plugin as `properties` (`plugin/index.ts:262`:
  `properties: event.data`). So `event.properties` you read *is* the EventV2 `data`.
- **The runtime delivers ~88 event types; this union types only 32.** Events the runtime
  delivers but the v1 type does NOT know (arrive untyped — narrow by `event.type` string,
  or `as any`): the entire `session.next.*` family (~30: step/text/reasoning/tool/shell/
  compaction lifecycle + deltas), `account.*`, `question.*`, `permission.v2.*`,
  `catalog.model.updated`, `models-dev.refreshed`, `plugin.added`, `project.updated`,
  `mcp.tools.changed`, `mcp.browser.open.failed`, `workspace.*`, `worktree.*`,
  `ide.installed`, `global.disposed`, `message.part.delta`, `tui.session.select`.
- **Phantoms — in the type, never emitted.** `permission.updated` and
  `lsp.client.diagnostics` are v1-union members with **no `EventV2.define` anywhere in
  source** — they never reach the hook. Real permission events are `permission.asked` /
  `permission.replied` (`opencode/src/permission/index.ts:14-15`). Do not wait on the phantoms.

## The directory filter silently drops global events

The listener skips any event whose `location.directory !== ctx.directory`
(`plugin/index.ts:259`). Global-scoped events carry **no `location`**, so `undefined !==
ctx.directory` is always true and they **never reach the hook** despite `listen` being
global. Affected: `account.*`, `catalog.model.updated`, `models-dev.refreshed`,
`plugin.added`, `installation.*`, `global.disposed`. Consequence: "react to account switch /
model-catalog change" is **NOT feasible** from the `event` hook.

## Gotchas

- **Use `session.idle` as the "turn finished" signal**, not the last
  `message.part.updated`. Idle is the reliable post-turn boundary; part updates
  stream and reorder. Caveat: `session.idle` is marked `// deprecated` in source
  (`opencode/src/session/status.ts:42`). It **still fires** and the v1 union has no
  successor, so keep using it today — but expect a `session.status` / `session.next.step.ended`
  successor later (those are not in the v1 union the hook is typed against).
- **Per-token firehose to avoid.** A broad `event` listener gets hammered by
  `message.part.updated` (fires per part mutation, effectively per chunk during streaming,
  `session.ts:679`) and, if they reach the hook, the v2 `session.next.*.delta` family
  (text/reasoning/tool-input/compaction deltas — ephemeral, per-token). Filter early; do
  not do work per delta. This is *why* `session.idle` is the right boundary.
- **`server.connected` fires once on connect** with an opaque payload — good for
  one-time bootstrap that needs a live connection.
- **`session.error.error` is a union of several error shapes** (`ProviderAuthError`,
  `UnknownError`, `MessageOutputLengthError`, `MessageAbortedError`, `ApiError`) and
  both fields are optional — narrow before reading.
- **`message.part.updated` carries an optional `delta`** for streaming text; the
  `part` is the cumulative state.
- **Filtering subagent vs primary activity**: events do not carry a "subagent"
  flag. Correlate via the `Session.parentID` field (fetch the session by
  `sessionID` through `client`) to tell a child/subagent session from a root one.
- **`tui.*` events only fire under the TUI**, not for headless/CLI server runs;
  do not depend on them for core logic.
