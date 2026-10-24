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

export function layoutLine(pieces: readonly Piece[], width: number, sep: string): string {
	const tagged = pieces.map((pc, i) => ({ pc, i }));
	let left = tagged.filter((t) => t.pc.side === "left").sort(byOrder).map((t) => t.pc);
	let right = tagged.filter((t) => t.pc.side === "right").sort(byOrder).map((t) => t.pc);
	for (;;) {
		const L = joinSide(left, sep), R = joinSide(right, sep);
		const gap = width - visibleWidth(L) - visibleWidth(R);
		if (gap >= MIN_GAP) return L + " ".repeat(gap) + R;
		const victim = pickVictim(left, right);
		if (!victim) return [L, R].filter(Boolean).join(" ".repeat(MIN_GAP));
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
