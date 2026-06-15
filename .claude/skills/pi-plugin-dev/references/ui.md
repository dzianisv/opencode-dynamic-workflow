# pi extension UI

> `ctx.ui` (an `ExtensionUIContext`, `types.ts:124-275`) is the whole user-interaction
> surface — dialogs, notifications, status/widgets/footer/header, fully custom
> components and overlays, a custom editor, and theming. Components come from
> `@earendil-works/pi-tui`. Upstream component doc: `packages/coding-agent/docs/tui.md`.

**Always guard:** `ctx.ui.custom()` / terminal input only work when `ctx.mode === "tui"`;
dialogs need `ctx.hasUI`; in `print`/`json` everything is a no-op. See `gotchas.md` §8.

## Dialogs (await a result)

```typescript
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"])   // string | undefined
const ok     = await ctx.ui.confirm("Delete?", "Cannot be undone")  // boolean
const name   = await ctx.ui.input("Name:", "placeholder")           // string | undefined
const body   = await ctx.ui.editor("Edit:", "prefill")              // string | undefined (multi-line)
ctx.ui.notify("Done!", "info")                                      // "info" | "warning" | "error" (non-blocking)
```

**Timeout / cancel:** dialogs accept `{ timeout, signal }`. On timeout `select`/`input`
return `undefined`, `confirm` returns `false`. Use an `AbortController` to tell "timed
out" from "user cancelled" (check `signal.aborted`).

## Status, widgets, footer, header

```typescript
ctx.ui.setStatus("my-ext", "Processing…")          // footer status; undefined clears
ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"])   // above editor; { placement: "belowEditor" } | undefined clears
ctx.ui.setWidget("my-ext", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0))
ctx.ui.setFooter((tui, theme, footerData) => ({ render: (w) => [theme.fg("dim", "footer")], invalidate() {} }))  // undefined restores
ctx.ui.setHeader((tui, theme) => /* Component */)  // undefined restores
ctx.ui.setTitle("pi — my-project")                 // terminal title
ctx.ui.setEditorText("prefill") ; ctx.ui.getEditorText() ; ctx.ui.pasteToEditor("…")

// streaming "working" row:
ctx.ui.setWorkingMessage("Thinking deeply…")        // undefined restores default
ctx.ui.setWorkingVisible(false)                     // hide the row entirely
ctx.ui.setWorkingIndicator({ frames: [theme.fg("accent", "●")], intervalMs: 120 })  // undefined restores spinner

// tool output expansion:
const was = ctx.ui.getToolsExpanded(); ctx.ui.setToolsExpanded(true)
```

Indicator frames are rendered verbatim — colorize them yourself with `ctx.ui.theme.fg(...)`.

## Custom components — `ctx.ui.custom()`

Temporarily replaces the editor with your component until `done(value)` is called;
the promise resolves to that value (TUI mode only — returns `undefined` elsewhere).

```typescript
import { Text, matchesKey, Key } from "@earendil-works/pi-tui"

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const t = new Text("Enter = ok, Esc = cancel", 1, 1)
  t.handleInput = (data) => {
    if (matchesKey(data, "return")) done(true)
    else if (keybindings.matches(data, "app.interrupt")) done(false)
  }
  return t
})
```

