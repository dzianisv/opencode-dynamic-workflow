/**
 * pi-drawer-tui-bars — a two-line custom footer for pi.
 *
 * The pi-native port of the lerian `tui-bars` extension (0.65 → 0.79).
 *
 * Line 1: repo name + active persona `◆ name` | centered session name | git branch.
 * Line 2: model + thinking level | `↑in ↓out ⚡cacheRead $cost` | context `%`.
 *
 * Session names are auto-generated once per session from the first user prompt via a
 * fire-and-forget Haiku `complete()` call (try/catch-guarded, degrades to no name).
 * `ctrl+shift+r` renames manually (empty input disables auto-naming). The footer also
 * reflects persona changes from the personas extension via the `agent-persona:changed`
 * cross-extension event — that exact string must match what personas emits.
 *
 * `setFooter` REPLACES pi's entire footer, so it is mutually exclusive with the
 * statusline package's `setStatus` segment — pick one. This is its own package.
 *
 * Git facts are read with async `pi.exec` (never blocking the render thread), the
 * render factory follows pi's component contract (width-safe, sanitized, never throws),
 * and all footer content is sanitized before display.
 */

import {
	complete,
	getModel,
	type Message,
	type TextContent,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextContent(value: unknown): value is TextContent {
	if (!isRecord(value)) return false;
	return value.type === "text" && typeof value.text === "string";
}

function getPersonaChangedAgentName(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const agent = value.agent;
	if (!isRecord(agent) || typeof agent.name !== "string") return null;
	return agent.name;
}

function getSessionNameEntryData(
	value: unknown,
): { name?: string; autoNamingDisabled?: boolean } | undefined {
	if (!isRecord(value)) return undefined;
	return {
		name: typeof value.name === "string" ? value.name : undefined,
		autoNamingDisabled:
			typeof value.autoNamingDisabled === "boolean"
				? value.autoNamingDisabled
				: undefined,
	};
}

function thinkingColor(level: string): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "thinkingOff";
	}
}

function basename(p: string): string {
	const parts = p.replace(/[/\\]+$/, "").split(/[/\\]+/);
	return parts.at(-1) || p;
}

function dirname(p: string): string {
	const trimmed = p.replace(/[/\\]+$/, "");
	const idx = trimmed.search(/[/\\][^/\\]*$/);
	return idx <= 0 ? trimmed.slice(0, idx + 1) || "" : trimmed.slice(0, idx);
}

