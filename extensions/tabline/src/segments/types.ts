/**
 * Footer segment model. A segment is a pure function from one immutable frame
 * (FooterInput) to painted text. The footer collects the frame once per render,
 * asks every registered segment for its pieces, then layout.ts places/drops them.
 * Adding a status item = add a Segment to SEGMENTS (segments/index.ts); render code,
 * layout and index.ts stay untouched. See DESIGN.md.
 */

import type * as K from "../color.ts";
import type { Painter } from "../paint.ts";
import type { Msg } from "../stats.ts";

/** Everything a segment may read. Collected once per footer render; segments must not do I/O. */
export interface FooterInput {
	now: number;
	width: number;
	cwd: string;
	home: string | undefined;
	branch: string | undefined;
	modelId: string | undefined;
	thinkingLevel: string | undefined;
	idle: boolean;
	/** Context window use in %, or undefined when unknown. */
	contextPercent: number | undefined;
	/** Extension statuses from ctx.ui.setStatus, whitespace-collapsed, empty values removed. */
	statuses: ReadonlyMap<string, string>;
	outTotal: number;
	lastMsg: Msg | undefined;
	tokPerSec: number | undefined;
	running: boolean;
	tabColor: K.C;
	nerd: boolean;
	motion: boolean;
}

/** Never dropped; when even pinned pieces don't fit, the line is truncated. */
export const PINNED = Number.POSITIVE_INFINITY;

export interface Segment {
	/** Stable id (tests, DESIGN.md, future config). */
	id: string;
	line: 1 | 2;
	side: "left" | "right";
	/** Position within its side, ascending left→right. Ties keep registration order. */
	order: number;
	/**
	 * Narrow-terminal survival: lowest prio is dropped first; on ties the piece farthest
	 * from its side's screen edge goes first. PINNED never drops.
	 */
	prio: number;
	/** How this piece attaches to the previous piece on its side: " · " (default) or one space. */
	join?: "sep" | "space";
	/** setStatus keys this segment renders itself; the generic status segment skips them. */
	claims?: readonly string[];
	/**
	 * Painted text, or undefined to hide. An array yields several pieces that share
	 * order/prio but drop individually.
	 */
	render(f: FooterInput, p: Painter): string | string[] | undefined;
	/** True while this segment animates (e.g. a pulsing dot); keeps the 80ms pulse timer alive. */
	live?(f: FooterInput): boolean;
}

/**
 * Data-source contract for segments whose data does not come from pi directly.
 * `read` runs inside render: O(1), synchronous, no I/O, no timers. Sources that need
 * I/O keep their own cache, refresh it from events (never polling while idle) and call
 * the `redraw` passed to `start`.
 */
export interface Source<T> {
	read(f: FooterInput): T | undefined;
	/** Optional lifecycle, called on install with a redraw hook; returns a disposer. */
	start?(redraw: () => void): () => void;
}
