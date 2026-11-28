/**
 * Non-blocking probe for Magpie's actual routed model when the gateway does not
 * populate `responseModel` in the API response. Asks the gateway's own route record
 * (`GET /v1/magpie/route?session=…`, one 429-byte answer) and falls back to reading
 * `~/.config/magpie/usage.jsonl` over SSH. At most once per finished answer.
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
	fetchImpl?: typeof fetch;
}

/** Provider whose base URL and key reach the gateway that wrote the route record. */
const GATEWAY_PROVIDER = "magpie";
const ROUTE_TIMEOUT_MS = 3000;

/**
 * Ask the gateway what this session's last request was served by. Cheaper and more exact than the
 * usage log: 429 bytes and no subprocess, and it carries the group, effort and fallback tries.
 */
async function routeOverHttp(ctx: any, sessionId: string | undefined, fetchImpl?: typeof fetch): Promise<string | undefined> {
	const doFetch = fetchImpl ?? (globalThis as any).fetch;
	const registry = ctx?.modelRegistry;
	if (!sessionId || typeof doFetch !== "function" || !registry?.getApiKeyAndHeaders) return undefined;
	// A virtual model (`router/std`) names no endpoint of its own; the gateway provider does.
	const gateway = ctx?.model?.provider === GATEWAY_PROVIDER
		? ctx.model
		: (registry.getModelsOfType?.("chat", GATEWAY_PROVIDER) ?? [])[0];
	if (!gateway) return undefined;
	let auth: any;
	try { auth = await registry.getApiKeyAndHeaders(gateway); } catch { return undefined; }
	if (!auth?.ok || !auth.apiKey) return undefined;
	// The endpoint lives on the model's configured base URL; auth resolves the key, not the host.
	const base = String(gateway.baseUrl ?? auth.baseUrl ?? "").replace(/\/+$/, "");
	if (!base) return undefined;
	const res = await doFetch(`${base}/magpie/route?session=${encodeURIComponent(sessionId)}`, {
		headers: { ...auth.headers, Authorization: `Bearer ${auth.apiKey}` },
		signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
	});
	if (!res?.ok) return undefined;
	const body: any = await res.json();
	const route = body?.route;
	const served = typeof route?.served === "string" && route.served ? route.served
		: typeof route?.model === "string" ? route.model.slice(route.model.lastIndexOf("/") + 1) : undefined;
	return served || undefined;
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

/**
 * Kick off a coalesced, throttled probe when the active model hides the one that answers.
 * Returns the work so a test can await it; callers in Pi's event handlers ignore it.
 */
export function probeMagpieRoute(ctx: any, opts: ProbeOptions = {}): Promise<void> | undefined {
	if (!S.enabled || ctx?.mode === "non-tui") return;
	const model = ctx?.model;
	// `group/*` is a routing group; the `router` provider is our own virtual tier, whose rung is decided
	// per session (Pi reports that model as `{provider:"router", id:"std"}`, without the catalog prefix).
	const hidesRoute = model?.provider === "router" || (typeof model?.id === "string" && model.id.startsWith("group/"));
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
	const finish = () => {
		inflight = false;
		const next = pending;
		pending = undefined;
		if (next && S.enabled) probeMagpieRoute(next.ctx, { ...opts, force: next.force });
	};
	const apply = (served: string | undefined) => {
		if (!served || !S.enabled) return;
		probedMsg = msg;
		if (S.routedModel?.req !== req || S.routedModel?.msg !== msg || S.routedModel?.model !== served) {
			S.routedModel = { req, msg, model: served };
			redraw();
		}
	};
	const overSsh = () => new Promise<string | undefined>((resolve) => {
		run(
			"ssh",
			["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", "oracle", tailCommand(sessionId)],
			{ timeout: 4000, maxBuffer: 256 * 1024 },
			(err, stdout) => resolve(err || !stdout ? undefined : parseMagpieUsage(String(stdout), req, sessionId)),
		);
	});
	// The gateway answers far cheaper than an SSH round trip; the log stays as the fallback.
	return routeOverHttp(ctx, sessionId, opts.fetchImpl)
		.catch(() => undefined)
		.then((served) => served ?? overSsh().catch(() => undefined))
		.then((served) => apply(served))
		.catch(() => {})
		.finally(finish);
}

/** Cancel queued probes and reset throttle/cache on shutdown. */
export function stopMagpieProbe(): void {
	pending = undefined;
	lastProbeAt = 0;
	probedMsg = undefined;
	S.routedModel = undefined;
}
