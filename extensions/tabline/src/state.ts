/**
 * The one mutable store. Every module reads/writes through `S`; nothing else holds
 * cross-module mutable state. `redraw()` is the only way to ask pi for a frame.
 */

import * as K from "./color.ts";
import type { Stats } from "./stats.ts";

export interface RunState {
	active: boolean;
	verb: string;
	/** `verb…` and the display column of each code point (for the shimmer). */
	text: string;
	colStart: number[];
	textCols: number;
	start: number;
	thinking: boolean;
	/** True until the first response delta: arrow shows ↑ (sending) instead of ↓. */
	requesting: boolean;
	/** Streamed characters received / currently shown (shown eases toward received). */
	responseLen: number;
	shownLen: number;
	/** Output tokens of this run (for the completion notice). */
	out: number;
}

export const S = {
	/** `/tabline off` flips this; while false every hook falls back to pi's own rendering. */
	enabled: true,
	/** The TUI handed to our footer/editor factories (duck-typed: requestRender, children). */
	tui: undefined as any,
	/** Terminal background (OSC 11) for the rule fade; token fallback until pi answers. */
	bg: K.BG as K.RGB,
	tab: { key: "", index: 0, active: K.tabColor(0, true), dim: K.tabColor(0, false) },
	/** Focus fade progress: 1 = focused color, 0 = dim color. */
	focusP: 1,
	stats: { outTotal: 0, lastMsg: undefined, tokPerSec: undefined, dirty: true } as Stats,
	/** Wall-clock start of the current streamed message (for tok/s). */
	streamStart: undefined as number | undefined,
	run: {
		active: false, verb: "", text: "", colStart: [], textCols: 0, start: 0,
		thinking: false, requesting: true, responseLen: 0, shownLen: 0, out: 0,
	} as RunState,
};

export const redraw = () => S.tui?.requestRender?.();

/** Current tab identity color, interpolated during the focus fade. */
export function tabColor(): K.C {
	const { active, dim } = S.tab;
	const p = S.focusP;
	if (p >= 1) return active;
	if (p <= 0) return dim;
	return { rgb: K.mixOklab(dim.rgb, active.rgb, p), a16: p > 0.5 ? active.a16 : dim.a16 };
}
