/**
 * Handoff tree overlay - navigate the handoff history across sessions
 */

import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { HandoffRecord, HandoffTreeNode } from "./types.js";

export type TreeAction =
	| { type: "open"; record: HandoffRecord }
	| { type: "preview"; record: HandoffRecord }
	| { type: "cancel" };

/** Tabs break the renderer's column math — collapse them before measuring. */
function tabSafe(s: string): string {
	return s.replace(/\t/g, "  ");
}

/**
 * Build a tree of HandoffTreeNode from a flat list of records.
 */
export function buildTree(
	records: HandoffRecord[],
	currentSessionFile: string | undefined,
): HandoffTreeNode[] {
	const byId = new Map<string, HandoffRecord>();
	for (const r of records) byId.set(r.id, r);

	// Find which handoff IDs are on the "active" path
	// Active path: the chain from the current session back to root
	const activePath = new Set<string>();
	if (currentSessionFile) {
		// Find the handoff that created the current session
		const currentHandoff = records.find(
			(r) => r.targetSessionFile === currentSessionFile,
		);
		if (currentHandoff) {
			let walk: string | null = currentHandoff.id;
			// Guard against cyclic parent chains (corrupt data) — stop if we
			// revisit a node so the walk can't loop forever.
			while (walk && !activePath.has(walk)) {
				activePath.add(walk);
				const rec = byId.get(walk);
				walk = rec?.parentHandoffId ?? null;
			}
		}
		// Also mark handoffs sourced from current session
		for (const r of records) {
			if (r.sourceSessionFile === currentSessionFile) {
				activePath.add(r.id);
			}
		}
	}

	// Build nodes
	const nodeMap = new Map<string, HandoffTreeNode>();
	for (const r of records) {
		nodeMap.set(r.id, {
			record: r,
			children: [],
			depth: 0,
			isActive: activePath.has(r.id),
		});
	}

	const roots: HandoffTreeNode[] = [];
	for (const r of records) {
		const node = nodeMap.get(r.id);
		if (!node) continue;
		// `r.parentHandoffId !== r.id` rejects a self-parent, which would
		// otherwise make the node its own child and hang the recursion below.
		if (
			r.parentHandoffId &&
			r.parentHandoffId !== r.id &&
			nodeMap.has(r.parentHandoffId)
		) {
			const parent = nodeMap.get(r.parentHandoffId);
			if (!parent) continue;
			parent.children.push(node);
			node.depth = parent.depth + 1;
		} else {
			roots.push(node);
		}
	}

	// Set depths recursively. `seen` guards against cyclic child links from
	// corrupt data so a malformed tree can't overflow the stack.
	const seen = new Set<string>();
	function setDepths(node: HandoffTreeNode, d: number) {
		if (seen.has(node.record.id)) return;
		seen.add(node.record.id);
		node.depth = d;
		for (const c of node.children) setDepths(c, d + 1);
	}
	for (const r of roots) setDepths(r, 0);

	return roots;
}

/**
 * Flatten tree to display order (depth-first)
 */
function flattenTree(roots: HandoffTreeNode[]): HandoffTreeNode[] {
	const result: HandoffTreeNode[] = [];
	const seen = new Set<string>();
	function walk(node: HandoffTreeNode) {
		if (seen.has(node.record.id)) return;
		seen.add(node.record.id);
		result.push(node);
		for (const c of node.children) walk(c);
	}
	for (const r of roots) walk(r);
	return result;
}

/**
 * Format a timestamp for display
 */
