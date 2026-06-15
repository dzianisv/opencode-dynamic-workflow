/**
 * Handoff summary generation - LLM-powered context extraction
 */

import { complete, type Message } from "@earendil-works/pi-ai";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { HandoffMetadata } from "./types.js";

const HANDOFF_SYSTEM_PROMPT = `You are a session handoff specialist. Your job is to produce a comprehensive handoff document that captures everything a fresh agent session needs to continue the work seamlessly.

Given the full conversation history, extract and organize ALL of the following:

## Output Format

Produce a markdown document with EXACTLY these sections:

### 🎯 Goal
What the user is trying to accomplish overall. Be specific.

### 📋 What Was Asked
List each distinct request or task the user asked for, in order.

### 🔍 Research & Exploration
What was explored, investigated, or researched. Include:
- Files read and their purpose
- Documentation consulted
- Patterns discovered
- Architecture decisions explored

### 💡 Key Findings
Important discoveries, insights, and conclusions reached during the session.

### ✅ What Was Done
Concrete changes made, files created/modified, commands run. Be specific with file paths.

### 🔧 Key Decisions
Technical decisions made and their rationale. Format as:
- **Decision**: Rationale

### 📝 Current State
Where things stand right now. What's working, what's partially done.

### 🔲 Pending Tasks
Tasks that remain to be done. If there's a todo list in the session, include all non-done items.

### ⏭️ Next Steps
Ordered list of what should happen next, with enough context to act immediately.

### ⚠️ Critical Context
Anything a new session MUST know to avoid mistakes:
- Environment details
- Gotchas discovered
- Dependencies between tasks
- Constraints mentioned by the user

### 📁 Files Involved
List all files that were read or modified, grouped by action:

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
path/to/new-file.ts
</modified-files>

After the markdown document, output a JSON metadata block:

<metadata>
{
  "goal": "one-line goal description",
  "filesModified": ["path/to/file.ts"],
  "filesRead": ["path/to/file.ts"],
  "keyDecisions": ["decision 1", "decision 2"],
  "pendingTodos": ["todo 1", "todo 2"],
  "nextSteps": ["step 1", "step 2"]
}
</metadata>

Be thorough. The new session will have ZERO context from this conversation. Everything needed to continue must be in this document.`;

export interface GenerateHandoffResult {
	summary: string;
	metadata: HandoffMetadata;
}

interface TodoTaskSnapshot {
	title?: string;
	status?: string;
	owner?: string;
	notes?: string;
}

interface TodoStateSnapshot {
	tasks?: TodoTaskSnapshot[];
}

export async function generateHandoff(
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<GenerateHandoffResult | null> {
	if (!ctx.model) throw new Error("No model selected");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		throw new Error("error" in auth ? auth.error : "No auth available");
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for ${ctx.model.provider}`);
	}

	// Gather full session context
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter(
			(entry): entry is SessionEntry & { type: "message" } =>
				entry.type === "message",
		)
		.map((entry) => entry.message);

	if (messages.length === 0) return null;

	// Extract todo state if present
	const todoEntries = branch.filter(
		(entry): entry is CustomEntry<TodoStateSnapshot> =>
			entry.type === "custom" && entry.customType === "todo-state",
	);
	let todoContext = "";
	if (todoEntries.length > 0) {
		const lastTodo = todoEntries[todoEntries.length - 1];
		const tasks = Array.isArray(lastTodo?.data?.tasks)
			? lastTodo.data.tasks
			: [];
		if (tasks.length > 0) {
			const pending = tasks.filter((task) => task.status !== "done");
			const done = tasks.filter((task) => task.status === "done");
			todoContext = "\n\n## Current Todo State\n";
			if (done.length > 0) {
				todoContext += "\n### Completed:\n";
				todoContext += done
					.map(
						(task) =>
							`- [x] ${task.title || "Untitled"}${task.notes ? ` (${task.notes})` : ""}`,
					)
					.join("\n");
			}
			if (pending.length > 0) {
				todoContext += "\n### Pending:\n";
				todoContext += pending
					.map(
						(task) =>
							`- [ ] [${task.status || "todo"}] ${task.title || "Untitled"}${task.owner ? ` (owner: ${task.owner})` : ""}${task.notes ? ` — ${task.notes}` : ""}`,
					)
					.join("\n");
			}
		}
	}

	// Extract compaction summaries for historical context
	const compactionEntries = branch.filter(
		(entry): entry is CompactionEntry => entry.type === "compaction",
	);
	let compactionContext = "";
	if (compactionEntries.length > 0) {
		compactionContext = "\n\n## Previous Compaction Summaries\n";
		for (const ce of compactionEntries) {
			compactionContext += `\n${ce.summary}\n---\n`;
		}
	}

	// Extract branch summaries
	const branchSummaries = branch.filter(
		(entry): entry is BranchSummaryEntry => entry.type === "branch_summary",
	);
	let branchContext = "";
	if (branchSummaries.length > 0) {
		branchContext = "\n\n## Branch Summaries (explored alternatives)\n";
		for (const bs of branchSummaries) {
			branchContext += `\n${bs.summary}\n---\n`;
		}
	}

	// Serialize conversation
	const llmMessages = convertToLlm(messages);
	if (llmMessages.length === 0) return null;

	const conversationText = serializeConversation(llmMessages);

	// Note: serializeConversation handles truncation internally, but the total
	// prompt (conversation + compaction + branch + todo context) could still be
	// large. The LLM provider will handle token limits via its own truncation.
	const userContent = [
		"## Full Conversation History\n\n",
		conversationText,
		compactionContext,
		branchContext,
		todoContext,
		"\n\n---\nGenerate the handoff document now.",
	].join("");

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: userContent }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") return null;

	const fullText = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	// Parse metadata from the response
	const metadata = parseMetadata(fullText);

	// Extract the summary (everything before the metadata block)
	const metadataIdx = fullText.indexOf("<metadata>");
	const summary =
		metadataIdx >= 0 ? fullText.slice(0, metadataIdx).trim() : fullText.trim();

	return { summary, metadata };
}

function parseMetadata(text: string): HandoffMetadata {
	const defaults: HandoffMetadata = {
		goal: "",
		filesModified: [],
		filesRead: [],
		keyDecisions: [],
		pendingTodos: [],
		nextSteps: [],
	};

	const match = text.match(/<metadata>\s*([\s\S]*?)\s*<\/metadata>/);
	if (!match?.[1]) return defaults;

	// The model can emit non-string array elements (numbers, null). Keep only
	// strings so downstream consumers and the DB round-trip stay consistent.
	const asStringArray = (input: unknown): string[] =>
		Array.isArray(input)
			? input.filter((item): item is string => typeof item === "string")
			: [];

	try {
		const parsed = JSON.parse(match[1]);
		return {
			goal: typeof parsed.goal === "string" ? parsed.goal : "",
			filesModified: asStringArray(parsed.filesModified),
			filesRead: asStringArray(parsed.filesRead),
			keyDecisions: asStringArray(parsed.keyDecisions),
			pendingTodos: asStringArray(parsed.pendingTodos),
			nextSteps: asStringArray(parsed.nextSteps),
		};
	} catch {
		return defaults;
	}
}
