/**
 * Short-lived timers. Together with spinner.ts this is the only place that calls
 * setInterval. Both timers stop themselves; none runs while idle and focused.
 *   - focus fade: 140ms ease-out-cubic between active/dim tab color (16ms ticks)
 *   - pulse: 80ms redraw tick, alive only while some segment reports `live`
 */

import * as K from "./color.ts";
import { term } from "./paint.ts";
import { redraw, S } from "./state.ts";

export const FOCUS_FADE_MS = 140;
let focusTimer: ReturnType<typeof setInterval> | undefined;

export function setFocus(focused: boolean): void {
	const target = focused ? 1 : 0;
	stopFocus();
	if (!term.motion) { S.focusP = target; redraw(); return; }
	const from = S.focusP, t0 = Date.now();
	focusTimer = setInterval(() => {
		const p = Math.min(1, (Date.now() - t0) / FOCUS_FADE_MS);
		S.focusP = from + (target - from) * (1 - (1 - p) ** 3);
		if (p >= 1) stopFocus();
		redraw();
	}, 16);
	focusTimer.unref?.();
}

export function stopFocus(): void {
	if (focusTimer) clearInterval(focusTimer);
	focusTimer = undefined;
}

let pulseTimer: ReturnType<typeof setInterval> | undefined;
/** Keep an 80ms redraw tick alive while `on` (and motion is allowed). Idempotent. */
export function pulse(on: boolean): void {
	if (on && !pulseTimer && term.motion) { pulseTimer = setInterval(redraw, 80); pulseTimer.unref?.(); }
	else if (!on && pulseTimer) { clearInterval(pulseTimer); pulseTimer = undefined; }
}

export const timersIdle = () => !focusTimer && !pulseTimer;

/** 0..1 sine with the given period, for pulsing dots. */
export const wave = (now: number, periodMs: number) => (Math.sin((now / periodMs) * Math.PI * 2) + 1) / 2;

/** Pulse a token's OKLab lightness down by `dL` and back. Returns a color for the painter. */
export function pulseColor(tok: keyof typeof K.TOKEN, now: number, periodMs = 1200, dL = 0.25): K.C {
	const hi = K.srgbToOklab(K.TOKEN[tok].rgb);
	const lo: K.Lab = [hi[0] - dL, hi[1], hi[2]];
	return { rgb: K.mixLab(lo, hi, wave(now, periodMs)), a16: K.TOKEN[tok].a16 };
}
