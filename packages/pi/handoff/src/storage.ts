/**
 * Handoff storage - SQLite persistence for cross-session handoff tree.
 *
 * Uses `bun:sqlite` (drawers run under Bun): synchronous, zero install, no build
 * step. The DB lives at the original `~/.pi/agent/handoffs.db` so existing handoff
 * history (written by the better-sqlite3 build) is preserved — bun:sqlite opens
 * the standard SQLite file unchanged.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { HandoffMetadata, HandoffRecord } from "./types.js";

let db: Database | null = null;

interface HandoffRow {
	id: string;
	timestamp: number;
	source_session_file: string;
	target_session_file: string | null;
	parent_handoff_id: string | null;
	summary: string;
	metadata_json: string;
	approved: number;
}

function getDbPath(): string {
	// Preserve the original path — live handoff history lives here. Do NOT
	// relocate to the pi-drawers data dir or the user's tree is orphaned.
	return path.join(homedir(), ".pi", "agent", "handoffs.db");
}

function openAndInitDb(dbPath: string): Database {
	const next = new Database(dbPath);
	// bun:sqlite opens lazily, so a corrupt file usually throws here (on the
	// first statement), not at construction. Run init eagerly so the caller's
	// recovery path can catch corruption.
	// bun:sqlite has no `.pragma()` helper — issue PRAGMAs via exec().
	next.exec("PRAGMA journal_mode = WAL");
	next.exec("PRAGMA foreign_keys = ON");

	next.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      source_session_file TEXT NOT NULL,
      target_session_file TEXT,
      parent_handoff_id TEXT,
      summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      label TEXT,
      approved INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (parent_handoff_id) REFERENCES handoffs(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_handoffs_parent ON handoffs(parent_handoff_id);
    CREATE INDEX IF NOT EXISTS idx_handoffs_source ON handoffs(source_session_file);
    CREATE INDEX IF NOT EXISTS idx_handoffs_target ON handoffs(target_session_file);
    CREATE INDEX IF NOT EXISTS idx_handoffs_timestamp ON handoffs(timestamp);
  `);

	return next;
}

function ensureDb(): Database {
	if (db) return db;

	const dbPath = getDbPath();
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	try {
		db = openAndInitDb(dbPath);
	} catch (_err) {
		// Construction or eager init failed — treat the file as corrupted, back
		// it up (or delete it), then recreate fresh.
		const backupPath = `${dbPath}.corrupt.${Date.now()}`;
		try {
			fs.renameSync(dbPath, backupPath);
		} catch {
			// If rename fails, just delete it
			try {
				fs.unlinkSync(dbPath);
			} catch {
				/* ignore */
			}
		}
		db = openAndInitDb(dbPath);
	}

	return db;
}

// ── CRUD ────────────────────────────────────────────────────────────

export function insertHandoff(record: HandoffRecord): void {
	const d = ensureDb();
	d.prepare(`
    INSERT OR REPLACE INTO handoffs
      (id, timestamp, source_session_file, target_session_file,
       parent_handoff_id, summary, metadata_json, label, approved)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		record.id,
		record.timestamp,
		record.sourceSessionFile,
		record.targetSessionFile,
		record.parentHandoffId,
		record.summary,
		JSON.stringify(record.metadata),
		null,
		record.approved ? 1 : 0,
	);
}

export function updateHandoffApproval(
	id: string,
	targetSessionFile: string,
): void {
	const d = ensureDb();
	d.prepare(`
    UPDATE handoffs SET approved = 1, target_session_file = ? WHERE id = ?
  `).run(targetSessionFile, id);
}

export function updateHandoffSummary(
	id: string,
	summary: string,
	metadata: HandoffMetadata,
): void {
	const d = ensureDb();
	d.prepare(
		"UPDATE handoffs SET summary = ?, metadata_json = ? WHERE id = ?",
	).run(summary, JSON.stringify(metadata), id);
}

export function getHandoff(id: string): HandoffRecord | null {
	const d = ensureDb();
	const row = d
		.prepare("SELECT * FROM handoffs WHERE id = ?")
		.get(id) as HandoffRow | null;
	return row ? rowToRecord(row) : null;
}

export function getHandoffByTargetSession(
	sessionFile: string,
): HandoffRecord | null {
	const d = ensureDb();
	const row = d
		.prepare("SELECT * FROM handoffs WHERE target_session_file = ?")
		.get(sessionFile) as HandoffRow | null;
	return row ? rowToRecord(row) : null;
}

export function getAllHandoffs(): HandoffRecord[] {
	const d = ensureDb();
	const rows = d
		.prepare("SELECT * FROM handoffs ORDER BY timestamp ASC")
		.all() as HandoffRow[];
	return rows.map(rowToRecord);
}

export function getLatestHandoffForSession(
	sessionFile: string,
): HandoffRecord | null {
	const d = ensureDb();
	const row = d
		.prepare(
			"SELECT * FROM handoffs WHERE source_session_file = ? ORDER BY timestamp DESC LIMIT 1",
		)
		.get(sessionFile) as HandoffRow | null;
	return row ? rowToRecord(row) : null;
}

export function getUnapprovedHandoffsForSession(
	sessionFile: string,
): HandoffRecord[] {
	const d = ensureDb();
	const rows = d
		.prepare(
			"SELECT * FROM handoffs WHERE source_session_file = ? AND approved = 0 ORDER BY timestamp DESC",
		)
		.all(sessionFile) as HandoffRow[];
	return rows.map(rowToRecord);
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

function normalizeMetadata(value: unknown): HandoffMetadata {
	const data =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: {};
	const asStringArray = (input: unknown): string[] =>
		Array.isArray(input)
			? input.filter((item): item is string => typeof item === "string")
			: [];

	return {
		goal: typeof data.goal === "string" ? data.goal : "",
		filesModified: asStringArray(data.filesModified),
		filesRead: asStringArray(data.filesRead),
		keyDecisions: asStringArray(data.keyDecisions),
		pendingTodos: asStringArray(data.pendingTodos),
		nextSteps: asStringArray(data.nextSteps),
	};
}

function rowToRecord(row: HandoffRow): HandoffRecord {
	let parsedMetadata: unknown = {};
	try {
		parsedMetadata = JSON.parse(row.metadata_json ?? "{}");
	} catch {
		parsedMetadata = {};
	}

	return {
		id: typeof row.id === "string" ? row.id : "",
		timestamp: typeof row.timestamp === "number" ? row.timestamp : 0,
		sourceSessionFile:
			typeof row.source_session_file === "string"
				? row.source_session_file
				: "ephemeral",
		targetSessionFile:
			typeof row.target_session_file === "string" &&
			row.target_session_file.length > 0
				? row.target_session_file
				: null,
		parentHandoffId:
			typeof row.parent_handoff_id === "string" &&
			row.parent_handoff_id.length > 0
				? row.parent_handoff_id
				: null,
		summary: typeof row.summary === "string" ? row.summary : "",
		metadata: normalizeMetadata(parsedMetadata),
		approved: !!row.approved,
	};
}
