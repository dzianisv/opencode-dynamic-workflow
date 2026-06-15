/**
 * Pierre-style Diff Renderer Extension
 *
 * Overrides the edit tool's renderResult to show diffs in a Pierre-inspired style:
 * - Side-by-side when terminal is wide enough (≥120 cols)
 * - Stacked (old → new) when narrow
 * - Syntax-highlighted line contents
 * - Subtle background tinting for changed regions
 * - Line numbers with colored gutter bars
 * - Hunk separators between non-contiguous changes
 * - 2 lines of context around changes
 */

import { basename, relative } from "node:path";
import type {
	EditToolDetails,
	ExtensionAPI,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	getLanguageFromPath,
	highlightCode,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// --- ANSI helpers for background tinting ---

const RESET = "\x1b[0m";
// Rich, darker backgrounds (RGB) - more pronounced for better visual distinction
const BG_REMOVED = "\x1b[48;2;70;20;20m"; // Deeper red
const BG_ADDED = "\x1b[48;2;20;60;30m"; // Deeper green
const BG_EMPTY = "\x1b[48;2;30;30;30m"; // Darker gray
const ESC = "\u001B";
const BEL = "\u0007";

/** Apply background that survives internal ANSI resets from theme.fg() etc. */
function applyBg(text: string, bgCode: string): string {
	// Every time a reset occurs inside the text, re-apply the background
	return `${bgCode}${text.split(RESET).join(RESET + bgCode)}${RESET}`;
}

function bgRemoved(text: string): string {
	return applyBg(text, BG_REMOVED);
}
function bgAdded(text: string): string {
	return applyBg(text, BG_ADDED);
}
function bgEmpty(text: string): string {
	return applyBg(text, BG_EMPTY);
}

function stripAnsiSequences(text: string): string {
	let result = "";

	for (let i = 0; i < text.length; i++) {
		if (text[i] !== ESC) {
			result += text[i];
			continue;
		}

		const next = text[i + 1];
		if (next == null) {
			continue;
		}

		if ((next >= "@" && next <= "_") || next === "\\") {
			i += 1;
			continue;
		}

		if (next === "[") {
			i += 1;
			while (i + 1 < text.length) {
				i += 1;
				const char = text[i];
				if (char != null && char >= "@" && char <= "~") {
					break;
				}
			}
			continue;
		}

		if (next === "]") {
			i += 1;
			while (i + 1 < text.length) {
				i += 1;
				const char = text[i];
				if (char === BEL) {
					break;
				}
				if (char === ESC && text[i + 1] === "\\") {
					i += 1;
					break;
				}
			}
		}
	}

	return result;
}

function sanitizeVisibleChars(text: string): string {
	let result = "";

	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code === 13) {
			result += "␍";
			continue;
		}

		const isControl =
			(code >= 0 && code <= 8) ||
			code === 11 ||
			code === 12 ||
			(code >= 14 && code <= 31) ||
			(code >= 127 && code <= 159);
		if (isControl) {
			result += " ";
			continue;
		}

		const isBidiControl =
			(code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
		if (isBidiControl) {
			continue;
		}

		result += char;
	}

	return result;
}

function sanitizeForRender(text: string, max = 8192): string {
	return sanitizeVisibleChars(stripAnsiSequences(text)).slice(0, max);
}

// --- Types ---

interface DiffLine {
	type: "add" | "remove" | "context" | "hunk";
	lineNum: number;
	content: string;
	rendered?: string;
}

interface DiffPair {
	old: DiffLine | null;
	new: DiffLine | null;
}

interface ExtendedEditToolDetails extends EditToolDetails {
	op?: string;
	diagnostics?: unknown;
	move?: unknown;
}

function getExtendedDetails(
	details: EditToolDetails | undefined,
): ExtendedEditToolDetails | undefined {
	if (details === undefined) return undefined;
	return details as ExtendedEditToolDetails;
}

function isTextContent(
	content: { type: string } | undefined,
): content is { type: "text"; text: string } {
	return content?.type === "text";
}

// --- Diff parsing ---

