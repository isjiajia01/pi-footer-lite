/**
 * Non-blocking probe for Magpie's actual routed model when the gateway does not
 * populate `responseModel` in the API response. Reads `~/.config/magpie/usage.jsonl`
 * over SSH, at most once per finished answer, and caches the latest `served` model.
 */

import { execFile } from "node:child_process";
import { redraw, S } from "./state.ts";

export const PROBE_COOLDOWN_MS = 2000;

let inflight = false;
let pending: { ctx: any; force: boolean } | undefined;
let lastProbeAt = 0;
/** The last message this probe already resolved, so one run costs one lookup per answer, not per event. */
let probedMsg: unknown;

export interface ProbeOptions {
	force?: boolean;
	now?: () => number;
	run?: typeof execFile;
}

/**
 * Newest `served` model for this request or session. A session match outranks a bare `req` match,
 * because a session that switched models (or sits on a virtual one, whose rung is not known here)
 * still has exactly one newest row that says what answered.
 */
export function parseMagpieUsage(jsonl: string, req: string, sessionId?: string): string | undefined {
	const lines = jsonl.trim().split("\n");
	let sessionOnly: string | undefined;
	let reqOnly: string | undefined;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let row: any;
		try { row = JSON.parse(line); } catch { continue; }
		if (row?.req !== req && !row?.session && !row?.native_session) continue;
		if (typeof row.served !== "string" || !row.served || row.served === req) continue;
		const sameSession = Boolean(sessionId) && (row.session === sessionId || row.native_session === sessionId);
		const sameReq = row.req === req;
		if (sameSession && sameReq) return row.served;
		if (sameSession) sessionOnly ??= row.served;
		if (sameReq) reqOnly ??= row.served;
	}
	return sessionOnly ?? reqOnly;
}

/** `grep` by session keeps the probe fast once usage.jsonl is large; the id is ours, not the shell's. */
function tailCommand(sessionId?: string): string {
	const file = "~/.config/magpie/usage.jsonl";
	return sessionId && /^[A-Za-z0-9_-]{8,64}$/.test(sessionId)
		? `grep -F '${sessionId}' ${file} | tail -n 20`
		: `tail -n 30 ${file}`;
}

/** Kick off a coalesced, throttled background SSH probe when the active model hides the one that answers. */
export function probeMagpieRoute(ctx: any, opts: ProbeOptions = {}): void {
	if (!S.enabled || ctx?.mode === "non-tui") return;
	const model = ctx?.model;
	// `group/*` is a routing group; `router/*` is our own virtual tier, whose rung is decided per session.
	const hidesRoute = typeof model?.id === "string" && (model.id.startsWith("group/") || model.id.startsWith("router/"));
	if (!hidesRoute || (model?.provider !== "magpie" && model?.provider !== "router")) return;
	const msg = S.stats.lastMsg;
	if (S.stats.lastMsg?.model === model.id && S.stats.lastMsg?.responseModel) return;
	// message_end and agent_end both fire for one answer; a forced probe (model_select) still runs.
	if (!opts.force && msg !== undefined && msg === probedMsg) return;
	if (inflight) {
		pending = { ctx, force: Boolean(pending?.force || opts.force) };
		return;
	}

	const now = opts.now?.() ?? Date.now();
	if (!opts.force && lastProbeAt > 0 && now - lastProbeAt < PROBE_COOLDOWN_MS) return;

	const req = model.id;
	const sessionId: string | undefined = ctx?.sessionManager?.getSessionId?.() ?? undefined;
	lastProbeAt = now;
	inflight = true;
	const run = opts.run ?? execFile;
	run(
		"ssh",
		["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "oracle", tailCommand(sessionId)],
		{ timeout: 4000, maxBuffer: 256 * 1024 },
		(err, stdout) => {
			inflight = false;
			const next = pending;
			pending = undefined;
			if (!err && stdout && S.enabled) {
				const served = parseMagpieUsage(String(stdout), req, sessionId);
				if (served) {
					probedMsg = msg;
					if (S.routedModel?.req !== req || S.routedModel?.msg !== msg || S.routedModel?.model !== served) {
						S.routedModel = { req, msg, model: served };
						redraw();
					}
				}
			}
			if (next && S.enabled) probeMagpieRoute(next.ctx, { ...opts, force: next.force });
		},
	);
}

/** Cancel queued probes and reset throttle/cache on shutdown. */
export function stopMagpieProbe(): void {
	pending = undefined;
	lastProbeAt = 0;
	probedMsg = undefined;
	S.routedModel = undefined;
}