export default function (pi: ExtensionAPI) {
	let sessionName: string | undefined;
	let generatingName = false;
	let repoName = "";
	let activeAgentName: string | null = null;
	let autoNamingDisabled = false;
	let requestFooterRender: (() => void) | null = null;

	// Strip ANSI, control chars, and bidi overrides; collapse whitespace (incl. tabs,
	// which would otherwise break the renderer's column math) and clamp to `max`.
	function sanitizeDisplay(input: string, max = 80): string {
		let result = "";
		for (let i = 0; i < input.length; i++) {
			const code = input.charCodeAt(i);
			if (code === 0x1b) continue;
			if (
				code === 0x202a ||
				code === 0x202b ||
				code === 0x202c ||
				code === 0x202d ||
				code === 0x202e ||
				code === 0x2066 ||
				code === 0x2067 ||
				code === 0x2068 ||
				code === 0x2069
			)
				continue;
			const isControl =
				code <= 0x08 ||
				code === 0x0b ||
				code === 0x0c ||
				(code >= 0x0e && code <= 0x1f) ||
				(code >= 0x7f && code <= 0x9f);
			if (isControl) {
				result += " ";
				continue;
			}
			result += input[i] ?? "";
		}
		return result.replace(/\s+/g, " ").trim().slice(0, max);
	}

	// Run a shell command, returning trimmed stdout on success or undefined on
	// failure/non-zero — the async, non-blocking equivalent of execSync (matches the
	// statusline package's git-probe convention).
	const sh = async (
		cmd: string,
		args: string[],
	): Promise<string | undefined> => {
		try {
			const r = await pi.exec(cmd, args);
			return r.code === 0 ? r.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	};

	// Listen for agent persona changes from the personas extension.
	pi.events.on("agent-persona:changed", (data: unknown) => {
		const agentName = getPersonaChangedAgentName(data);
		activeAgentName = agentName ? sanitizeDisplay(agentName, 40) : null;
		requestFooterRender?.();
	});

	// --- Helpers ---

	async function getRepoName(cwd: string): Promise<string> {
		const repoRoot = await sh("git", [
			"-C",
			cwd,
			"rev-parse",
			"--show-toplevel",
		]);
		if (repoRoot) return basename(repoRoot);

		const current = basename(cwd);
		const parent = basename(dirname(cwd));
		return parent && parent !== "." && parent !== "/"
			? `${parent}/${current}`
			: current;
	}

	async function generateSessionName(
		prompt: string,
		ctx: ExtensionContext,
	): Promise<string | undefined> {
		const model = getModel("anthropic", "claude-haiku-4-5");
		if (!model) return undefined;

		if (typeof ctx.modelRegistry?.getApiKeyAndHeaders !== "function")
			return undefined;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth?.ok || !auth.apiKey) return undefined;

		const messages: Message[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `Generate a very short session name (2-4 words max, no quotes, no punctuation) that captures the essence of this task:\n\n"${prompt.slice(0, 500)}"`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await complete(
				model,
				{
					systemPrompt:
						"You generate ultra-short session names. Reply with ONLY the name, nothing else. Lowercase, 2-4 words.",
					messages,
				},
				{ apiKey: auth.apiKey, headers: auth.headers },
			);

			const name = response.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim()
				.slice(0, 40);

			return name ? sanitizeDisplay(name, 40) : undefined;
		} catch {
			return undefined;
		}
	}

	// --- Footer (bottom bar) ---

	function setupFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter(
			(tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
				requestFooterRender = () => tui.requestRender();
				// Cache token/cost stats — recompute only when the branch changes.
				let cachedInput = 0;
				let cachedOutput = 0;
				let cachedCacheRead = 0;
				let cachedCost = 0;
				let statsDirty = true;

				function recomputeStats() {
					cachedInput = 0;
					cachedOutput = 0;
					cachedCacheRead = 0;
					cachedCost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const usage = e.message.usage;
							if (!usage) continue;
							cachedInput += typeof usage.input === "number" ? usage.input : 0;
							cachedOutput +=
								typeof usage.output === "number" ? usage.output : 0;
							cachedCacheRead +=
								typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
							const c = usage.cost?.total;
							if (typeof c === "number" && !Number.isNaN(c)) cachedCost += c;
						}
					}
					statsDirty = false;
				}

				const unsub = footerData.onBranchChange(() => {
					statsDirty = true;
					tui.requestRender();
				});

				return {
					dispose() {
						if (requestFooterRender) requestFooterRender = null;
						unsub();
					},
					invalidate() {
						statsDirty = true;
					},
					render(width: number): string[] {
						try {
							if (statsDirty) recomputeStats();

							const input = cachedInput;
							const output = cachedOutput;
							const cacheRead = cachedCacheRead;
							const cost = cachedCost;

							const fmt = (n: number) =>
								n < 1000
									? `${n}`
									: n < 100_000
										? `${(n / 1000).toFixed(1)}k`
										: `${Math.round(n / 1000)}k`;

							// Context usage — pi 0.79 exposes `percent` directly; degrade to "".
							const usage = ctx.getContextUsage?.();
							const ctxPct =
								usage &&
								typeof usage.percent === "number" &&
								Number.isFinite(usage.percent)
									? `${Math.round(usage.percent)}%`
									: "";

							// Pieces
							const modelId = ctx.model?.id || "no model";
							const branch = footerData.getGitBranch();

							// Session display
							const nameStr = sessionName
								? sanitizeDisplay(sessionName, 40)
								: generatingName
									? "naming…"
									: "";

							// --- Line 1: repo | session name (true center) | git branch ---
							const agentTag = activeAgentName
								? theme.fg("accent", " ◆ ") +
									theme.fg(
										"accent",
										theme.bold(sanitizeDisplay(activeAgentName, 32)),
									)
								: "";
							const l1Left =
								theme.fg(
									"accent",
									theme.bold(` ${sanitizeDisplay(repoName || "pi", 24)}`),
								) + agentTag;
							const l1Right = branch
								? theme.fg("dim", ` ${sanitizeDisplay(branch, 40)} `)
								: "";
							const l1Center = nameStr ? theme.fg("muted", nameStr) : "";

							const leftW = visibleWidth(l1Left);
							const rightW = visibleWidth(l1Right);
							const centerW = visibleWidth(l1Center);

							// True center: place center text at (width - centerW) / 2.
							const centerPos = Math.floor((width - centerW) / 2);
							const leftGap = Math.max(1, centerPos - leftW);
							const rightGap = Math.max(
								1,
								width - leftW - leftGap - centerW - rightW,
							);

							// --- Line 2: model + thinking (left) | tokens+cache+cost (center) | ctx% (right) ---
							const thinking = pi.getThinkingLevel();
							const thinkingStr =
								thinking !== "off"
									? theme.fg("dim", " · ") +
										theme.fg(thinkingColor(thinking), thinking)
									: "";
							const l2Left =
								theme.fg("accent", ` ${sanitizeDisplay(modelId, 40)}`) +
								thinkingStr;
							const l2Right = ctxPct ? theme.fg("muted", `${ctxPct} `) : "";
							const l2Center =
								theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)}`) +
								(cacheRead > 0 ? theme.fg("dim", ` ⚡${fmt(cacheRead)}`) : "") +
								theme.fg("dim", ` $${cost.toFixed(3)}`);

							const l2LeftW = visibleWidth(l2Left);
							const l2RightW = visibleWidth(l2Right);
							const l2CenterW = visibleWidth(l2Center);
							const l2CenterPos = Math.floor((width - l2CenterW) / 2);
							const l2LeftGap = Math.max(1, l2CenterPos - l2LeftW);
							const l2RightGap = Math.max(
								1,
								width - l2LeftW - l2LeftGap - l2CenterW - l2RightW,
							);

							return [
								truncateToWidth(
									l1Left +
										" ".repeat(leftGap) +
										l1Center +
										" ".repeat(rightGap) +
										l1Right,
									width,
								),
								truncateToWidth(
									l2Left +
										" ".repeat(l2LeftGap) +
										l2Center +
										" ".repeat(l2RightGap) +
										l2Right,
									width,
								),
							];
						} catch {
							// The render path is cosmetic — never throw, never wedge the frame
							// pipeline. Degrade to the repo name (or a stable placeholder).
							return [
								truncateToWidth(sanitizeDisplay(repoName || "pi", 24), width),
								"",
							];
						}
					},
				};
			},
		);
	}

	// --- Rename shortcut (Ctrl+Shift+R) ---

	pi.registerShortcut("ctrl+shift+r", {
		description: "Rename session",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const current = sessionName || "";
			const name = await ctx.ui.input("Session name:", current);
			if (name === undefined) return; // cancelled
			const trimmed = name.trim();
			if (trimmed) {
				sessionName = sanitizeDisplay(trimmed, 40);
				autoNamingDisabled = false;
				pi.setSessionName(sessionName);
				pi.appendEntry("tui-bars-session-name", {
					name: sessionName,
					autoNamingDisabled: false,
				});
			} else {
				sessionName = undefined;
				autoNamingDisabled = true;
				pi.setSessionName("");
				pi.appendEntry("tui-bars-session-name", {
					name: "",
					autoNamingDisabled: true,
				});
			}
			requestFooterRender?.();
		},
	});

	// --- Events ---

	pi.on("session_start", async (_event, ctx) => {
		repoName = await getRepoName(ctx.cwd);
		sessionName = pi.getSessionName() || undefined;
		generatingName = false;
		autoNamingDisabled = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				entry.customType === "tui-bars-session-name"
			) {
				const data = getSessionNameEntryData(entry.data);
				autoNamingDisabled = Boolean(data?.autoNamingDisabled);
				if (typeof data?.name === "string") {
					sessionName = data.name || undefined;
				}
			}
		}

		setupFooter(ctx);
		requestFooterRender?.();
	});

	// Generate a session name from the first user prompt, once per session.
	pi.on("agent_end", async (_event, ctx) => {
		if (sessionName || generatingName || autoNamingDisabled) return;

		// Find the first user message in the active branch.
		const branch = ctx.sessionManager.getBranch();
		const firstUserMsg = branch.find(
			(e) => e.type === "message" && e.message.role === "user",
		);
		if (firstUserMsg?.type !== "message") return;

		const content =
			firstUserMsg.message.role === "user"
				? firstUserMsg.message.content
				: undefined;
		if (!content) return;
		let promptText = "";
		if (typeof content === "string") {
			promptText = content;
		} else if (Array.isArray(content)) {
			promptText = content
				.filter((item): item is TextContent => isTextContent(item))
				.map((item) => item.text)
				.join(" ");
		}

		if (!promptText.trim()) return;

		generatingName = true;
		requestFooterRender?.();
		const name = await generateSessionName(promptText, ctx);
		generatingName = false;

		if (name) {
			sessionName = name;
			autoNamingDisabled = false;
			pi.setSessionName(name);
			pi.appendEntry("tui-bars-session-name", {
				name,
				autoNamingDisabled: false,
			});
		}

		requestFooterRender?.();
	});
}
