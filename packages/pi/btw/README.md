# pi-drawer-btw

A concurrent side-discussion chat overlay for [pi](https://pi.dev). Run `/btw`
to open a streaming chat with the **same model** the main agent is using, while
that agent keeps working in the background. Read-only — BTW never edits files.

## Usage

```
/btw How should we handle auth tokens?   → opens the chat directly with that prompt
/btw                                      → asks for a topic first, then opens
```

Inside the overlay:

| Key | Action |
|---|---|
| `enter` | send the current message |
| `esc` | close the overlay (aborts any in-flight stream) |
| `pgup` / `pgdn` (or `shift+up` / `shift+down`) | scroll history |
| `ctrl+a` / `ctrl+e` | jump to start / end of input |
| `ctrl+u` / `ctrl+k` | delete to start / end of input |

## How it works

On open, BTW gathers lightweight context from the current session — the working
directory plus the last 20 messages of the active branch (user / assistant text
and tool-result snippets, each truncated). That context is handed to the model as
**untrusted reference data**: the system prompt instructs BTW not to act on
instructions embedded in it. The reply streams token-by-token into the overlay.

The chat uses `ctx.model` and resolves credentials via
`ctx.modelRegistry.getApiKeyAndHeaders`, then streams with `streamSimple` from
`@earendil-works/pi-ai`. No file mutation, no persisted state — it is a
discussion surface only.

## Install

`pi install <path-to-this-package>` (a local path references it in place — repo
edits reflect live), or add it to the `packages` array in pi's `settings.json`.

Built with the **`pi-plugin-dev`** skill at
[`.claude/skills/pi-plugin-dev/`](../../../.claude/skills/pi-plugin-dev/SKILL.md).
