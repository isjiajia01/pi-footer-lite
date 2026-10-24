/**
 * Built-in segments.
 *
 *   line 1  [project ●][branch]                    [peer-active][peers][statuses…][push][relay]
 *   line 2  [route = model · thinking]             [ctx][cache][out][speed]
 *
 * prio (drop lowest first): line 1 right: peer-active 10, peers 20, statuses 30, push 35,
 * relay 40; line 2: out 10, cache 20, route 30; project, branch, ctx, speed are PINNED.
 */

import { pulseColor } from "../animate.ts";
import { fmtRate, kfmt, prettyModel } from "../format.ts";
import type { Painter, Tone } from "../paint.ts";
import { cacheHit } from "../stats.ts";
import { PINNED, type FooterInput, type Segment } from "./types.ts";

const metric = (p: Painter, label: string, value: string, tone: Tone = "primary") => p.tone("label", label + " ") + p.tone(tone, value);

// ─── line 1 left ─────────────────────────────────────────────────

export const project: Segment = {
	id: "project", line: 1, side: "left", order: 0, prio: PINNED,
	render(f, p) {
		const cwd = f.cwd.replace(/\/+$/, "");
		const name = cwd === f.home ? "~" : cwd.slice(cwd.lastIndexOf("/") + 1);
		return p.tone("primary", name) + " " + p.color(f.tabColor, "●");
	},
};

export const branch: Segment = {
	id: "branch", line: 1, side: "left", order: 10, prio: PINNED, join: "space",
	render: (f, p) => (f.branch ? p.tone("label", (f.nerd ? "\ue0a0 " : "") + f.branch) : undefined),
};

// ─── line 1 right: remote-pi (Perch) statuses ────────────────────

export const RELAY_KEY = "remote-pi:relay";
export const SESSION_KEY = "remote-pi:session";
export const PEER_KEY = "remote-pi:peer-active";

export type RelayState = "ok" | "waiting" | "error";
export function relayState(text: string): RelayState {
	if (/disconnect|offline|error|fail|closed|lost/i.test(text)) return "error";
	if (/waiting|pair|connect|retry/i.test(text)) return "waiting";
	return "ok";
}

/** Dot for a status; `waiting` pulses (warn, L−0.25, 1200ms sine) when motion is on. */
export function dot(state: RelayState | "off", f: FooterInput, p: Painter): string {
	switch (state) {
		case "ok": return p.tone("ok", "●");
		case "error": return p.tone("error", "●");
		case "off": return p.tone("label", "○");
		case "waiting": return f.motion ? p.color(pulseColor("warn", f.now), "●") : p.tone("warn", "●");
	}
}

export const relay: Segment = {
	id: "relay", line: 1, side: "right", order: 40, prio: 40, claims: [RELAY_KEY],
	render(f, p) {
		const t = f.statuses.get(RELAY_KEY);
		return t ? dot(relayState(t), f, p) + " " + p.tone("secondary", "relay") : undefined;
	},
	live: (f) => {
		const t = f.statuses.get(RELAY_KEY);
		return !!t && relayState(t) === "waiting";
	},
};

/** `📡 local (2)` → `2 peers`; `📡 host (1)` → `1 peer host`; 0 peers → hidden; unknown → raw. */
export const peers: Segment = {
	id: "peers", line: 1, side: "right", order: 20, prio: 20, claims: [SESSION_KEY],
	render(f, p) {
		const t = f.statuses.get(SESSION_KEY);
		if (!t) return undefined;
		const m = /^📡\s*(\S+)\s*\((\d+)\)$/.exec(t);
		if (!m) return p.tone("secondary", t);
		const n = Number(m[2]);
		if (n === 0) return undefined;
		return p.tone("secondary", `${n} peer${n > 1 ? "s" : ""}${m[1] === "local" ? "" : ` ${m[1]}`}`);
	},
};

/** `📱 iPhone` → `iPhone`. */
export const peerActive: Segment = {
	id: "peer-active", line: 1, side: "right", order: 10, prio: 10, claims: [PEER_KEY],
	render(f, p) {
		const t = f.statuses.get(PEER_KEY);
		return t ? p.tone("secondary", /^📱\s*(.+)$/.exec(t)?.[1] ?? t) : undefined;
	},
};

/** Any other extension status, verbatim in secondary gray. `claimed` = keys owned by other segments. */
export function otherStatuses(claimed: ReadonlySet<string>): Segment {
	return {
		id: "statuses", line: 1, side: "right", order: 30, prio: 30,
		render(f, p) {
			const out: string[] = [];
			for (const [key, t] of f.statuses) if (!claimed.has(key)) out.push(p.tone("secondary", t));
			return out;
		},
	};
}

// ─── line 2 left: route ──────────────────────────────────────────

/** `claude/claude-sonnet-5-5` → `Sonnet 5.5`; `group/x` verbatim plus `→ Actual` (idle only) when the router picked another model. */
export function modelLabel(f: FooterInput, p: Painter): string {
	const id = f.modelId;
	const group = id?.startsWith("group/");
	let s = p.tone("secondary", group ? id!.slice(6) : id ? prettyModel(id) : "no-model");
	const actual = f.lastMsg?.responseModel;
	if (f.idle && group && f.lastMsg?.model === id && actual && actual !== id) s += p.tone("label", ` → ${prettyModel(actual)}`);
	return s;
}

/**
 * Model + thinking level as ONE piece: they drop together (after out and cache), exactly
 * like the pre-redesign footer. Splitting them is a look change; see DESIGN.md §Layout.
 */
export const route: Segment = {
	id: "route", line: 2, side: "left", order: 0, prio: 30,
	render: (f, p) => modelLabel(f, p) + (f.thinkingLevel ? p.sep + p.tone("secondary", f.thinkingLevel) : ""),
};

// ─── line 2 right: metrics ───────────────────────────────────────

/** Context use: warn ≥ 60%, error ≥ 85%. */
export const ctx: Segment = {
	id: "ctx", line: 2, side: "right", order: 0, prio: PINNED,
	render(f, p) {
		const pct = f.contextPercent;
		const tone: Tone = pct == null ? "primary" : pct >= 85 ? "error" : pct >= 60 ? "warn" : "primary";
		return metric(p, "ctx", pct == null ? "?" : `${pct.toFixed(1)}%`, tone);
	},
};

/** Cache hit of the last request: warn < 50%, error < 20%; hidden when the provider reports no caching. */
export const cache: Segment = {
	id: "cache", line: 2, side: "right", order: 10, prio: 20,
	render(f, p) {
		const ch = cacheHit(f.lastMsg);
		return ch === undefined ? undefined : metric(p, "ch", `${ch.toFixed(1)}%`, ch < 20 ? "error" : ch < 50 ? "warn" : "primary");
	},
};

export const out: Segment = {
	id: "out", line: 2, side: "right", order: 20, prio: 10,
	render: (f, p) => (f.outTotal > 0 ? metric(p, "out", kfmt(f.outTotal)) : undefined),
};

/** Last message speed; brand coral while the agent runs. */
export const speed: Segment = {
	id: "speed", line: 2, side: "right", order: 30, prio: PINNED,
	render: (f, p) => (f.tokPerSec === undefined ? undefined : p.tone(f.running ? "brand" : "primary", fmtRate(f.tokPerSec)) + p.tone("label", " tok/s")),
};
