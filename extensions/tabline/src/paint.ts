/**
 * Terminal capabilities + the painter. Everything that turns a token into an escape
 * sequence goes through a Painter so render code never branches on color mode.
 * The process-wide painter (`paint`) is built once from the environment; tests build
 * their own with `makePainter("none" | "truecolor" | …)`.
 */

import * as K from "./color.ts";

export type Tone = keyof typeof K.TOKEN;

export interface Painter {
	readonly mode: K.ColorMode;
	/** Token color. */
	tone(tok: Tone, s: string): string;
	/** Arbitrary color (tab identity, animated mixes). */
	color(c: K.C, s: string): string;
	/** Raw foreground escape for a token ('' in mode none). Cached. */
	seq(tok: Tone): string;
	/** ` · ` in separator gray. */
	readonly sep: string;
}

export function makePainter(mode: K.ColorMode): Painter {
	const SEQ = Object.fromEntries(Object.entries(K.TOKEN).map(([k, c]) => [k, K.fgSeq(c, mode)])) as Record<Tone, string>;
	const none = mode === "none";
	const tone = (tok: Tone, s: string) => (none ? s : SEQ[tok] + s + K.RESET_FG);
	return {
		mode,
		tone,
		color: (c, s) => (none ? s : K.fgSeq(c, mode) + s + K.RESET_FG),
		seq: (tok) => SEQ[tok],
		sep: ` ${tone("separator", "·")} `,
	};
}

export interface Term {
	mode: K.ColorMode;
	/** Shimmer, focus fade and pulsing dots. Off without a truecolor TTY or with NO_MOTION/REDUCE_MOTION=1. */
	motion: boolean;
	/** Nerd-font glyphs (branch icon). PI_NERD_FONT=1|0 overrides terminal sniffing. */
	nerd: boolean;
}

export function detectTerm(env: Record<string, string | undefined> = process.env, isTTY = !!process.stdout.isTTY): Term {
	const mode = K.detectMode(env);
	return {
		mode,
		motion: isTTY && mode === "truecolor" && env.NO_MOTION !== "1" && env.REDUCE_MOTION !== "1",
		nerd: env.PI_NERD_FONT ? env.PI_NERD_FONT === "1" : ["ghostty", "WezTerm", "iTerm.app", "kitty"].includes(env.TERM_PROGRAM ?? ""),
	};
}

export const term: Term = detectTerm();
export const paint: Painter = makePainter(term.mode);
