/**
 * Handoff review overlay - scrollable markdown with approval actions
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export type ReviewAction = "approve" | "edit" | "cancel";

export interface ReviewResult {
	action: ReviewAction;
	editedSummary?: string;
}

/** Tabs break the renderer's column math — collapse them before measuring. */
function tabSafe(s: string): string {
	return s.replace(/\t/g, "  ");
}

/**
 * Creates the review overlay component.
 * Returns a component that renders the handoff summary with action bar.
 * When viewOnly is true, only shows cancel/close action.
 */
export function createReviewOverlay(
	tui: TUI,
	theme: Theme,
	summary: string,
	done: (result: ReviewResult) => void,
	viewOnly = false,
) {
	const mdTheme = getMarkdownTheme();

	let scrollOffset = 0;
	let focusedAction = 0;
	const actions: { key: string; label: string; action: ReviewAction }[] =
		viewOnly
			? [{ key: "1", label: "✕ Close", action: "cancel" }]
			: [
					{
						key: "1",
						label: "✓ Approve & start new session",
						action: "approve",
					},
					{ key: "2", label: "✎ Edit before approving", action: "edit" },
					{ key: "3", label: "✕ Cancel", action: "cancel" },
				];

	// We render markdown to lines, then window them for scrolling
	let cachedLines: string[] | null = null;
	let cachedWidth: number | null = null;

	function getRenderedLines(width: number): string[] {
		if (cachedLines !== null && cachedWidth === width) return cachedLines;

		const contentWidth = Math.max(width - 4, 20); // padding
		if (!summary || summary.trim().length === 0) {
			cachedLines = ["  (empty handoff summary)"];
		} else {
			// Never throw in the render path — a malformed summary degrades to text.
			try {
				const md = new Markdown(summary, 1, 0, mdTheme);
				cachedLines = md.render(contentWidth);
			} catch {
				cachedLines = summary.split("\n");
			}
		}
		cachedWidth = width;
		return cachedLines;
	}

	return {
		render(width: number): string[] {
			const termHeight = process.stdout.rows ?? 40;
			const maxContentHeight = Math.max(termHeight - 12, 10); // room for borders, actions, help

			const lines: string[] = [];

			// Top border
			const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
			lines.push(...topBorder.render(width));

			// Title
			const titleText = viewOnly
				? " 📋 Handoff Summary (read-only)"
				: " 📋 Handoff Summary";
			const title = new Text(theme.fg("accent", theme.bold(titleText)), 1, 0);
			lines.push(...title.render(width));

			// Separator
			lines.push(
				truncateToWidth(
					` ${theme.fg("dim", "─".repeat(Math.max(width - 2, 0)))}`,
					width,
				),
			);

			// Scrollable content area
			const contentLines = getRenderedLines(width);
			const visibleCount = Math.min(maxContentHeight, contentLines.length);
			const maxScroll = Math.max(0, contentLines.length - visibleCount);
			scrollOffset = Math.min(scrollOffset, maxScroll);
			scrollOffset = Math.max(0, scrollOffset);

			const visible = contentLines.slice(
				scrollOffset,
				scrollOffset + visibleCount,
			);
			for (const line of visible) {
				lines.push(truncateToWidth(` ${tabSafe(line)}`, width));
			}

			// Scroll indicator
			if (contentLines.length > visibleCount) {
				const pct =
					maxScroll > 0 ? Math.round((scrollOffset / maxScroll) * 100) : 0;
				const scrollInfo = theme.fg(
					"dim",
					` ─── ${scrollOffset + 1}-${scrollOffset + visibleCount} of ${contentLines.length} lines (${pct}%) ───`,
				);
				lines.push(truncateToWidth(scrollInfo, width));
			}

			// Separator before actions
			lines.push(
				truncateToWidth(
					` ${theme.fg("dim", "─".repeat(Math.max(width - 2, 0)))}`,
					width,
				),
			);

			// Action buttons
			for (let i = 0; i < actions.length; i++) {
				const a = actions[i];
				if (!a) continue;
				const prefix = i === focusedAction ? theme.fg("accent", " ❯ ") : "   ";
				const label =
					i === focusedAction
						? theme.fg("accent", theme.bold(`[${a.key}] ${a.label}`))
						: theme.fg("text", `[${a.key}] ${a.label}`);
				lines.push(truncateToWidth(prefix + label, width));
			}

			// Help text
			const helpText = viewOnly
				? theme.fg(
						"dim",
						" ↑↓ scroll · j/k scroll · PgUp/PgDn page · Esc close",
					)
				: theme.fg(
						"dim",
						" ↑↓ scroll · j/k scroll · PgUp/PgDn page · 1/2/3 or Enter select · Esc cancel",
					);
			lines.push(truncateToWidth(helpText, width));

			// Bottom border
			const bottomBorder = new DynamicBorder((s: string) =>
				theme.fg("accent", s),
			);
			lines.push(...bottomBorder.render(width));

			return lines;
		},

		invalidate() {
			cachedLines = null;
			cachedWidth = null;
		},

		handleInput(data: string) {
			const contentLines = cachedLines || [];
			const termHeight = process.stdout.rows ?? 40;
			const maxContentHeight = Math.max(termHeight - 12, 10);
			const visibleCount = Math.min(maxContentHeight, contentLines.length);
			const maxScroll = Math.max(0, contentLines.length - visibleCount);
			const pageSize = Math.max(maxContentHeight - 2, 5);

			// Scrolling
			if (matchesKey(data, Key.up) || data === "k") {
				scrollOffset = Math.max(0, scrollOffset - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				scrollOffset = Math.min(maxScroll, scrollOffset + 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
				scrollOffset = Math.max(0, scrollOffset - pageSize);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
				scrollOffset = Math.min(maxScroll, scrollOffset + pageSize);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.home)) {
				scrollOffset = 0;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.end)) {
				scrollOffset = maxScroll;
				tui.requestRender();
				return;
			}

			// Action focus with Tab
			if (matchesKey(data, Key.tab)) {
				focusedAction = (focusedAction + 1) % actions.length;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				focusedAction = (focusedAction - 1 + actions.length) % actions.length;
				tui.requestRender();
				return;
			}

			// Direct number keys
			for (const a of actions) {
				if (data === a.key) {
					done({ action: a.action });
					return;
				}
			}

			// Enter selects focused action
			if (matchesKey(data, Key.enter)) {
				const focused = actions[focusedAction];
				if (focused) done({ action: focused.action });
				return;
			}

			// Escape cancels
			if (matchesKey(data, Key.escape)) {
				done({ action: "cancel" });
				return;
			}
		},
	};
}