function parseDiffLines(diffText: string): DiffLine[] {
	const lines: DiffLine[] = [];
	let prevLineNum = -1;

	for (const line of diffText.split("\n")) {
		if (line.startsWith("@@")) {
			// Hunk content is never rendered (a separator is drawn instead).
			lines.push({ type: "hunk", lineNum: 0, content: "" });
			prevLineNum = -1;
			continue;
		}

		const canonical = line.match(/^([+\- ])(\s*\d+)\|(.*)$/);
		if (canonical) {
			const prefix = canonical[1];
			const lineNum = parseInt((canonical[2] ?? "").trim(), 10);
			const content = sanitizeForRender(canonical[3] ?? "");

			if (prefix === " " && content.trim() === "...") {
				lines.push({ type: "hunk", lineNum: 0, content: "" });
				prevLineNum = -1;
				continue;
			}

			if (prefix === " " && prevLineNum > 0 && lineNum > prevLineNum + 1) {
				lines.push({ type: "hunk", lineNum: 0, content: "" });
			}

			if (prefix === "-") lines.push({ type: "remove", lineNum, content });
			else if (prefix === "+") lines.push({ type: "add", lineNum, content });
			else {
				lines.push({ type: "context", lineNum, content });
				prevLineNum = lineNum;
			}
			continue;
		}

		if (line.match(/^\s+\.\.\.$/)) {
			lines.push({ type: "hunk", lineNum: 0, content: "" });
			prevLineNum = -1;
			continue;
		}

		const match = line.match(/^([-+\s])(\s*\d+)(?:\s(.*))?$/);
		if (!match) continue;
		const prefix = match[1];
		const lineNum = parseInt((match[2] ?? "").trim(), 10);
		const content = sanitizeForRender(match[3] ?? "");

		if (prefix === " " && prevLineNum > 0 && lineNum > prevLineNum + 1) {
			lines.push({ type: "hunk", lineNum: 0, content: "" });
		}

		if (prefix === "-") lines.push({ type: "remove", lineNum, content });
		else if (prefix === "+") lines.push({ type: "add", lineNum, content });
		else {
			lines.push({ type: "context", lineNum, content });
			prevLineNum = lineNum;
		}
	}
	return lines;
}

// --- Trim context to N lines around changes ---

function trimContext(lines: DiffLine[], maxContext: number): DiffLine[] {
	const isChange = (l: DiffLine) => l.type === "add" || l.type === "remove";

	// Mark which context lines are within maxContext of a change
	const keep = new Array(lines.length).fill(false);

	for (let i = 0; i < lines.length; i++) {
		const current = lines[i];
		if (current === undefined) continue;
		if (current.type === "hunk") {
			keep[i] = true;
			continue;
		}
		if (isChange(current)) {
			keep[i] = true;
			// Keep maxContext context lines before
			let found = 0;
			for (let j = i - 1; j >= 0 && found < maxContext; j--) {
				const prev = lines[j];
				if (prev === undefined) continue;
				if (prev.type === "context") {
					keep[j] = true;
					found++;
				} else if (isChange(prev)) break;
			}
			// Keep maxContext context lines after
			found = 0;
			for (let j = i + 1; j < lines.length && found < maxContext; j++) {
				const nxt = lines[j];
				if (nxt === undefined) continue;
				if (nxt.type === "context") {
					keep[j] = true;
					found++;
				} else if (isChange(nxt)) break;
			}
		}
	}

	const result: DiffLine[] = [];
	let lastKept = -1;

	for (let i = 0; i < lines.length; i++) {
		if (!keep[i]) continue;
		const current = lines[i];
		if (current === undefined) continue;
		// Insert hunk separator if there's a gap
		if (lastKept >= 0 && i > lastKept + 1 && current.type !== "hunk") {
			// Check if we haven't just added a hunk
			const last = result[result.length - 1];
			if (last?.type !== "hunk") {
				result.push({ type: "hunk", lineNum: 0, content: "" });
			}
		}
		result.push(current);
		lastKept = i;
	}

	return result;
}

function pairLines(lines: DiffLine[]): DiffPair[] {
	const pairs: DiffPair[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) {
			i++;
			continue;
		}

		if (line.type === "hunk") {
			pairs.push({ old: line, new: line });
			i++;
		} else if (line.type === "context") {
			pairs.push({ old: line, new: line });
			i++;
		} else if (line.type === "remove") {
			const removes: DiffLine[] = [];
			while (i < lines.length && lines[i]?.type === "remove") {
				const r = lines[i];
				if (r !== undefined) removes.push(r);
				i++;
			}
			const adds: DiffLine[] = [];
			while (i < lines.length && lines[i]?.type === "add") {
				const a = lines[i];
				if (a !== undefined) adds.push(a);
				i++;
			}
			const max = Math.max(removes.length, adds.length);
			for (let j = 0; j < max; j++) {
				pairs.push({
					old: j < removes.length ? (removes[j] ?? null) : null,
					new: j < adds.length ? (adds[j] ?? null) : null,
				});
			}
		} else if (line.type === "add") {
			pairs.push({ old: null, new: line });
			i++;
		}
	}
	return pairs;
}