Callback args: `tui` (dimensions/focus + `requestRender()`), `theme`, `keybindings`
(use the injected manager — don't call `getKeybindings()`), `done(value)`. Detect keys
with `matchesKey(data, Key.up)` or `keybindings.matches(data, "app.interrupt")`, not
hardcoded escape strings.

**`done()` lifecycle — exactly once.** `done(value)` is the only thing that resolves
the awaited promise, disposes the component, and restores focus to the editor.
Never-calling it hangs the command with the UI stuck mounted; calling it twice risks
acting on a disposed component. Because closing **disposes** the component, never stash
the instance and re-mount it — to re-show (e.g. a "Back" action), re-invoke
`ctx.ui.custom(factory, { overlay: true })` again.

**Prefer `{ overlay: true }` for transient interactive UI** (menus, pickers, panels):
overlays composite onto the current window slice in screen coordinates WITHOUT clearing
the screen and freeze commits, so opening/closing never pollutes the transcript and
never triggers the destructive full-paint a session-replacing component can. The engine
guarantees the transcript redraws correctly when the dialog closes — don't "protect" it
yourself.

### Cancellable async — `BorderedLoader`

For async work with escape-to-cancel, use the shipped `BorderedLoader`
(`@earendil-works/pi-coding-agent`) — it owns escape-to-cancel and disposes its own
signal:

```typescript
import { BorderedLoader } from "@earendil-works/pi-coding-agent"

const r = await ctx.ui.custom<string | null>((tui, theme, kb, done) => {
  const loader = new BorderedLoader(tui, theme, "Working…")  // options?: { cancellable: false }
  loader.onAbort = () => done(null)
  doWork(loader.signal)                  // loader.signal is an AbortSignal
    .then((res) => done(res))
    .catch(() => done(null))
  return loader
})
```

### Overlays (floating modal, screen kept)

```typescript
const r = await ctx.ui.custom<string | null>(
  (tui, theme, kb, done) => new MyOverlay({ onClose: done }),
  { overlay: true, overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
    onHandle: (h) => { h.focus() /* h.unfocus({target}) ; h.setHidden(b) ; h.hide() */ } },
)
```

`OverlayOptions`: `anchor` (`center`/`top-left`/`top-right`/…), `width`/`row`/`col`
(absolute or `"%"`), `offsetX`/`offsetY`, `margin`, `visible(termW, termH)`. A focused
visible overlay intercepts input; `handle.unfocus({ target })` yields it back.

## Custom editor

Extend `CustomEditor` (not the base `Editor` — `CustomEditor` keeps app keybindings:
escape-to-abort, model switch, etc.). Call `super.handleInput(data)` for keys you don't
handle.

```typescript
import { CustomEditor } from "@earendil-works/pi-coding-agent"
import { matchesKey } from "@earendil-works/pi-tui"

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert"
  handleInput(data: string) {
    if (matchesKey(data, "escape") && this.mode === "insert") { this.mode = "normal"; return }
    if (this.mode === "normal" && data === "i") { this.mode = "insert"; return }
    super.handleInput(data)
  }
}
pi.on("session_start", (_e, ctx) =>
  ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(tui, theme, keybindings)))
```

To compose with another extension's editor, capture `ctx.ui.getEditorComponent()`
first and wrap it. `setEditorComponent(undefined)` restores the default.

## Autocomplete providers

`ctx.ui.addAutocompleteProvider(factory)` stacks on top of the built-in slash/path
provider. Set `triggerCharacters` for custom triggers (`#`, `$`); inspect text before
the cursor, return your suggestions when your syntax matches, else delegate to
`current.getSuggestions(...)` / `current.applyCompletion(...)`.

## Message rendering

```typescript
pi.registerMessageRenderer("my-ext", (message, options, theme) => {
  let text = theme.fg("accent", `[${message.customType}] `) + message.content
  if (options.expanded && message.details) text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2))
  return new Text(text, 0, 0)
})
// messages with that customType come from pi.sendMessage({ customType: "my-ext", content, display: true, details })
```

## Tool rendering (`renderCall` / `renderResult`)

Return a `Component`. Defaults: `renderCall` → tool name, `renderResult` → raw `content`.
Use `Text(content, 0, 0)` (the default `Box` handles padding); `\n` for multi-line;
handle `options.isPartial` for streaming and `options.expanded` for detail-on-demand.
The `context` arg carries `args`, `state` (shared across call+result slots),
`lastComponent` (reuse to mutate in place), `invalidate()`, `toolCallId`, `cwd`,
`isError`, etc. Set `renderShell: "self"` to own framing/background instead of the
default `Box`.

```typescript
import { Text } from "@earendil-works/pi-tui"
import { keyHint, highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent"

renderResult(result, { expanded }, theme, ctx) {
  if (result.details?.error) return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0)
  let text = theme.fg("success", "✓ Done")
  if (!expanded) text += ` (${keyHint("app.tools.expand", "to expand")})`   // respects keybinding config
  return new Text(text, 0, 0)
}
```

Keybinding helpers: `keyHint(id, desc)`, `keyText(id)`, `rawKeyHint(key, desc)` — use
namespaced ids (`app.*` for coding-agent, `tui.*` for shared TUI; full list in pi's
`docs/keybindings.md`). Syntax highlight tool output with `highlightCode(code, lang)`
+ `getLanguageFromPath(path)` — returns `string[]` (one styled entry per line) and uses
the active initialized theme internally (no theme arg).

## Theme

```typescript
theme.fg("accent" | "success" | "error" | "warning" | "muted" | "dim" | "toolTitle" | …, text)
theme.bold(text) ; theme.italic(text) ; theme.strikethrough(text)
ctx.ui.theme            // current theme
ctx.ui.getAllThemes() ; ctx.ui.getTheme("light") ; ctx.ui.setTheme("light" | themeObject)  // { success, error? }
```

## Built-in components — which package

Two packages, two layers. Verified against installed 0.79.3:

- **`@earendil-works/pi-tui`** (primitives): `Text`, `Box`, `Container`, `Spacer`,
  `Markdown`, `Image`, `SelectList`, `SettingsList`, `Input`, `Editor`. Plus the
  building blocks: `matchesKey`, `Key`, `CURSOR_MARKER`, `visibleWidth` /
  `truncateToWidth` / `wrapTextWithAnsi`, types `Component` / `Focusable` /
  `OverlayOptions`, `isFocusable`.
- **`@earendil-works/pi-coding-agent`** (higher-level): `DynamicBorder`,
  `BorderedLoader`, `CustomEditor`, the theme getters `getSelectListTheme` /
  `getSettingsListTheme` / `getMarkdownTheme`, key helpers `keyHint` / `keyText` /
  `rawKeyHint`, `highlightCode` / `getLanguageFromPath`, `renderDiff`,
  `truncateToVisualLines`.

`DynamicBorder` and `BorderedLoader` are **not** in pi-tui — importing them from
pi-tui fails. `SelectList` / `SettingsList` / `CURSOR_MARKER` are pi-tui only (not
re-exported by pi-coding-agent).

The `Component` interface (`pi-tui` `tui.ts`) is
`{ render(width): string[]; invalidate(): void; handleInput?(data): void; wantsKeyRelease?: boolean }`.
`dispose?()` is not on the typed interface but the engine calls `dispose?.()` on
teardown — implement it when you own resources (see below). Keyboard:
`matchesKey(data, Key.up)` / `Key.ctrl("c")`, or `keybindings.matches(data, "app.interrupt")`.

## Component render contract

Every custom `Component` (a `widget` / `footer` / `header`, a `custom()` body, a
`renderCall` / `renderResult`) lives on the render hot path. The renderer assumes you
follow these or it desyncs:

1. **`render(width)` must return lines whose VISUAL width never exceeds `width`.**
   Measure with `visibleWidth()`; clamp with `truncateToWidth()` / wrap with
   `wrapTextWithAnsi()`. Never `String.length` — it counts ANSI bytes and miscounts
   CJK/emoji 2-cell glyphs. Overwide lines trip the engine's last-resort truncation
   guard and desync row geometry → redraw thrash.
2. **Return the SAME array reference when nothing changed.** Reference equality drives
   the renderer's row memoization. `this.lines.map(...)` on every render allocates a
   fresh array and repaints unchanged rows (visible flicker on statuslines/widgets).
   Cache `{ cachedWidth, cachedLines }`; return `cachedLines` when
   `cachedLines && cachedWidth === width`; clear both in `invalidate()`.
3. **Never throw inside `render`/measure.** The render path is cosmetic — clamp,
   default, degrade. A thrown exception there can wedge the frame pipeline.

### Per-line style reset

The TUI appends a full SGR reset + OSC 8 reset at the END of every rendered line, so
styling never bleeds into the next line. For multi-line styled output, **reapply the
style per line** or use `wrapTextWithAnsi()` (re-emits ANSI on each wrapped line).
Opening a color on line 1 and expecting it to span gives you unstyled continuation
rows — and on a partial diff the bug looks intermittent (only when the diff touches
that row).

### invalidate() is the theme-change hook

On a theme switch the engine calls `invalidate()` on every component, then repaints.
If you pre-bake theme colors into strings (`theme.fg()` / `theme.bg()` /
`highlightCode()`) and store them **outside** the render cache, override
`invalidate()` to `super.invalidate()` **and** rebuild that themed content — otherwise
the switch silently keeps the old ANSI. Safer pattern: store theme **callbacks**
(`(s) => theme.fg("accent", s)`) and apply them inside `render()`, so `invalidate()`
naturally repaints in the new theme. Not needed when themed output is computed fresh in
`render()`.

### dispose() for owned resources

Implement `dispose()` whenever a component owns external resources — `setInterval` /
`setTimeout`, spawned subprocesses, file watchers, sockets, overlay handles. The engine
calls `dispose?.()` on `done()` / overlay close. Without it a closed UI leaks: a timer
keeps firing `requestRender` on an unmounted component, a subprocess keeps running. For
reactive footers, return the unsubscribe as `dispose`:
`dispose: footerData.onBranchChange(() => tui.requestRender())`.

### State change → repaint is two steps

The renderer does NOT repaint on state change for you. After mutating component state
(in `handleInput` or anywhere): call `invalidate()` to drop the cache **and**
`tui.requestRender()` (the `tui` passed into the factory) to schedule a frame.
`invalidate()` alone repaints stale cached lines; `requestRender()` alone returns the
cached lines and nothing changes. Omitting `requestRender()` is the classic "my UI
doesn't update on keypress" bug. `requestRender()` coalesces (repeated calls before the
next frame collapse into one) and ordinary frames are rate-limited — call it freely, do
NOT hand-roll debouncing, and do NOT withhold it to "avoid flicker" (you just get a
stale UI).

