/**
 * File sink for diagnostics.
 *
 * pi's TUI is a differential renderer that owns the screen; any console.* /
 * stdout / stderr write lands mid-frame and desyncs it (garbled output, ghost
 * lines). There is no centralized pi logger to import, so we append our own to a
 * file under the agent data dir. Never log to the console while a TUI is mounted.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = join(homedir(), ".pi", "agent", "handoff.log");

export function logError(context: string, err: unknown): void {
	const detail =
		err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
	try {
		appendFileSync(
			LOG_PATH,
			`${new Date().toISOString()} [handoff] ${context}: ${detail}\n`,
		);
	} catch {
		// Logging is best-effort; never let a failed write surface in the TUI.
	}
}