// --- Syntax highlighting ---

function enrichPairsWithSyntaxHighlight(
	pairs: DiffPair[],
	filePath: string | undefined,
): void {
	const lang = filePath ? getLanguageFromPath(filePath) : undefined;
	if (!lang) return;

	const cache = new Map<string, string>();
	const highlight = (content: string): string => {
		// content is already sanitized by parseDiffLines; only expand tabs here.
		const source = tabs(content);
		const preview = source.length > 8192 ? `${source.slice(0, 8192)}…` : source;
		const cached = cache.get(preview);
		if (cached != null) return cached;
		const rendered = highlightCode(preview, lang)[0] ?? preview;
		cache.set(preview, rendered);
		return rendered;
	};

	for (const pair of pairs) {
		if (pair.old && pair.old.type !== "hunk") {
			pair.old.rendered = highlight(pair.old.content);
		}
		if (pair.new && pair.new.type !== "hunk") {
			pair.new.rendered = highlight(pair.new.content);
		}
	}
}

// --- Rendering helpers ---

function tabs(text: string): string {
	return text.replace(/\t/g, "  ");
}

function padTo(str: string, targetWidth: number): string {
	const w = visibleWidth(str);
	if (w >= targetWidth) return truncateToWidth(str, targetWidth);
	return str + " ".repeat(targetWidth - w);
}

/** Pad content to fill full width, then apply background to entire line */
function bgLine(
	content: string,
	targetWidth: number,
	bgFn: (s: string) => string,
): string {
	const w = visibleWidth(content);
	const padded =
		w < targetWidth
			? content + " ".repeat(targetWidth - w)
			: truncateToWidth(content, targetWidth);
	return bgFn(padded);
}

function shortPath(filePath: string, cwd: string): string {
	if (!filePath) return "";
	const rel = relative(cwd, filePath);
	const home = process.env.HOME || "";
	if (home.length > 0 && filePath.startsWith(home)) {
		const fromHome = `~${filePath.slice(home.length)}`;
		if (fromHome.length < rel.length) return fromHome;
	}
	return rel || basename(filePath);
}

// --- Hunk separator ---

function renderHunkSep(width: number, theme: Theme): string {
	const label = " ⋯ ";
	const labelW = visibleWidth(label);
	const side = Math.floor((width - labelW) / 2);
	const line = "─".repeat(Math.max(0, side));
	return (
		theme.fg("dim", line) +
		theme.fg("muted", label) +
		theme.fg("dim", "─".repeat(Math.max(0, width - side - labelW)))
	);
}

function renderHunkSepSplit(
	halfW: number,
	gutterW: number,
	width: number,
	theme: Theme,
): string {
	const label = " ⋯ ";
	const labelW = visibleWidth(label);

	const leftSide = Math.floor((halfW - labelW) / 2);
	const leftLine = "─".repeat(Math.max(0, leftSide));
	const left =
		theme.fg("dim", leftLine) +
		theme.fg("muted", label) +
		theme.fg("dim", "─".repeat(Math.max(0, halfW - leftSide - labelW)));

	const rightHalfW = width - halfW - gutterW;
	const rightSide = Math.floor((rightHalfW - labelW) / 2);
	const rightLine = "─".repeat(Math.max(0, rightSide));
	const right =
		theme.fg("dim", rightLine) +
		theme.fg("muted", label) +
		theme.fg("dim", "─".repeat(Math.max(0, rightHalfW - rightSide - labelW)));

	return (
		padTo(left, halfW) +
		theme.fg("dim", " │ ") +
		truncateToWidth(right, rightHalfW)
	);
}

// --- Side-by-side ---

function getLineNumWidth(pairs: DiffPair[]): number {
	const maxLineNum = pairs.reduce((max, pair) => {
		const left = pair.old?.lineNum ?? 0;
		const right = pair.new?.lineNum ?? 0;
		return Math.max(max, left, right);
	}, 0);
	return Math.max(4, String(maxLineNum).length);
}

