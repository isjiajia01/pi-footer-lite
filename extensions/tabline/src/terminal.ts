/**
 * Terminal I/O beyond rendering: focus reporting (DECSET 1004 → `ESC[I` / `ESC[O`) and the
 * automatic system appearance and the one-shot OSC 11 query for rule fades. No polling.
 */

import { setFocus, stopFocus } from "./animate.ts";
import { redraw, S } from "./state.ts";
import * as K from "./color.ts";
import { execFile, execFileSync } from "node:child_process";
import { appearanceProbe } from "./appearance.ts";

/** macOS appearance is authoritative in auto mode; preserve the last choice on a failed probe. */
export function systemIsLight(
	env: Record<string, string | undefined> = process.env,
	platform: string = process.platform,
	read: () => string = () => execFileSync("defaults", ["read", "-g"], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 500,
	}),
): boolean {
	if (env.TABLINE_THEME === "light") return true;
	if (env.TABLINE_THEME === "dark") return false;
	if (platform === "darwin") {
		try { return !/AppleInterfaceStyle\s*=\s*"?Dark"?\s*;/i.test(read()); }
		catch { return lastLight ?? !!K.guessBgFromEnv(env); }
	}
	return !!K.guessBgFromEnv(env);
}

/** Initial attach remains synchronous to avoid flashing the wrong palette on the first frame. */
export function syncTheme(): void {
	focusProbe.cancel();
	applyAppearance(systemIsLight());
}

function applyAppearance(light: boolean): void {
	if (light === lastLight) return;
	lastLight = light;
	S.bg = light ? [250, 247, 242] : K.BG;
	K.applyTheme(S.bg);
	// resolveTab ran before footer attach: refresh its cached focus endpoints too.
	S.tab.active = K.tabColor(S.tab.index, true);
	S.tab.dim = K.tabColor(S.tab.index, false);
	queueMicrotask(redraw);
}
let lastLight: boolean | undefined;

const focusProbe = appearanceProbe(
	() => new Promise<string>((resolve, reject) => execFile("defaults", ["read", "-g"],
		{ encoding: "utf8", timeout: 500, maxBuffer: 1024 * 1024 },
		(error, stdout) => error ? reject(error) : resolve(stdout))),
	text => applyAppearance(systemIsLight(process.env, process.platform, () => text)),
);

/** Focus-in must not block terminal input on a preferences subprocess (~14ms here). */
export function refreshTheme(): void {
	if (process.platform !== "darwin" || process.env.TABLINE_THEME === "light" || process.env.TABLINE_THEME === "dark") {
		focusProbe.cancel();
		applyAppearance(systemIsLight());
	} else focusProbe.request();
}

const writeOut = (s: string) => { try { process.stdout.write(s); } catch {} };

let unsubInput: (() => void) | undefined;
let reporting = false;

/** Appearance updates need focus events even with reduced motion. No idle polling. */
export function startFocusReporting(ui: any): void {
	if (!process.stdout.isTTY) return;
	unsubInput = ui.onTerminalInput((d: string) => {
		if (d === "\x1b[I") { refreshTheme(); setFocus(true); return { consume: true }; }
		if (d === "\x1b[O") { setFocus(false); return { consume: true }; }
		return undefined;
	});
	writeOut("\x1b[?1004h");
	reporting = true;
}

/** Undo startFocusReporting and snap back to the focused color. Idempotent. */
export function stopFocusReporting(): void {
	focusProbe.cancel();
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
