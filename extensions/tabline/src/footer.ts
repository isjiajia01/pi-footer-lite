/**
 * Footer = collect one FooterInput frame → render every segment → layout per line.
 * `collect` is the only place that touches pi's ctx / footer data; `renderLines` is pure.
 *
 *   10.14_Slip ●  main                 1 peer · ● relay
 *   Sonnet 5.5 · low        ctx 9.1% · ch 98.8% · out 13k · 212 tok/s
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { pulse } from "./animate.ts";
import { attachBorders } from "./editor.ts";
import { layoutLine, type Piece } from "./layout.ts";
import { paint, term, type Painter } from "./paint.ts";
import { SEGMENTS, type FooterInput, type Segment } from "./segments/index.ts";
import { S, tabColor } from "./state.ts";
import { scanEntries } from "./stats.ts";
import { queryBackground } from "./terminal.ts";

/** Whitespace-collapsed, non-empty statuses (insertion order kept). */
export function normalizeStatuses(raw: ReadonlyMap<string, string> | undefined): Map<string, string> {
	const out = new Map<string, string>();
	for (const [k, v] of raw ?? []) {
		const t = String(v).replace(/\s+/g, " ").trim();
		if (t) out.set(k, t);
	}
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
		tokPerSec: S.stats.tokPerSec,
		running: S.run.active,
		tabColor: tabColor(),
		nerd: term.nerd,
		motion: term.motion,
	};
}

export interface Rendered { lines: string[]; live: boolean }

export function renderLines(f: FooterInput, p: Painter, segments: readonly Segment[] = SEGMENTS): Rendered {
	const byLine: Piece[][] = [[], []];
	let live = false;
	for (const seg of segments) {
		const r = seg.render(f, p);
		const texts = r === undefined ? [] : Array.isArray(r) ? r : [r];
		for (const text of texts) if (text) byLine[seg.line - 1].push({ text, side: seg.side, order: seg.order, prio: seg.prio, join: seg.join });
		if (texts.length && seg.live?.(f)) live = true;
	}
	return { lines: byLine.map((pcs) => truncateToWidth(layoutLine(pcs, f.width, p.sep), f.width)), live };
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
		queryBackground(tui);
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
