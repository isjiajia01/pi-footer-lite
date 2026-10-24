/**
 * Perch push-notification status — UI hook only, no Perch I/O here.
 *
 * Wire contract (recommended, zero coupling): the Perch extension (remote_pi) calls
 *   ctx.ui.setStatus("remote-pi:push", "push: registered")        → ● push   (ok)
 *   ctx.ui.setStatus("remote-pi:push", "push: not registered")    → ● push   (warn, static)
 *   ctx.ui.setStatus("remote-pi:push", "push: disabled")          → ○ push   (label gray)
 *   ctx.ui.setStatus("remote-pi:push", "push: error <detail>")    → ● push   (error)
 *   ctx.ui.setStatus("remote-pi:push", undefined)                 → hidden
 * The value is self-describing so pi's default footer (tabline off) still reads well.
 * Unrecognised values render verbatim in secondary gray (never silently dropped).
 *
 * An in-process alternative is any Source<PushStatus> passed to pushSegment().
 */

import type { Painter } from "../paint.ts";
import { dot } from "./builtin.ts";
import type { FooterInput, Segment, Source } from "./types.ts";

export const PUSH_KEY = "remote-pi:push";

export type PushState = "registered" | "not-registered" | "disabled" | "error";
export interface PushStatus { state: PushState | "unknown"; raw: string }

/** Tolerant parser: optional `🔔`, optional `push:` prefix, case-insensitive. Order matters (not-registered before registered). */
export function parsePushStatus(text: string): PushStatus {
	const body = text.replace(/^🔔\s*/u, "").replace(/^push\s*:?\s*/i, "").trim();
	const state: PushStatus["state"] =
		/^(disabled|off)\b/i.test(body) ? "disabled"
		: /^(error|failed|fail|denied)\b/i.test(body) ? "error"
		: /^(not[ -]registered|unregistered|no token|missing)\b/i.test(body) ? "not-registered"
		: /^(registered|on|ok|ready)\b/i.test(body) ? "registered"
		: "unknown";
	return { state, raw: text };
}

/** Source backed by one setStatus key. */
export function statusKeySource<T>(key: string, parse: (text: string) => T): Source<T> & { key: string } {
	return { key, read: (f) => { const t = f.statuses.get(key); return t ? parse(t) : undefined; } };
}

export const pushStatusSource = statusKeySource(PUSH_KEY, parsePushStatus);

export function renderPush(s: PushStatus | undefined, f: FooterInput, p: Painter): string | undefined {
	if (!s) return undefined;
	const label = p.tone("secondary", "push");
	switch (s.state) {
		case "registered": return dot("ok", f, p) + " " + label;
		case "not-registered": return p.tone("warn", "●") + " " + label; // persistent state: no pulse
		case "error": return dot("error", f, p) + " " + label;
		case "disabled": return dot("off", f, p) + " " + p.tone("label", "push");
		default: return p.tone("secondary", s.raw);
	}
}

/** Sits between other statuses (30) and relay (40): relay outranks push on narrow terminals. */
export function pushSegment(source: Source<PushStatus> & { key?: string } = pushStatusSource): Segment {
	return {
		id: "push", line: 1, side: "right", order: 35, prio: 35,
		claims: source.key ? [source.key] : [],
		render: (f, p) => renderPush(source.read(f), f, p),
	};
}
