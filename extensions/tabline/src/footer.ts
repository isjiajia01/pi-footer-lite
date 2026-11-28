/**
 * Footer = collect one FooterInput frame → render every segment → layout per line.
 * `collect` is the only place that touches pi's ctx / footer data; `renderLines` is pure.
 *
 *   10.14_Slip ●  main                 1 peer · ● relay
 *   Sonnet 5.5 · low        ctx 9.1% · ch 98.8% · out 13k · 212 tok/s
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { pulse } from "./animate.ts";
import { attachBorders } from "./editor.ts";
import { layout, type Piece } from "./layout.ts";
import { paint, term, type Painter } from "./paint.ts";
import { SEGMENTS, type FooterInput, type Segment } from "./segments/index.ts";
import { S, tabColor } from "./state.ts";
import { scanEntries } from "./stats.ts";
import { queryBackground, syncTheme } from "./terminal.ts";

/**
 * Whitespace-collapsed, non-empty statuses (insertion order kept). Pi hands over the same mutable
 * map every frame, so this compares entry by entry and reuses the last result while nothing moved:
 * a footer frame allocates no status objects at 12.5 Hz.
 */
let srcKeys: string[] = [];
let srcVals: string[] = [];
let normalized = new Map<string, string>();

export function normalizeStatuses(raw: ReadonlyMap<string, string> | undefined): Map<string, string> {
	const size = raw?.size ?? 0;
	if (size === 0) {
		if (srcKeys.length) { srcKeys = []; srcVals = []; normalized = new Map(); }
		return normalized;
	}
	if (size === srcKeys.length) {
		let i = 0, same = true;
		for (const [k, v] of raw!) {
			if (srcKeys[i] !== k || srcVals[i] !== v) { same = false; break; }
			i++;
		}
		if (same) return normalized;
	}
	const keys: string[] = [], vals: string[] = [];
	const out = new Map<string, string>();
	for (const [k, v] of raw!) {
		keys.push(k); vals.push(v);
		const t = String(v).replace(/\s+/g, " ").trim();
		if (t) out.set(k, t);
	}
	srcKeys = keys; srcVals = vals; normalized = out;
	return out;
}

export function collect(ctx: any, data: any, width: number): FooterInput {
	if (S.stats.dirty) scanEntries(ctx.sessionManager.getEntries(), S.stats);
	const pct = ctx.getContextUsage?.()?.percent;
	return {
		now: Date.now(),
		width,
		cwd: String(ctx.cwd ?? ""),
		home: process.env.HOME,
		branch: data.getGitBranch?.() ?? undefined,
		modelId: ctx.model?.id,
		thinkingLevel: ctx.thinkingLevel || undefined,
		idle: !!ctx.isIdle?.(),
		contextPercent: typeof pct === "number" ? pct : undefined,
		statuses: normalizeStatuses(data.getExtensionStatuses?.()),
		outTotal: S.stats.outTotal,
		lastMsg: S.stats.lastMsg,
		routedModel: S.routedModel && S.routedModel.req === ctx.model?.id && S.routedModel.msg === S.stats.lastMsg
			? S.routedModel.model
			: undefined,
		tokPerSec: S.stats.tokPerSec,
		running: S.run.active,
		tabColor: tabColor(),
		nerd: term.nerd,
		motion: term.motion,
	};
}

export interface Rendered { lines: string[]; live: boolean }

// Pieces live for one layout call, so recycling them keeps a 12.5 Hz frame free of throwaway objects.
const piecePool: Piece[] = [];
const byLine: [Piece[], Piece[]] = [[], []];

export function renderLines(f: FooterInput, p: Painter, segments: readonly Segment[] = SEGMENTS): Rendered {
	byLine[0].length = 0; byLine[1].length = 0;
	let live = false, used = 0;
	for (const seg of segments) {
		const r = seg.render(f, p);
		const texts = r === undefined ? [] : Array.isArray(r) ? r : [r];
		for (const text of texts) {
			if (!text) continue;
			const pc = piecePool[used] ?? (piecePool[used] = { text: "", side: seg.side, order: seg.order, prio: seg.prio, join: seg.join });
			used++;
			pc.text = text; pc.side = seg.side; pc.order = seg.order; pc.prio = seg.prio; pc.join = seg.join;
			byLine[seg.line - 1].push(pc);
		}
		if (texts.length && seg.live?.(f)) live = true;
	}
	return { lines: byLine.map((pcs) => {
		const line = layout(pcs, f.width, p.sep);
		// An exactly padded line needs no width check; truncateToWidth scans all ANSI/graphemes.
		// Keep its clipping semantics for narrow/pinned overflow (including width 0).
		if (line.exact) return line.text;
		return f.width > 0 && visibleWidth(line.text) <= f.width ? line.text : truncateToWidth(line.text, f.width);
	}), live };
}

export const RENDER_ERROR = "tabline: render error (/tabline off)";

/**
 * Factory for ctx.ui.setFooter. Each render also (re)attaches the editor rules, which is how
 * tabline follows editors that other extensions install later in session_start.
 * The pulse timer lives exactly as long as some rendered segment reports `live`.
 */
export function footerFactory(ctx: any, segments: readonly Segment[] = SEGMENTS) {
	return (tui: any, _theme: unknown, data: any) => {
		S.tui = tui;
		syncTheme();
		queryBackground(tui); // actual background affects rule fades, not the text palette
		return {
			invalidate() {},
			render(width: number): string[] {
				attachBorders();
				try {
					const r = renderLines(collect(ctx, data, width), paint, segments);
					pulse(r.live);
					return r.lines;
				} catch {
					return [truncateToWidth(RENDER_ERROR, width)];
				}
			},
		};
	};
}
