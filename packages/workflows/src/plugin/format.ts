/**
 * Shared duration humanizer for every workflow display surface (Task 6.2 polish).
 *
 * ONE implementation, used by the status render (header total-elapsed, per-agent
 * elapsed, terminal duration), the live TUI title, and the chat.message digest —
 * so the same elapsed never renders two different ways across surfaces.
 *
 * Bands (chosen for at-a-glance scanning of a live run):
 *   - < 1s   → whole milliseconds, e.g. `800ms`
 *   - < 60s  → seconds with one decimal, e.g. `4.2s`
 *   - < 60m  → whole minutes + whole seconds, e.g. `1m42s` (`1m` when 0s)
 *   - ≥ 1h   → hours + zero-padded minutes, e.g. `1h03m` (`1h` when 0m)
 *
 * Negative or non-finite inputs clamp to `0ms` — a display path must never emit
 * `NaNms` or a negative duration even if a clock view is momentarily skewed.
 */
export function humanizeDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return "0ms";
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < 60_000) {
		// One decimal of seconds: 4200ms → "4.2s", 5000ms → "5.0s".
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 3600) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	// Zero-padded minutes so the hour band reads as a stable `1h03m` clock form.
	return minutes > 0
		? `${hours}h${String(minutes).padStart(2, "0")}m`
		: `${hours}h`;
}
