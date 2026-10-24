/**
 * Editor rules (pure). The top rule embeds the spinner head while a run is active; both
 * rules can carry a centered "↑/↓ N more" overflow marker. Per-column color escapes come
 * from color.ruleSeqs (cached per width/base/bg/mode), so an idle rule costs one join.
 *
 *   ── ✻ Crunching… 18s · ↓ 54 tok ─────────── ↑ 3 more ────
 *   ^^ LEAD columns, then " glyph verb labels "
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import * as K from "./color.ts";
import type { Painter } from "./paint.ts";
import type { SpinnerHead } from "./spinner.ts";

export interface RuleInput {
	width: number;
	hidden: number;
	base: K.C;
	bg: K.RGB;
	p: Painter;
}

type Seg = { col: number; text: string; width: number };

/** Centered ` ↑ N more ` marker, or undefined when nothing is hidden or it would collide (< minCol). */
export function overflowSeg(W: number, count: number, arrow: "↑" | "↓", minCol: number, p: Painter): Seg | undefined {
	if (count <= 0) return undefined;
	const text = ` ${arrow} ${count} more `;
	const width = visibleWidth(text);
	const col = Math.floor((W - width) / 2);
	return col >= minCol && width + 2 <= W ? { col, text: p.tone("label", text), width } : undefined;
}

/**
 * Label fallbacks, widest first: all labels → without "thinking" → last label only → none.
 * The first candidate that leaves ≥1 trailing dash wins.
 */
export function headSeg(W: number, head: SpinnerHead, p: Painter): Seg | undefined {
	const lead = Math.min(K.LEAD, W);
	const glyphHead = ` ${head.glyph} ${head.verb}`;
	const headW = 3 + head.verbCols; // " g " + verb
	const all = head.labels;
	const candidates = [all, all.filter((l) => l.id !== "thinking"), all.slice(-1), []];
	for (const cand of candidates) {
		const label = cand.map((l) => l.text).join(" · ");
		const lw = visibleWidth(label);
		const w = headW + (lw ? 1 + lw : 0) + 1;
		if (lead + w + 1 <= W) return { col: lead, text: glyphHead + (lw ? " " + p.tone("label", label) : "") + " ", width: w };
	}
	return undefined; // too narrow: plain rule
}

export function topRule(r: RuleInput, head?: SpinnerHead): string {
	const seqs = K.ruleSeqs(r.width, r.base, r.bg, r.p.mode);
	const segs: Seg[] = [];
	const h = head ? headSeg(r.width, head, r.p) : undefined;
	if (head && !h) return K.composeRule(r.width, seqs, r.p.mode); // too narrow for text
	if (h) segs.push(h);
	const o = overflowSeg(r.width, r.hidden, "↑", h ? h.col + h.width + 1 : 1, r.p);
	if (o) segs.push(o);
	return K.composeRule(r.width, seqs, r.p.mode, segs);
}

export function bottomRule(r: RuleInput): string {
	const o = overflowSeg(r.width, r.hidden, "↓", 1, r.p);
	return K.composeRule(r.width, K.ruleSeqs(r.width, r.base, r.bg, r.p.mode), r.p.mode, o ? [o] : []);
}
