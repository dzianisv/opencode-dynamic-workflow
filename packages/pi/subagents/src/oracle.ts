/**
 * Oracle Extension
 *
 * Launches a GPT-5.4 subagent to deeply explore and research a codebase.
 * Provides `/oracle` command and `alt+o` shortcut. If no query is provided,
 * opens an overlay to type the research question.
 *
 * Uses the existing subagent system under the hood: it emits a
 * `subagents:spawn-request` event that the subagents supervisor (shipped in
 * this same package as `subagents.ts`) handles. Until that handler is loaded
 * the request times out after 5s — oracle is inert but well-behaved.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Focusable,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const ORACLE_MODEL = "gpt-5.4";

interface SpawnRequestResult {
	details?: { error?: boolean };
	content?: Array<{ type: "text"; text: string }>;
}

function sanitizeQuery(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

function buildOracleName(): string {
	return `oracle-${randomUUID().slice(0, 6)}`;
}

function buildOracleDescription(query: string): string {
	const words = sanitizeQuery(query).split(" ").filter(Boolean).slice(0, 8);
	return words.join(" ") || "codebase research";
}

function buildOraclePrompt(query: string, cwd: string): string {
	return [
		`You are an oracle — a deep research agent tasked with thoroughly exploring a codebase to answer a question.`,
		``,
		`## Research Question`,
		`${query}`,
		``,
		`## Working Directory`,
		`${cwd}`,
		``,
		`## Instructions`,
		`1. Start by understanding the project structure (ls, find, read key config files).`,
		`2. Identify the most relevant files, modules, and patterns related to the question.`,
		`3. Read and analyze the code thoroughly — don't skim.`,
		`4. Trace call chains, data flows, and dependencies as needed.`,
		`5. Synthesize your findings into a clear, structured report.`,
		``,
		`## Output Format`,
		`Write a comprehensive research report with:`,
		`- **Summary**: 2-3 sentence answer to the question`,
		`- **Key Findings**: bullet points of what you discovered`,
		`- **Relevant Files**: list of important files with brief descriptions`,
		`- **Details**: deeper analysis with code references (file:line)`,
		`- **Recommendations**: if applicable, actionable next steps`,
		``,
		`Be thorough but concise. Cite specific files and line numbers.`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	// ── Launch oracle via the subagents supervisor ───────────────

	async function launchOracle(
		query: string,
		launchCtx: ExtensionContext,
	): Promise<{ ok: boolean; error?: string; name?: string }> {
		const cleanedQuery = sanitizeQuery(query);
		if (!cleanedQuery) return { ok: false, error: "Oracle query is required." };
		const prompt = buildOraclePrompt(cleanedQuery, launchCtx.cwd);
		const name = buildOracleName();

		const result = await new Promise<SpawnRequestResult>((resolve) => {
			const timeout = setTimeout(() => {
				resolve({
					details: { error: true },
					content: [
						{
							type: "text",
							text: "Timed out waiting for subagent spawn handler.",
						},
					],
				});
			}, 5000);

			pi.events.emit("subagents:spawn-request", {
				name,
				description: buildOracleDescription(cleanedQuery),
				prompt,
				model: ORACLE_MODEL,
				cwd: launchCtx.cwd,
				resolve: (value: SpawnRequestResult) => {
					clearTimeout(timeout);
					resolve(value);
				},
			});
		});

		if (result?.details?.error) {
			const errorText =
				result?.content?.[0]?.type === "text"
					? result.content[0].text
					: "Failed to launch oracle.";
			return { ok: false, error: errorText };
		}

		return { ok: true, name };
	}

	// ── Overlay: ask for research query ──────────────────────────

	async function askQuery(uiCtx: ExtensionContext): Promise<string | null> {
		if (uiCtx.mode !== "tui") return null;
		return uiCtx.ui.custom<string | null>(
			(tui, theme, _kb, done) => {
				let buffer = "";
				let cursorPos = 0;
				const overlayWidth = 70;
				const innerW = overlayWidth - 2;

				const pad = (s: string, len: number) => {
					const vis = visibleWidth(s);
					return s + " ".repeat(Math.max(0, len - vis));
				};
				const row = (content: string) =>
					theme.fg("border", "│") +
					pad(truncateToWidth(` ${content}`, innerW), innerW) +
					theme.fg("border", "│");

				const component: Focusable & {
					render: (w: number) => string[];
					handleInput: (d: string) => void;
					invalidate: () => void;
				} = {
					focused: false,

					render(_width: number): string[] {
						const lines: string[] = [];

						lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
						lines.push(
							row(
								theme.fg("accent", theme.bold("🔮 Oracle")) +
									theme.fg("dim", ` — powered by ${ORACLE_MODEL}`),
							),
						);
						lines.push(row(""));
						lines.push(row(theme.fg("text", "What do you want to research?")));
						lines.push(row(""));

						// Input line with cursor — horizontally windowed so a long
						// query never overflows the overlay (ui.md render contract).
						const promptPrefix = "❯ ";
						const inputBudget = Math.max(
							1,
							innerW - 1 - visibleWidth(promptPrefix),
						);
						let start = 0;
						if (cursorPos > inputBudget - 1)
							start = cursorPos - (inputBudget - 1);
						const windowEnd = start + inputBudget;
						const before = buffer.slice(start, cursorPos);
						const cursorChar =
							cursorPos < buffer.length ? (buffer[cursorPos] ?? " ") : " ";
						const after = buffer.slice(cursorPos + 1, windowEnd);
						const marker = component.focused ? CURSOR_MARKER : "";
						const inputDisplay = `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
						lines.push(row(theme.fg("accent", promptPrefix) + inputDisplay));

						lines.push(row(""));
						lines.push(row(theme.fg("dim", "enter launch · esc cancel")));
						lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));

						return lines;
					},

					handleInput(data: string) {
						if (matchesKey(data, Key.escape)) {
							done(null);
							return;
						}
						if (matchesKey(data, Key.enter)) {
							const trimmed = buffer.trim();
							if (trimmed) done(trimmed);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.backspace)) {
							if (cursorPos > 0) {
								buffer =
									buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
								cursorPos--;
							}
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.delete)) {
							if (cursorPos < buffer.length) {
								buffer =
									buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
							}
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.left)) {
							cursorPos = Math.max(0, cursorPos - 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.right)) {
							cursorPos = Math.min(buffer.length, cursorPos + 1);
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) {
							cursorPos = 0;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) {
							cursorPos = buffer.length;
							tui.requestRender();
							return;
						}
						// Printable character
						if (data.length === 1 && data.charCodeAt(0) >= 32) {
							buffer =
								buffer.slice(0, cursorPos) + data + buffer.slice(cursorPos);
							cursorPos++;
							tui.requestRender();
						}
					},

					invalidate() {},
				};

				return component;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 70, maxHeight: "50%" },
			},
		);
	}

	// ── Command ──────────────────────────────────────────────────

	pi.registerCommand("oracle", {
		description: "Launch GPT-5.4 oracle to research the codebase",
		handler: async (args, cmdCtx) => {
			const query = sanitizeQuery(args?.trim() || "");

			if (query) {
				const result = await launchOracle(query, cmdCtx);
				if (cmdCtx.hasUI) {
					cmdCtx.ui.notify(
						result.ok
							? `🔮 Oracle launched: ${query.slice(0, 50)}`
							: result.error || "Failed to launch oracle.",
						result.ok ? "info" : "error",
					);
				}
				return;
			}

			if (cmdCtx.mode !== "tui") return;

			// No args — open overlay
			const result = await askQuery(cmdCtx);
			if (result) {
				const launchResult = await launchOracle(result, cmdCtx);
				cmdCtx.ui.notify(
					launchResult.ok
						? `🔮 Oracle launched: ${result.slice(0, 50)}`
						: launchResult.error || "Failed to launch oracle.",
					launchResult.ok ? "info" : "error",
				);
			}
		},
	});

	// ── Shortcut ─────────────────────────────────────────────────

	pi.registerShortcut("alt+o", {
		description: "Launch Oracle research agent",
		handler: async (shortcutCtx) => {
			if (shortcutCtx.mode !== "tui") return;
			const result = await askQuery(shortcutCtx);
			if (result) {
				const launchResult = await launchOracle(result, shortcutCtx);
				shortcutCtx.ui.notify(
					launchResult.ok
						? `🔮 Oracle launched: ${result.slice(0, 50)}`
						: launchResult.error || "Failed to launch oracle.",
					launchResult.ok ? "info" : "error",
				);
			}
		},
	});
}
