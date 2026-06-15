# pi-drawer-personas

Persistent agent personas for [pi](https://github.com/earendil-works/pi-coding-agent).
Activate a persona with the `$` prefix in the editor; its prompt is appended to the
system prompt on every turn until you deactivate it.

## Usage

| Input | Effect |
|-------|--------|
| `$` | Open the picker overlay (also `Alt+4`) |
| `$backend-go` | Activate the `backend-go` persona |
| `$backend-go fix the auth bug` | Activate it, then send "fix the auth bug" |
| `$off` / `$none` | Deactivate the current persona |
| `/personas` | List personas (`● ` marks the active one) |
| `/personas <id>` | Activate by id |
| `/personas off` / `none` | Deactivate |
| `/personas reload` | Re-scan persona files |

Prefix matching works for `$` activation: `$back` activates `backend-go` if it is the
only match. `$foo` with no matching persona is passed through as ordinary input.

A persona may pin a model and/or thinking level. The prior model + thinking level are
captured on activation and restored on deactivation. The active persona persists across
restarts and is replayed on session start.

## Persona files

YAML frontmatter + a Markdown body. Discovered from:

- `~/.pi/agent/agents/*.md` — user-global (honors `$PI_AGENT_DIR`)
- `.pi/agents/*.md` — project-local (overrides a user persona with the same id)

```markdown
---
name: Backend Engineer (Go)
description: Senior backend engineer for Go systems
model: claude-opus-4-6     # optional
thinking: high             # optional — off|minimal|low|medium|high|xhigh
---
You are a senior Go backend engineer. …
```

The file format is intentionally the same one pi's built-in agent resolver reads, so a
persona file works in both places.

## Interop

Emits `agent-persona:changed` on the cross-extension event bus on every
activation / deactivation / restore, with `{ agent: { id, name, source, model,
thinking } | null }`. The `tui-bars` extension consumes this event.

## Install

```jsonc
// settings.json
{ "packages": ["npm:pi-drawer-personas@0.1.0"] }
```

Or for local development, point `extensions` at the source entry:

```jsonc
{ "extensions": ["/abs/path/to/packages/pi/personas/src/index.ts"] }
```
