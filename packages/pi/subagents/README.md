# pi-drawer-subagents

The orchestration cluster for [pi](https://github.com/earendil-works/pi). It ships the
pieces that let a supervising session coordinate work across child pi sessions:

- **`/todo`** — a Claude-inspired, file-backed shared task board with dependencies,
  ownership, active forms, private/shared scope, and team namespaces. Includes the
  `todo` tool, the `/todo` and `/todo-clear` commands, and an `alt+t` board overlay
  that fuses live subagent activity from progress snapshots.
- **`/oracle`** — launch a deep-research subagent over the current codebase. Includes
  the `/oracle` command and an `alt+o` query overlay.

> The supervisor itself (`subagents.ts`) is added in a later step. Until it lands,
> `/oracle` emits its spawn request and times out after 5s — it is inert but
> well-behaved.

## Data layout

The task board and team registry live under `~/.pi/todos/`, **not** the pi-drawers
data dir — these are the user's live boards and the paths are deliberately preserved:

| File | Shape |
|------|-------|
| `~/.pi/todos/{projectKey}.json` | `{ version: 2, projectKey, projectRoot, nextId, tasks, updatedAt }` |
| `~/.pi/todos/{projectKey}.teams.json` | `{ version: 1, projectKey, projectRoot, teams, updatedAt }` |

`projectKey = ${sanitizedBasename}-${sha256(realpath(cwd)).slice(0,12)}`, with a
migration path from the legacy slash-flattened key. Concurrent supervisor + child
writes are serialized with an `O_EXCL` lockfile (25ms retry, 30s stale-force-remove,
4s timeout) and atomic `tmp + rename` writes.

Live subagent activity is read from `~/.pi/agents/*/progress.json` (written by the
supervisor). Diagnostics are appended to `~/.pi/agent/todo.log` — never the console,
which would corrupt pi's TUI renderer.

## Environment contract

- `PI_SUBAGENT_NAME` — actor name used when a subagent claims/owns a task.
- `PI_SUBAGENT_TEAM` — default team namespace for a subagent's tasks.

## Install

```json
{
  "packages": ["npm:pi-drawer-subagents@0.1.0"]
}
```

Or for local development, point `extensions` at the entry points:

```json
{
  "extensions": [
    "/path/to/drawers/packages/pi/subagents/src/todo.ts",
    "/path/to/drawers/packages/pi/subagents/src/oracle.ts"
  ]
}
```
