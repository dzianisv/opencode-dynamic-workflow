# pi-drawer-handoff

Session context handoff for [pi](https://github.com/earendil-works/pi). Generate an
LLM-written summary of the current session, review/edit/approve it, and seed a fresh
session with that context. A navigable cross-session tree links every handoff to its
source and target session.

## Commands

| Command | What it does |
|---------|--------------|
| `/handoff` | Generate a handoff summary, review it in an overlay, optionally edit, approve, and start a new session seeded with the summary. |
| `/handoff-approved` | Approve a handoff left pending (e.g. you cancelled the review) and start the new session. |
| `/handoff-tree` | Navigate the handoff history tree across sessions; Enter opens the linked session. |
| `/handoff-view [id]` | View a handoff document read-only (by id, or the latest for the current session). |

**Shortcut:** `Ctrl+Shift+H` opens the handoff tree.

When a session starts with an unapproved handoff, a `📋 handoff pending` status
appears in the footer.

## How it works

1. `/handoff` waits for the agent to go idle, then asks the current model to write a
   structured markdown summary (goal, what was done, decisions, pending tasks, next
   steps, files involved) plus a JSON metadata block. Todo state, compaction
   summaries, and branch summaries from the session are folded into the prompt.
2. You review the summary in a scrollable overlay and either approve, edit (opens the
   editor), or cancel (saved as pending for later `/handoff-approved`).
3. On approval a new session is created with the summary injected as a
   `handoff-context` custom message plus a kickoff user message. The handoff record is
   linked (source → target) so the tree shows the lineage.

## Storage

Handoffs persist in SQLite at `~/.pi/agent/handoffs.db` via
[`bun:sqlite`](https://bun.sh/docs/api/sqlite) (drawers run under Bun — no native
addon, no build step). The path is intentionally the legacy location so existing
handoff history is preserved. A corrupt DB is backed up to `handoffs.db.corrupt.<ts>`
and recreated.

## Install

```jsonc
// settings.json
{
  "packages": ["npm:pi-drawer-handoff"]
}
```

Or dev-install from a checkout with `pi -e ./packages/pi/handoff/src/index.ts`.

## Notes

- Interactive-only: `/handoff`, `/handoff-tree`, and `/handoff-view` require TUI mode
  (they use `ctx.ui.custom()`, which is unsupported in rpc/json/print).
- Diagnostics are written to `~/.pi/agent/handoff.log`, never the console (which would
  corrupt pi's differential renderer).
