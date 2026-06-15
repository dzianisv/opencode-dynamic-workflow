# pi-drawer-tui-bars

A two-line custom footer for [pi](https://pi.dev). Replaces the built-in footer
with a dense status bar: repo, active persona, an auto-generated session name,
model + thinking level, token usage, cost, context %, and the git branch.

```
 my-repo ◆ architect            refactor auth tokens                  main
 claude-haiku-4-5 · high   ↑12.4k ↓3.1k ⚡88.0k $0.042                    37%
```

## Layout

| | Left | Center | Right |
|---|---|---|---|
| **Line 1** | repo name + `◆ persona` | session name | git branch |
| **Line 2** | model + thinking level | `↑in ↓out ⚡cacheRead $cost` | context % |

## Session naming

The session name is generated **once per session** from your first prompt, via a
fire-and-forget [`complete()`](https://pi.dev) call to `claude-haiku-4-5` (using
the session's own API credentials). It is fully guarded — if the model, key, or
call is unavailable, the footer simply shows no name.

| Key | Action |
|---|---|
| `ctrl+shift+r` | rename the session (empty input clears the name **and** disables auto-naming) |

A manual name is persisted to the session (`appendEntry`) and restored on reload.

## Personas

The footer shows the active persona (`◆ name`) by listening for the
`agent-persona:changed` cross-extension event. That requires the **personas**
extension to be installed and emitting it; without it the persona tag is simply
never shown — everything else still works.

## Mutually exclusive with the statusline

`setFooter` **replaces pi's entire footer**, so this package and
`pi-drawer-statusline` (which sets a footer *status segment* via `setStatus`)
cannot both render — pick one. tui-bars surfaces the statusline's information and
more, in two lines.

## How it works

Git facts (`rev-parse`) are read with async `pi.exec` so the render thread never
blocks. The footer factory follows pi's component render contract: width-safe
(`visibleWidth` / `truncateToWidth`), every value sanitized of ANSI / control /
bidi characters before display, and the render path never throws — on any error
it degrades to the repo name. Token/cost stats are cached and only recomputed
when the active branch changes. No file mutation; the only persisted state is the
session name.

## Install

`pi install <path-to-this-package>` (a local path references it in place — repo
edits reflect live), or add it to the `packages` array in pi's `settings.json`.

Built with the **`pi-plugin-dev`** skill at
[`.claude/skills/pi-plugin-dev/`](../../../.claude/skills/pi-plugin-dev/SKILL.md).