function renderSideBySide(
	pairs: DiffPair[],
	width: number,
	theme: Theme,
): string[] {
	const gutterW = 3; // Wider gutter for better column separation
	const lineNumW = getLineNumWidth(pairs);
	const halfW = Math.floor((width - gutterW) / 2);
	const rightHalfW = width - halfW - gutterW;
	const contentW = Math.max(1, halfW - 1 - lineNumW - 1);

	const out: string[] = [];

	for (const pair of pairs) {
		if (pair.old && pair.old.type === "hunk") {
			out.push(renderHunkSepSplit(halfW, gutterW, width, theme));
			continue;
		}

		const isOldChange = pair.old && pair.old.type === "remove";
		const isNewChange = pair.new && pair.new.type === "add";
		const isOldEmpty = !pair.old || (isNewChange && !isOldChange);
		const isNewEmpty = !pair.new || (isOldChange && !isNewChange);

		// Build raw content for each half
		const leftRaw = buildHalfContent(
			pair.old,
			"old",
			lineNumW,
			contentW,
			theme,
		);
		const rightRaw = buildHalfContent(
			pair.new,
			"new",
			lineNumW,
			contentW,
			theme,
		);

		// Apply backgrounds
		let left: string;
		if (isOldChange) {
			left = bgLine(leftRaw, halfW, bgRemoved);
		} else if (isOldEmpty && isNewChange) {
			left = bgLine(leftRaw, halfW, bgEmpty);
		} else {
			left = padTo(leftRaw, halfW);
		}

		let right: string;
		if (isNewChange) {
			right = bgLine(rightRaw, rightHalfW, bgAdded);
		} else if (isNewEmpty && isOldChange) {
			right = bgLine(rightRaw, rightHalfW, bgEmpty);
		} else {
			right = padTo(rightRaw, rightHalfW);
		}

		out.push(left + theme.fg("dim", " │ ") + right);
	}

	return out;
}

// --- Stacked ---

function renderStacked(
	pairs: DiffPair[],
	width: number,
	theme: Theme,
): string[] {
	const lineNumW = getLineNumWidth(pairs);
	const contentW = Math.max(1, width - 1 - lineNumW - 1);

	const out: string[] = [];

	for (const pair of pairs) {
		if (pair.old && pair.old.type === "hunk") {
			out.push(renderHunkSep(width, theme));
			continue;
		}

		if (pair.old && pair.old.type === "remove") {
			const raw = buildFullContent(
				pair.old,
				"remove",
				lineNumW,
				contentW,
				theme,
			);
			out.push(bgLine(raw, width, bgRemoved));
		}
		if (pair.new && pair.new.type === "add") {
			const raw = buildFullContent(pair.new, "add", lineNumW, contentW, theme);
			out.push(bgLine(raw, width, bgAdded));
		}
		if (pair.old && pair.old.type === "context") {
			const raw = buildFullContent(
				pair.old,
				"context",
				lineNumW,
				contentW,
				theme,
			);
			out.push(padTo(raw, width));
		}
	}

	return out;
}

// --- Content builders (no background, just styled text) ---

function buildHalfContent(
	line: DiffLine | null,
	side: "old" | "new",
	lineNumW: number,
	contentW: number,
	theme: Theme,
): string {
	if (!line) {
		return ` ${" ".repeat(lineNumW)} `;
	}

	// Enhanced line number styling - slightly brighter for better visibility
	const num = theme.fg("muted", String(line.lineNum).padStart(lineNumW));

	if (line.type === "context") {
		const text =
			line.rendered != null
				? line.rendered
				: theme.fg("dim", tabs(sanitizeForRender(line.content)));
		return (
			theme.fg("dim", " ") +
			num +
			theme.fg("dim", " ") +
			truncateToWidth(text, contentW)
		);
	}

	if (line.type === "remove" && side === "old") {
		// Bolder gutter bar for removed lines
		const bar = theme.fg("toolDiffRemoved", "█");
		const text =
			line.rendered != null
				? line.rendered
				: theme.fg("toolDiffRemoved", tabs(sanitizeForRender(line.content)));
		return `${bar + num} ${truncateToWidth(text, contentW)}`;
	}

	if (line.type === "add" && side === "new") {
		// Bolder gutter bar for added lines
		const bar = theme.fg("toolDiffAdded", "█");
		const text =
			line.rendered != null
				? line.rendered
				: theme.fg("toolDiffAdded", tabs(sanitizeForRender(line.content)));
		return `${bar + num} ${truncateToWidth(text, contentW)}`;
	}

	return ` ${" ".repeat(lineNumW)} `;
}

