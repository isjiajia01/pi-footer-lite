/**
 * Terminal I/O beyond rendering: focus reporting (DECSET 1004 → `ESC[I` / `ESC[O`) and the
 * one-shot OSC 11 background query that tunes the rule fade. Nothing here polls.
 */

import { setFocus, stopFocus } from "./animate.ts";
import { term } from "./paint.ts";
import { redraw, S } from "./state.ts";

const writeOut = (s: string) => { try { process.stdout.write(s); } catch {} };

let unsubInput: (() => void) | undefined;
let reporting = false;

/** Enable focus reporting (motion + TTY only). The input hook consumes the two focus sequences. */
export function startFocusReporting(ui: any): void {
	if (!term.motion || !process.stdout.isTTY) return;
	unsubInput = ui.onTerminalInput((d: string) => {
		if (d === "\x1b[I") { setFocus(true); return { consume: true }; }
		if (d === "\x1b[O") { setFocus(false); return { consume: true }; }
		return undefined;
	});
	writeOut("\x1b[?1004h");
	reporting = true;
}

/** Undo startFocusReporting and snap back to the focused color. Idempotent. */
export function stopFocusReporting(): void {
	unsubInput?.();
	unsubInput = undefined;
	if (reporting) writeOut("\x1b[?1004l");
	reporting = false;
	stopFocus();
	S.focusP = 1;
}

/** Ask pi for the real terminal background (≤100ms); keep the token fallback on no/odd reply. */
export function queryBackground(tui: any): void {
	try {
		void Promise.resolve(tui?.queryTerminalColors?.({ timeoutMs: 100 })).then((c: any) => {
			const b = c?.background;
			if (b && [b.r, b.g, b.b].every((v: any) => typeof v === "number")) {
				const s = Math.max(b.r, b.g, b.b) > 255 ? 257 : 1; // tolerate 16-bit replies
				S.bg = [Math.round(b.r / s), Math.round(b.g / s), Math.round(b.b / s)];
				redraw();
			}
		}).catch(() => {});
	} catch {}
}