### Animation cadence

For animated widgets/indicators keep `intervalMs` no tighter than ~80ms (12fps) to
~33ms (30fps). The engine throttles ordinary renders to a minimum interval, so finer
intervals just coalesce and burn CPU formatting frames that never paint. Prefer
`setWorkingIndicator({ frames, intervalMs })` for stream-time animation (it routes into
the engine's component-scoped render path and repaints WITHOUT re-walking the
transcript); reserve `setInterval` + `requestRender()` for genuinely independent widgets.

### Cursor placement and IME

Cursor placement is declarative via `CURSOR_MARKER` (from `@earendil-works/pi-tui`) —
there is no `getCursorPosition()` method, and raw cursor-movement escapes fight the
renderer and desync its model. A focused component emits `CURSOR_MARKER` (a zero-width
APC marker) at the cursor position; the TUI scans for it, positions the hardware
cursor, and strips it. Caveat: if you `truncateToWidth()` a line and the marker sits
past the cut, truncation drops it — position it with width in mind. Built-in
`Editor` / `Input` already emit it.

A container wrapping an `Input` / `Editor` must implement `Focusable { focused: boolean }`
and **forward** `focused` to the child (`set focused(v) { this.searchInput.focused = v }`).
Without propagation, CJK IME candidate windows render at the wrong screen position
because the hardware cursor is never placed at the child. The hardware cursor is hidden
by default; enable it for IME via the TUI's `setShowHardwareCursor(true)` (or the
`showHardwareCursor` constructor arg / `PI_HARDWARE_CURSOR=1`).

### Prefer shipped components

Reach for the shipped components before hand-rolling — they already solve
width-safety, the same-array-reference cache, keybindings, theming, and
repaint-on-change:

- `SelectList` (`SelectItem[]` + `onSelect` / `onCancel` → `done()`)
- `SettingsList` (+ `getSettingsListTheme()`)
- `BorderedLoader` (cancellable async, below)
- `DynamicBorder` (typed color fn `(s) => theme.fg("accent", s)`)

Hand-rolled lists reintroduce every one of those bugs.
