/**
 * Line layout (pure): left pieces flush left, right pieces flush right, ≥2 spaces between.
 * While the line is too wide, drop the lowest-prio piece (ties: the one farthest from its
 * screen edge; then right side first). If only PINNED pieces remain and still don't fit,
 * return them joined by two spaces; the caller truncates to width.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

export interface Piece {
	text: string;
	side: "left" | "right";
	order: number;
	prio: number;
	join?: "sep" | "space";
}

export const MIN_GAP = 2;

function joinSide(pieces: Piece[], sep: string): string {
	let s = "";
	pieces.forEach((pc, i) => { s += (i === 0 ? "" : pc.join === "space" ? " " : sep) + pc.text; });
	return s;
}

const byOrder = (a: { pc: Piece; i: number }, b: { pc: Piece; i: number }) => a.pc.order - b.pc.order || a.i - b.i;

/** Segments usually arrive in `order` already, so the common frame needs no sort at all. */
function ordered(items: { pc: Piece; i: number }[]): { pc: Piece; i: number }[] {
	for (let i = 1; i < items.length; i++) if (byOrder(items[i - 1], items[i]) > 0) return items.sort(byOrder);
	return items;
}

/** `exact` = the returned line is padded to exactly `width` visible columns (no caller clipping needed). */
export interface LaidLine { text: string; exact: boolean }

/** Text only; use `layout` when the caller wants to skip its own width check. */
export function layoutLine(pieces: readonly Piece[], width: number, sep: string): string {
	return layout(pieces, width, sep).text;
}

export function layout(pieces: readonly Piece[], width: number, sep: string): LaidLine {
	const l: { pc: Piece; i: number }[] = [], r: { pc: Piece; i: number }[] = [];
	pieces.forEach((pc, i) => (pc.side === "left" ? l : r).push({ pc, i }));
	let left = ordered(l).map((t) => t.pc);
	let right = ordered(r).map((t) => t.pc);
	for (;;) {
		const L = joinSide(left, sep), R = joinSide(right, sep);
		const gap = width - visibleWidth(L) - visibleWidth(R);
		if (gap >= MIN_GAP) return { text: L + " ".repeat(gap) + R, exact: true };
		const victim = pickVictim(left, right);
		if (!victim) return { text: [L, R].filter(Boolean).join(" ".repeat(MIN_GAP)), exact: false };
		if (victim.side === "left") left = left.filter((p) => p !== victim.pc);
		else right = right.filter((p) => p !== victim.pc);
	}
}

function pickVictim(left: Piece[], right: Piece[]): { pc: Piece; side: "left" | "right" } | undefined {
	type C = { pc: Piece; side: "left" | "right"; dist: number };
	let best: C | undefined;
	const worse = (a: C, b: C) => a.pc.prio < b.pc.prio || (a.pc.prio === b.pc.prio && (a.dist > b.dist || (a.dist === b.dist && a.side === "right")));
	const consider = (pc: Piece, side: "left" | "right", dist: number) => {
		if (!Number.isFinite(pc.prio)) return;
		const c = { pc, side, dist };
		if (!best || worse(c, best)) best = c;
	};
	left.forEach((pc, i) => consider(pc, "left", i));
	right.forEach((pc, i) => consider(pc, "right", right.length - 1 - i));
	return best;
}
