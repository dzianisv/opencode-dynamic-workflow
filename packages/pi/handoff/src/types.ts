/**
 * Handoff types - shared across all modules
 */

export interface HandoffMetadata {
	goal: string;
	filesModified: string[];
	filesRead: string[];
	keyDecisions: string[];
	pendingTodos: string[];
	nextSteps: string[];
}

export interface HandoffRecord {
	id: string;
	timestamp: number;
	sourceSessionFile: string;
	targetSessionFile: string | null; // set after approval
	parentHandoffId: string | null; // tree linkage
	summary: string; // full markdown handoff document
	metadata: HandoffMetadata;
	approved: boolean;
}

/** Pending handoff awaiting approval (in-memory only) */
export interface PendingHandoff {
	record: HandoffRecord;
	generatedAt: number;
}

/** Tree node for overlay display */
export interface HandoffTreeNode {
	record: HandoffRecord;
	children: HandoffTreeNode[];
	depth: number;
	isActive: boolean; // is the current session on this node's path
}
