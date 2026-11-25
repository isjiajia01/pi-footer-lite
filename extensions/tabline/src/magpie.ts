/**
 * Non-blocking probe for Magpie's actual routed model when the gateway does not
 * populate `responseModel` in the API response. Reads the tail of Oracle's
 * `~/.config/magpie/usage.jsonl` over SSH and caches the latest `served` model.
 */

import { execFile } from "node:child_process";
import { redraw, S } from "./state.ts";

export const PROBE_COOLDOWN_MS = 2000;

let inflight = false;
let pending: { ctx: any; force: boolean } | undefined;
let lastProbeAt = 0;

export interface ProbeOptions {
	force?: boolean;
	now?: () => number;
	run?: typeof execFile;
}

/** Parse the newest matching `served` model for `req` (preferring `sessionId`) from usage.jsonl lines. */
export function parseMagpieUsage(jsonl: string, req: string, sessionId?: string): string | undefined {
	const lines = jsonl.trim().split("\n");
	let fallback: string | undefined;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let row: any;
		try { row = JSON.parse(line); } catch { continue; }
		if (row?.req !== req || typeof row.served !== "string" || !row.served || row.served === req) continue;
		if (sessionId && (row.session === sessionId || row.native_session === sessionId)) return row.served;
		if (!sessionId && !fallback) fallback = row.served;
	}
	return fallback;
}

/** Kick off a coalesced, throttled background SSH probe if the active model is a Magpie group without responseModel. */
export function probeMagpieRoute(ctx: any, opts: ProbeOptions = {}): void {
	if (!S.enabled || ctx?.mode === "non-tui") return;
	const model = ctx?.model;
	if (model?.provider !== "magpie" || typeof model?.id !== "string" || !model.id.startsWith("group/")) return;
	if (S.stats.lastMsg?.model === model.id && S.stats.lastMsg?.responseModel) return;
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
		["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "oracle", "tail -n 30 ~/.config/magpie/usage.jsonl"],
		{ timeout: 4000, maxBuffer: 256 * 1024 },
		(err, stdout) => {
			inflight = false;
			const next = pending;
			pending = undefined;
			if (!err && stdout && S.enabled) {
				const served = parseMagpieUsage(String(stdout), req, sessionId);
				if (served && (S.routedModel?.req !== req || S.routedModel?.model !== served)) {
					S.routedModel = { req, model: served };
					redraw();
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
	S.routedModel = undefined;
}
