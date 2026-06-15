/**
 * pi-drawer-personas — persistent agent personas for pi.
 *
 * Activates a persona via the `$` prefix in the editor (or the `/personas` command /
 * Alt+4 picker). Once active, the persona body is appended to the system prompt on
 * every turn via `before_agent_start` — THE core mechanism — until deactivated. A
 * persona may pin a model + thinking level; the prior runtime is captured and restored
 * on deactivation. State persists across restarts through `appendEntry`.
 *
 *   $                     → open the picker overlay
 *   $backend-go           → activate that persona directly
 *   $backend-go fix auth  → activate + send "fix auth"
 *   $off / $none          → deactivate
 *
 * Persona files: `~/.pi/agent/agents/*.md` (user, honors `$PI_AGENT_DIR`) or
 * `.pi/agents/*.md` (project-local, walked from cwd). YAML frontmatter:
 * name / description / model? / thinking?, body is the persona prompt.
 *
 * pi loads this module's default export once and calls it with the `ExtensionAPI`.
 * The factory only REGISTERS — action methods throw at load, so all state lives in
 * closures and is touched only from handlers/commands. It emits the cross-extension
 * event `agent-persona:changed` (consumed verbatim by the tui-bars extension).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type AgentDef,
	loadAgents,
	normalizeThinking,
	type PersistedPersonaState,
	type ThinkingLevel,
} from "./agents";
import { showPicker } from "./picker";

type AvailableModel = ReturnType<
	ExtensionContext["modelRegistry"]["getAvailable"]
>[number];

const WIDGET_KEY = "agent-persona";
const PERSONA_ENTRY = "agent-persona";

export default function (pi: ExtensionAPI) {
	let allAgents: AgentDef[] = [];
	let activeAgent: AgentDef | null = null;
	let cwd = "";
	let previousRuntime: {
		modelId: string | null;
		thinking: ThinkingLevel;
	} | null = null;
	// Guards against a stale async model/thinking apply clobbering a newer activation.
	let activationSeq = 0;

	// ── Cross-extension signal ──────────────────────────────────────────

	function emitPersonaChanged(agent: AgentDef | null) {
		// String literal is load-bearing: tui-bars subscribes to it verbatim.
		pi.events.emit("agent-persona:changed", {
			agent: agent
				? {
						id: agent.id,
						name: agent.name,
						source: agent.source,
						model: agent.model,
						thinking: agent.thinking,
					}
				: null,
		});
	}

	function notify(
		ctx: ExtensionContext | null | undefined,
		message: string,
		level: "info" | "warning" | "error",
	) {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
	}

	// ── Runtime model / thinking application ────────────────────────────

	function resolveModel(
		ctx: ExtensionContext,
		modelInput: string,
	): AvailableModel | null {
		const available = ctx.modelRegistry?.getAvailable?.();
		if (!Array.isArray(available)) return null;
		const query = modelInput.toLowerCase();
		let match = available.find((model) => model.id?.toLowerCase?.() === query);
		if (!match) {
			const fuzzy = available.filter((model) =>
				model.id?.toLowerCase?.().includes(query),
			);
			if (fuzzy.length === 1) match = fuzzy[0];
		}
		if (!match) {
			const byName = available.filter((model) =>
				model.name?.toLowerCase?.().includes(query),
			);
			if (byName.length === 1) match = byName[0];
		}
		return match ?? null;
	}

	async function applyPersonaRuntime(
		agent: AgentDef | null,
		ctx: ExtensionContext,
	): Promise<boolean> {
		if (!agent) return true;

		if (agent.model) {
			const resolved = resolveModel(ctx, agent.model);
			if (!resolved) {
				notify(ctx, `Persona model not found: ${agent.model}`, "error");
				return false;
			}
			const success = await pi.setModel(resolved);
			if (!success) {
				notify(
					ctx,
					`No API key available for persona model: ${resolved.id}`,
					"error",
				);
				return false;
			}
		}

		if (agent.thinking) {
			const thinking = normalizeThinking(agent.thinking);
			if (!thinking) {
				notify(
					ctx,
					`Invalid persona thinking level: ${agent.thinking}`,
					"error",
				);
				return false;
			}
			pi.setThinkingLevel(thinking);
		}

		return true;
	}

	async function restorePreviousRuntime(ctx: ExtensionContext) {
		if (!previousRuntime) return;
		if (previousRuntime.modelId) {
			const resolved = resolveModel(ctx, previousRuntime.modelId);
			if (resolved) await pi.setModel(resolved);
		}
		pi.setThinkingLevel(previousRuntime.thinking);
	}

	// ── Activate / deactivate ───────────────────────────────────────────

	async function activateAgent(agent: AgentDef, ctx: ExtensionContext) {
		const seq = ++activationSeq;
		const nextPreviousRuntime = previousRuntime ?? {
			modelId: ctx.model?.id ?? null,
			thinking: pi.getThinkingLevel() as ThinkingLevel,
		};
		const applied = await applyPersonaRuntime(agent, ctx);
		if (seq !== activationSeq) return; // a newer activation superseded us
		if (!applied) return;
		previousRuntime = nextPreviousRuntime;
		activeAgent = agent;
		pi.appendEntry<PersistedPersonaState>(PERSONA_ENTRY, {
			agentId: agent.id,
			restoreModelId: previousRuntime.modelId,
			restoreThinking: previousRuntime.thinking,
		});
		emitPersonaChanged(agent);
		updateWidget(ctx);
		notify(ctx, `Agent activated: ${agent.name}`, "info");
	}

	async function deactivateAgent(ctx: ExtensionContext) {
		activationSeq += 1; // invalidate any in-flight activation
		activeAgent = null;
		await restorePreviousRuntime(ctx);
		previousRuntime = null;
		pi.appendEntry<PersistedPersonaState>(PERSONA_ENTRY, {
			agentId: null,
			restoreModelId: null,
			restoreThinking: null,
		});
		emitPersonaChanged(null);
		updateWidget(ctx);
		notify(ctx, "Agent deactivated", "info");
	}

	// ── Widget (pill above editor) ──────────────────────────────────────

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (!activeAgent) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const agent = activeAgent;
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme: Theme) => {
			const label =
				theme.fg("accent", theme.bold("◆ ")) +
				theme.fg("accent", agent.name) +
				theme.fg("dim", ` (${agent.source})`);
			return new Text(label, 0, 0);
		});
	}

	// ── Picker glue ─────────────────────────────────────────────────────

	async function runPicker(ctx: ExtensionContext) {
		const result = await showPicker(ctx, allAgents, activeAgent?.id ?? null);
		if (result === "deactivate") {
			if (activeAgent) await deactivateAgent(ctx);
		} else if (result) {
			await activateAgent(result, ctx);
		}
	}

	// ── Input interception ($-prefix) ───────────────────────────────────

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const text = typeof event.text === "string" ? event.text.trim() : "";
		if (!text.startsWith("$")) return { action: "continue" as const };

		allAgents = await loadAgents(cwd);

		// "$" alone → picker
		if (text === "$") {
			await runPicker(ctx);
			return { action: "handled" as const };
		}

		const afterDollar = text.slice(1).trim();

		// "$off" / "$none" → deactivate
		if (afterDollar === "off" || afterDollar === "none") {
			if (activeAgent) await deactivateAgent(ctx);
			else notify(ctx, "No agent is active", "info");
			return { action: "handled" as const };
		}

		// "$name" or "$name message" → activate, optionally forwarding the message
		const spaceIdx = afterDollar.indexOf(" ");
		const agentId =
			spaceIdx === -1 ? afterDollar : afterDollar.slice(0, spaceIdx);
		const remainder =
			spaceIdx === -1 ? "" : afterDollar.slice(spaceIdx + 1).trim();

		// Only intercept when this really names a persona; otherwise let "$foo" through
		// as ordinary input (it may be a shell var, a price, etc.).
		const isPersonaCommand = allAgents.some(
			(agent) => agent.id === agentId || agent.id.startsWith(agentId),
		);
		if (!isPersonaCommand) return { action: "continue" as const };

		let agent = allAgents.find((a) => a.id === agentId);
		if (!agent) {
			const prefixMatches = allAgents.filter((a) => a.id.startsWith(agentId));
			if (prefixMatches.length === 1) {
				agent = prefixMatches[0];
			} else if (prefixMatches.length > 1) {
				notify(
					ctx,
					`Ambiguous: ${prefixMatches.map((a) => a.id).join(", ")}`,
					"warning",
				);
				return { action: "handled" as const };
			}
		}

		if (!agent) {
			notify(ctx, `Agent not found: ${agentId}`, "error");
			return { action: "handled" as const };
		}

		await activateAgent(agent, ctx);

		if (remainder) {
			return { action: "transform" as const, text: remainder };
		}
		return { action: "handled" as const };
	});

	// ── System prompt injection (the core mechanism) ────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!activeAgent) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n# Active Agent Persona\n\nYou are operating as: **${activeAgent.name}**\n\n${activeAgent.body}`,
		};
	});

	// ── Session lifecycle ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		allAgents = await loadAgents(cwd);

		// Replay persisted state: the last agent-persona entry wins.
		activeAgent = null;
		previousRuntime = null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === PERSONA_ENTRY) {
				const data = entry.data as PersistedPersonaState | undefined;
				if (data?.restoreThinking) {
					const thinking = normalizeThinking(data.restoreThinking);
					if (thinking) {
						previousRuntime = {
							modelId:
								typeof data.restoreModelId === "string"
									? data.restoreModelId
									: null,
							thinking,
						};
					}
				}
				activeAgent = data?.agentId
					? (allAgents.find((a) => a.id === data.agentId) ?? null)
					: null;
			}
		}

		if (activeAgent) {
			const restored = await applyPersonaRuntime(activeAgent, ctx);
			if (!restored) activeAgent = null;
		}

		emitPersonaChanged(activeAgent);
		updateWidget(ctx);
	});

	// ── Command: /personas ──────────────────────────────────────────────

	pi.registerCommand("personas", {
		description: "List available agent personas or manage the active agent",
		handler: async (args, ctx) => {
			const subcommand = args?.trim();

			if (!subcommand || subcommand === "list") {
				allAgents = await loadAgents(cwd);
				if (allAgents.length === 0) {
					notify(ctx, "No agents found", "info");
					return;
				}
				const lines = allAgents.map((a) => {
					const active = activeAgent?.id === a.id ? " ● " : "   ";
					return `${active}${a.id} — ${a.name} [${a.source}]`;
				});
				notify(ctx, lines.join("\n"), "info");
				return;
			}

			if (subcommand === "off" || subcommand === "none") {
				if (activeAgent) await deactivateAgent(ctx);
				else notify(ctx, "No agent is active", "info");
				return;
			}

			if (subcommand === "reload") {
				allAgents = await loadAgents(cwd);
				if (activeAgent) {
					const nextActive =
						allAgents.find((agent) => agent.id === activeAgent?.id) ?? null;
					activeAgent = nextActive;
					if (!activeAgent) {
						previousRuntime = null;
						emitPersonaChanged(null);
					} else {
						const applied = await applyPersonaRuntime(activeAgent, ctx);
						if (!applied) {
							activeAgent = null;
							previousRuntime = null;
							emitPersonaChanged(null);
						} else {
							emitPersonaChanged(activeAgent);
						}
					}
					updateWidget(ctx);
				}
				notify(ctx, `Loaded ${allAgents.length} agents`, "info");
				return;
			}

			// Activate by exact id.
			const agent = allAgents.find((a) => a.id === subcommand);
			if (agent) await activateAgent(agent, ctx);
			else notify(ctx, `Agent not found: ${subcommand}`, "error");
		},
	});

	// ── Shortcut: Alt+4 ($) opens the picker ────────────────────────────

	pi.registerShortcut("alt+4", {
		description: "Open agent persona picker",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			allAgents = await loadAgents(cwd);
			await runPicker(ctx);
		},
	});
}