function buildFullContent(
	line: DiffLine,
	type: "add" | "remove" | "context",
	lineNumW: number,
	contentW: number,
	theme: Theme,
): string {
	// Enhanced line number styling - slightly brighter for better visibility
	const num = theme.fg("muted", String(line.lineNum).padStart(lineNumW));

	if (type === "context") {
		const text =
			line.rendered != null
				? line.rendered
				: theme.fg("dim", tabs(sanitizeForRender(line.content)));
		return (
			theme.fg("dim", " ") +
			num +
			theme.fg("dim", " ") +
			truncateToWidth(text, contentW)
		);
	}

	if (type === "remove") {
		// Bolder gutter bar for removed lines
		const bar = theme.fg("toolDiffRemoved", "█");
		const text =
			line.rendered != null
				? line.rendered
				: theme.fg("toolDiffRemoved", tabs(sanitizeForRender(line.content)));
		return `${bar + num} ${truncateToWidth(text, contentW)}`;
	}

	// Bolder gutter bar for added lines
	const bar = theme.fg("toolDiffAdded", "█");
	const text =
		line.rendered != null
			? line.rendered
			: theme.fg("toolDiffAdded", tabs(sanitizeForRender(line.content)));
	return `${bar + num} ${truncateToWidth(text, contentW)}`;
}

// --- Threshold ---
const SIDE_BY_SIDE_MIN_WIDTH = 120;
const MAX_CONTEXT_LINES = 2;

// --- Extension ---

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const originalEditDefinition = createEditToolDefinition(cwd);

	const pierreDiffEditTool: ToolDefinition<
		typeof originalEditDefinition.parameters,
		EditToolDetails | undefined
	> = {
		name: "edit",
		label: "Edit",
		description: originalEditDefinition.description,
		parameters: originalEditDefinition.parameters,
		prepareArguments: originalEditDefinition.prepareArguments,

		execute(toolCallId, params, signal, onUpdate, ctx) {
			return originalEditDefinition.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},

		renderCall(args, theme, _context) {
			const text = new Text("", 0, 0);
			let s = theme.fg("toolTitle", theme.bold("edit "));
			s += theme.fg(
				"accent",
				sanitizeForRender(shortPath(args.path, cwd), 160),
			);
			if (args.edits.length > 1) {
				s += theme.fg("dim", ` (${args.edits.length} edits)`);
			}
			text.setText(s);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Editing..."), 0, 0);
			}

			const details = result.details;
			const extendedDetails = getExtendedDetails(details);
			const originalFallback = originalEditDefinition.renderResult?.(
				result,
				{ expanded, isPartial },
				theme,
				context,
			);
			const firstContent = result.content.find(
				(content) => content.type === "text",
			);

			if (context.isError) {
				const errorText = isTextContent(firstContent)
					? sanitizeForRender(firstContent.text.split("\n")[0] ?? "", 200)
					: "Edit failed";
				return new Text(theme.fg("error", errorText), 0, 0);
			}

			if (!details?.diff) {
				return (
					originalFallback ?? new Text(theme.fg("success", "✓ Applied"), 0, 0)
				);
			}

			const operation = extendedDetails?.op;
			if (
				expanded ||
				(operation && operation !== "replace" && operation !== "patch") ||
				extendedDetails?.diagnostics ||
				extendedDetails?.move
			) {
				return (
					originalFallback ?? new Text(theme.fg("success", "✓ Applied"), 0, 0)
				);
			}

			let additions = 0;
			let removals = 0;
			for (const line of details.diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			const parsed = parseDiffLines(details.diff);
			const visible = expanded
				? parsed
				: trimContext(parsed, MAX_CONTEXT_LINES);
			const pairs = pairLines(visible);
			if (details.diff.trim().length > 0 && pairs.length === 0) {
				return (
					originalFallback ??
					new Text(sanitizeForRender(details.diff, 500), 0, 0)
				);
			}
			enrichPairsWithSyntaxHighlight(pairs, context.args.path);

			const comp = new Text("", 0, 0);
			let cachedWidth = -1;
			let cachedLines: string[] | null = null;
			comp.render = (width: number): string[] => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				// Built fresh (and inside render) so a theme switch repaints correctly.
				const summary =
					theme.fg("toolDiffAdded", `+${additions}`) +
					theme.fg("dim", " / ") +
					theme.fg("toolDiffRemoved", `-${removals}`);
				const diffLines =
					width >= SIDE_BY_SIDE_MIN_WIDTH
						? renderSideBySide(pairs, width, theme)
						: renderStacked(pairs, width, theme);
				cachedWidth = width;
				cachedLines = [summary, ...diffLines];
				return cachedLines;
			};
			comp.invalidate = () => {
				cachedWidth = -1;
				cachedLines = null;
			};
			return comp;
		},
	};

	pi.registerTool(pierreDiffEditTool);
}