function formatTime(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();

	if (isToday) {
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	const diffDays = Math.floor(
		(now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
	);
	if (diffDays < 7) {
		return `${diffDays}d ago`;
	}

	return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Shorten a session file path for display
 */
function shortenPath(p: string): string {
	const home = homedir();
	let s = p;
	if (home && s.startsWith(home)) {
		s = `~${s.slice(home.length)}`;
	}
	// Just show the filename
	const parts = s.split("/");
	return parts[parts.length - 1] || s;
}

/**
 * Create the handoff tree overlay component
 */
export function createTreeOverlay(
	tui: TUI,
	theme: Theme,
	records: HandoffRecord[],
	currentSessionFile: string | undefined,
	done: (result: TreeAction) => void,
) {
	const tree = buildTree(records, currentSessionFile);
	const flatNodes = flattenTree(tree);

	let selectedIdx = 0;
	let scrollOffset = 0;
	let showPreview = false;
	let previewScrollOffset = 0;
	let lastPreviewMaxScroll = 0; // shared clamp bound for render + input

	// Find and select the active node
	if (flatNodes.length > 0) {
		const activeIdx = flatNodes.findIndex((n) => n.isActive);
		if (activeIdx >= 0) selectedIdx = activeIdx;
	}

	return {
		render(width: number): string[] {
			const termHeight = process.stdout.rows ?? 40;
			const lines: string[] = [];

			// Split layout: tree | preview
			const previewWidth = showPreview ? Math.floor(width * 0.45) : 0;
			const treeWidth = showPreview ? width - previewWidth - 1 : width; // 1 for separator

			// ── Top border ──
			const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
			lines.push(...topBorder.render(width));

			// Title
			const countInfo = theme.fg("dim", ` (${records.length} handoffs)`);
			const title =
				theme.fg("accent", theme.bold(" 🌳 Handoff Tree")) + countInfo;
			lines.push(truncateToWidth(title, width));

			// Separator
			lines.push(
				truncateToWidth(
					` ${theme.fg("dim", "─".repeat(Math.max(width - 2, 0)))}`,
					width,
				),
			);

			if (flatNodes.length === 0) {
				lines.push(
					truncateToWidth(
						theme.fg("muted", "  No handoffs yet. Use /handoff to create one."),
						width,
					),
				);
			} else {
				// Tree list area
				const maxListHeight = Math.max(termHeight - 10, 5);
				const visibleCount = Math.min(maxListHeight, flatNodes.length);

				// Adjust scroll to keep selection visible
				if (selectedIdx < scrollOffset) scrollOffset = selectedIdx;
				if (selectedIdx >= scrollOffset + visibleCount)
					scrollOffset = selectedIdx - visibleCount + 1;
				scrollOffset = Math.max(
					0,
					Math.min(scrollOffset, flatNodes.length - visibleCount),
				);

				// Render the preview once per frame (it only depends on the
				// selected record + width), then clamp scroll against it. Doing
				// this inside the row loop re-rendered the same markdown once per
				// visible row.
				let previewLines: string[] = [];
				if (showPreview) {
					previewLines = getPreviewLines(
						flatNodes[selectedIdx]?.record,
						previewWidth - 2,
					);
					lastPreviewMaxScroll = Math.max(
						0,
						previewLines.length - visibleCount,
					);
					previewScrollOffset = Math.min(
						previewScrollOffset,
						lastPreviewMaxScroll,
					);
				}

				for (
					let i = scrollOffset;
					i < scrollOffset + visibleCount && i < flatNodes.length;
					i++
				) {
					const node = flatNodes[i];
					if (!node) continue;
					const r = node.record;
					const isSelected = i === selectedIdx;
					const indent = "  ".repeat(node.depth);

					// Tree connectors
					const connector = node.depth > 0 ? "├─ " : "";

					// Status indicators
					const statusIcon = r.approved
						? theme.fg("success", "●")
						: theme.fg("warning", "○");
					const activeMarker = node.isActive
						? theme.fg("accent", " ← active")
						: "";

					// Label (sanitize: shorten home paths, collapse tabs)
					const goalText = tabSafe(
						r.metadata.goal || shortenPath(r.sourceSessionFile),
					);
					const timeText = theme.fg("dim", formatTime(r.timestamp));

					// Compose the line
					const prefix = isSelected ? theme.fg("accent", "❯ ") : "  ";
					const connectorStyled = theme.fg("dim", connector);
					const goalStyled = isSelected
						? theme.fg("accent", theme.bold(goalText))
						: theme.fg("text", goalText);

					const treeLine = `${prefix}${indent}${connectorStyled}${statusIcon} ${goalStyled}${activeMarker} ${timeText}`;

					if (showPreview) {
						// Tree side
						const treeLineTrunc = truncateToWidth(treeLine, treeWidth);
						const treePad = " ".repeat(
							Math.max(0, treeWidth - visibleWidth(treeLineTrunc)),
						);

						// Preview side (previewLines computed once above)
						const previewLineIdx = i - scrollOffset;
						const actualPreviewIdx = previewLineIdx + previewScrollOffset;
						const previewLine =
							actualPreviewIdx >= 0 && actualPreviewIdx < previewLines.length
								? previewLines[actualPreviewIdx] || ""
								: "";

						const sep = theme.fg("dim", "│");
						lines.push(
							truncateToWidth(
								`${treeLineTrunc + treePad + sep} ${previewLine}`,
								width,
							),
						);
					} else {
						lines.push(truncateToWidth(treeLine, width));
					}
				}

				// Scroll indicator
				if (flatNodes.length > visibleCount) {
					const scrollInfo = theme.fg(
						"dim",
						` ─── ${scrollOffset + 1}-${scrollOffset + visibleCount} of ${flatNodes.length} ───`,
					);
					lines.push(truncateToWidth(scrollInfo, width));
				}
			}

			// Separator
			lines.push(
				truncateToWidth(
					` ${theme.fg("dim", "─".repeat(Math.max(width - 2, 0)))}`,
					width,
				),
			);

			// Legend
			const legend = [
				theme.fg("success", "●") + theme.fg("dim", " approved"),
				theme.fg("warning", "○") + theme.fg("dim", " pending"),
			].join("  ");
			lines.push(truncateToWidth(` ${legend}`, width));

			// Help
			const help = theme.fg(
				"dim",
				" ↑↓ navigate · Enter open session · Tab toggle preview · Esc close",
			);
			lines.push(truncateToWidth(help, width));

			// Bottom border
			const bottomBorder = new DynamicBorder((s: string) =>
				theme.fg("accent", s),
			);
			lines.push(...bottomBorder.render(width));

			return lines;
		},

		invalidate() {},

		handleInput(data: string) {
			if (flatNodes.length === 0) {
				// Only allow closing when tree is empty
				if (matchesKey(data, Key.escape)) {
					done({ type: "cancel" });
				}
				return;
			}

			// Navigation
			if (matchesKey(data, Key.up) || data === "k") {
				if (selectedIdx > 0) {
					selectedIdx--;
					previewScrollOffset = 0;
				}
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				if (selectedIdx < flatNodes.length - 1) {
					selectedIdx++;
					previewScrollOffset = 0;
				}
				tui.requestRender();
				return;
			}

			// Page navigation
			if (matchesKey(data, Key.pageUp)) {
				selectedIdx = Math.max(0, selectedIdx - 10);
				previewScrollOffset = 0;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				selectedIdx = Math.min(flatNodes.length - 1, selectedIdx + 10);
				previewScrollOffset = 0;
				tui.requestRender();
				return;
			}

			// Preview toggle
			if (matchesKey(data, Key.tab)) {
				showPreview = !showPreview;
				previewScrollOffset = 0;
				tui.requestRender();
				return;
			}

			// Preview scroll (when preview is showing)
			if (showPreview) {
				if (matchesKey(data, Key.right)) {
					// Use the same bound render computed; render re-clamps anyway.
					previewScrollOffset = Math.min(
						lastPreviewMaxScroll,
						previewScrollOffset + 1,
					);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.left)) {
					previewScrollOffset = Math.max(0, previewScrollOffset - 1);
					tui.requestRender();
					return;
				}
			}

			// Open session
			if (matchesKey(data, Key.enter)) {
				const selected = flatNodes[selectedIdx];
				if (selected) done({ type: "open", record: selected.record });
				return;
			}

			// Cancel
			if (matchesKey(data, Key.escape)) {
				done({ type: "cancel" });
				return;
			}
		},
	};
}

// ── Preview helpers ─────────────────────────────────────────────────

function getPreviewLines(
	record: HandoffRecord | undefined,
	width: number,
): string[] {
	if (!record) return [];

	// Never throw in the render path — a malformed summary degrades to text.
	const mdTheme = getMarkdownTheme();
	try {
		const md = new Markdown(record.summary, 0, 0, mdTheme);
		return md.render(Math.max(width, 20)).map(tabSafe);
	} catch {
		return record.summary.split("\n").map(tabSafe);
	}
}
