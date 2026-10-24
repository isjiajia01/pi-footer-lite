import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as K from "../src/color.ts";
import { makePainter } from "../src/paint.ts";
import { renderLines } from "../src/footer.ts";
import type { FooterInput } from "../src/segments/types.ts";
import { tabColor } from "../src/state.ts";
import { systemIsLight, syncTheme, startFocusReporting, stopFocusReporting } from "../src/terminal.ts";
import { term } from "../src/paint.ts";

const bg: K.RGB = [250, 247, 242];
export function contrast(a: K.RGB, b: K.RGB): number {
	const lum = (c: K.RGB) => c.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
		.reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
	const x = lum(a), y = lum(b);
	return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
const palette256 = (n: number): K.RGB => {
	if (n >= 232) return [1, 1, 1].map(() => 8 + 10 * (n - 232)) as K.RGB;
	assert.ok(n >= 16, "don't depend on terminal-configured ANSI palette");
	const cube = [0, 95, 135, 175, 215, 255], x = n - 16;
	return [cube[Math.floor(x / 36)], cube[Math.floor(x / 6) % 6], cube[x % 6]];
};
function assertReadable(line: string): void {
	const chunks = line.split(/(\x1b\[[\d;]+m)/);
	let rgb: K.RGB | undefined;
	for (const c of chunks) {
		if (c.startsWith("\x1b[38;2;")) rgb = c.slice(7, -1).split(";").map(Number) as K.RGB;
		else if (c.startsWith("\x1b[38;5;")) rgb = palette256(Number(c.slice(7, -1)));
		else if (c === K.RESET_FG) rgb = undefined;
		else if (c.trim()) {
			assert.ok(rgb, `missing explicit color for ${JSON.stringify(c)}`);
			assert.ok(contrast(rgb, bg) >= 4.5, `${JSON.stringify(c)} ${K.toHex(rgb)} contrast=${contrast(rgb, bg).toFixed(2)}`);
		}
	}
}
const frame = (pct: number, state: string): FooterInput => ({
	now: 0, width: 240, cwd: "/x/Life-OS", home: "/h", branch: "main", modelId: "group/std", thinkingLevel: "low",
	idle: true, contextPercent: pct, statuses: new Map([["remote-pi:relay", state], ["remote-pi:push", `push: ${state}`], ["remote-pi:session", "📡 local (2)"], ["remote-pi:peer-active", "📱 iPhone"], ["custom", "build ok"]]),
	outTotal: 13000, lastMsg: { usage: { input: 100 - pct, cacheRead: pct } }, tokPerSec: 212, running: true,
	tabColor: K.tabColor(0, true), nerd: false, motion: false,
});
afterEach(() => K.applyTheme(K.BG));

test("appearance override, automatic macOS choice, and non-macOS fallback", () => {
	const fail = () => { throw new Error("not available"); };
	assert.equal(systemIsLight({ TABLINE_THEME: "light" }, "darwin", fail), true);
	assert.equal(systemIsLight({ TABLINE_THEME: "dark" }, "darwin", fail), false);
	assert.equal(systemIsLight({ TABLINE_THEME: "auto", COLORFGBG: "0;15" }, "darwin", () => '{ AppleInterfaceStyle = Dark; }'), false);
	// Default is dark-only: system appearance is consulted only with TABLINE_THEME=auto.
	assert.equal(systemIsLight({}, "darwin", () => '{}'), false);
	assert.equal(systemIsLight({ COLORFGBG: "0;15" }, "linux"), false);
	assert.equal(systemIsLight({ TABLINE_THEME: "auto" }, "darwin", () => '{}'), true);
	assert.equal(systemIsLight({ TABLINE_THEME: "auto" }, "darwin", () => '{ AppleInterfaceStyle = "Dark"; }'), false);
	assert.equal(systemIsLight({ TABLINE_THEME: "auto", COLORFGBG: "0;15" }, "linux"), true);
	assert.equal(systemIsLight({ TABLINE_THEME: "auto" }, "linux"), false);
});

test("reduced-motion focus events switch the existing painter and tab color without polling", () => {
	const env = process.env.TABLINE_THEME, motion = term.motion;
	const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const write = process.stdout.write;
	let hook: ((data: string) => unknown) | undefined;
	try {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		process.stdout.write = (() => true) as typeof process.stdout.write;
		term.motion = false;
		process.env.TABLINE_THEME = "dark";
		syncTheme();
		const p = makePainter("truecolor"), darkTab = tabColor();
		startFocusReporting({ onTerminalInput(h: typeof hook) { hook = h; return () => { hook = undefined; }; } });
		assert.ok(hook);
		process.env.TABLINE_THEME = "light";
		hook!("\x1b[I");
		assert.notDeepEqual(tabColor(), darkTab);
		assert.equal(p.seq("primary"), K.fgSeq(K.TOKEN.primary, "truecolor"));
		assert.ok(contrast(K.TOKEN.primary.rgb, bg) >= 4.5);
		const revision = K.themeRevision;
		hook!("\x1b[I");
		assert.equal(K.themeRevision, revision);
		process.env.TABLINE_THEME = "dark";
		hook!("\x1b[I");
		assert.deepEqual(tabColor(), darkTab);
	} finally {
		stopFocusReporting(); term.motion = motion; process.stdout.write = write;
		if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else Reflect.deleteProperty(process.stdout, "isTTY");
		if (env === undefined) delete process.env.TABLINE_THEME; else process.env.TABLINE_THEME = env;
	}
});

test("16-color light mode uses theme-controlled default foreground instead of bright ANSI statuses", () => {
	const p = makePainter("16");
	K.applyTheme(bg);
	for (const token of Object.keys(K.TOKEN) as (keyof typeof K.TOKEN)[]) assert.equal(p.seq(token), "\x1b[39m");
});

test("a painter created before theme detection changes its cached escapes and separator", () => {
	K.applyTheme(K.BG);
	const p = makePainter("truecolor"), dark = p.tone("primary", "Life-OS"), sep = p.sep;
	K.applyTheme(bg);
	assert.equal(p.seq("primary"), K.fgSeq(K.TOKEN.primary, "truecolor"));
	assert.notEqual(p.tone("primary", "Life-OS"), dark);
	assert.notEqual(p.sep, sep);
	K.applyTheme(K.BG);
	assert.equal(p.tone("primary", "Life-OS"), dark);
	assert.equal(p.sep, sep);
});

for (const mode of ["truecolor", "256"] as const) {
	test(`${mode}: every footer text/metric/status has >=4.5 contrast after a live theme switch`, () => {
		K.applyTheme(K.BG);
		const p = makePainter(mode);
		K.applyTheme(bg);
		for (const pct of [9, 70, 90]) for (const status of ["registered", "waiting", "error", "disabled"]) {
			for (const line of renderLines(frame(pct, status), p).lines) assertReadable(line);
		}
		for (let hue = 0; hue < K.TAB_HUES.length; hue++) for (const focused of [true, false]) {
			assertReadable(p.color(K.tabColor(hue, focused), "●"));
		}
		assertReadable(p.tone("brandHighlight", "Working…"));
	});
}
