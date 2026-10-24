/**
 * Session output stats (pure). Scope matches pi's own ↓ total: assistant + toolResult
 * output plus usage/compaction/branch_summary entries. `dirty` forces a full rescan
 * on the next footer render (after tree/compaction/agent_end, when increments may lie).
 */

export type Msg = {
	role?: string; model?: string; responseModel?: string; stopReason?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};

export interface Stats {
	outTotal: number;
	/** Last successful assistant message (drives cache-hit and the routed-model suffix). */
	lastMsg: Msg | undefined;
	/** Speed of the last streamed assistant message; persists until the next one. */
	tokPerSec: number | undefined;
	dirty: boolean;
}

export const okMsg = (m: Msg) => m.stopReason !== "error" && m.stopReason !== "aborted";

/** Full recount from session entries. Keeps tokPerSec (not derivable from entries). */
export function scanEntries(entries: readonly any[], into: Stats): void {
	let out = 0;
	let last: Msg | undefined;
	for (const e of entries) {
		const m = e?.type === "message" ? (e.message as Msg) : undefined;
		if (m?.role === "toolResult") out += m.usage?.output ?? 0;
		else if (m?.role === "assistant") { out += m.usage?.output ?? 0; if (okMsg(m)) last = m; }
		else if (e?.type === "usage" || e?.type === "compaction" || e?.type === "branch_summary") out += e.usage?.output ?? 0;
	}
	into.outTotal = out;
	into.lastMsg = last;
	into.dirty = false;
}

/** Incremental update on message_end. `streamStart` = first delta time (ms) or undefined. */
export function addMessage(s: Stats, m: Msg | undefined, now: number, streamStart: number | undefined): void {
	if (!m || s.dirty) return; // a rescan is pending and will count it
	const out = m.usage?.output ?? 0;
	if (m.role === "assistant") {
		s.outTotal += out;
		if (okMsg(m)) s.lastMsg = m;
		if (streamStart !== undefined && out > 0) {
			const secs = (now - streamStart) / 1000;
			if (secs >= 0.5) s.tokPerSec = out / secs;
		}
	} else if (m.role === "toolResult") s.outTotal += out;
}

/** Cache-hit % of the last request, or undefined when the provider reported no cache use. */
export function cacheHit(m: Msg | undefined): number | undefined {
	const u = m?.usage;
	const denom = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
	if (!u || denom <= 0 || !(u.cacheRead || u.cacheWrite)) return undefined;
	return Math.min(100, ((u.cacheRead ?? 0) / denom) * 100);
}
