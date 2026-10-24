/**
 * Color system for tabline: OKLab math, tokens, tab identity colors, fading rules,
 * terminal capability detection and escape output. See ../DESIGN.md.
 * All interpolation happens in OKLab; hex values are derived from OKLCH sources.
 */

export type RGB = [number, number, number];
export type Lab = [number, number, number];
export type ColorMode = "truecolor" | "256" | "16" | "none";
/** A color with its 16-color fallback (SGR code). */
export type C = { rgb: RGB; a16: number };

// ─── OKLab ───────────────────────────────────────────────────────

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function srgbToOklab([r, g, b]: RGB): Lab {
	const R = toLin(r / 255), G = toLin(g / 255), B = toLin(b / 255);
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function oklabToLinear([L, a, b]: Lab): [number, number, number] {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const inGamut = (v: number[]) => v.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
const linToRgb = (v: number[]): RGB => v.map((c) => Math.round(255 * toGam(Math.min(1, Math.max(0, c))))) as RGB;
export const oklabToSrgb = (lab: Lab): RGB => linToRgb(oklabToLinear(lab));

/** Out-of-gamut colors keep L and h; chroma is bisected down (no hue drift). */
export function oklchToSrgb(L: number, C: number, h: number): RGB {
	const rad = (h * Math.PI) / 180;
	const at = (c: number): Lab => [L, c * Math.cos(rad), c * Math.sin(rad)];
	if (inGamut(oklabToLinear(at(C)))) return oklabToSrgb(at(C));
	let lo = 0, hi = C;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklabToLinear(at(mid)))) lo = mid;
		else hi = mid;
	}
	return oklabToSrgb(at(lo));
}

export function mixLab(A: Lab, B: Lab, t: number): RGB {
	return oklabToSrgb([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
export const mixOklab = (a: RGB, b: RGB, t: number): RGB => mixLab(srgbToOklab(a), srgbToOklab(b), t);

export const toHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

// ─── Tokens ──────────────────────────────────────────────────────

const N = (L: number) => oklchToSrgb(L, 0.012, 285);
export const BG: RGB = N(0.19);
export const TOKEN = {
	primary: { rgb: N(0.94), a16: 39 },
	secondary: { rgb: N(0.65), a16: 90 },
	label: { rgb: N(0.48), a16: 90 },
	separator: { rgb: N(0.36), a16: 90 },
	ruleNeutral: { rgb: N(0.3), a16: 90 },
	brand: { rgb: oklchToSrgb(0.74, 0.12, 45), a16: 33 },
	brandHighlight: { rgb: oklchToSrgb(0.86, 0.08, 55), a16: 33 },
	ok: { rgb: oklchToSrgb(0.78, 0.14, 155), a16: 92 },
	warn: { rgb: oklchToSrgb(0.8, 0.13, 80), a16: 93 },
	error: { rgb: oklchToSrgb(0.68, 0.17, 25), a16: 91 },
} satisfies Record<string, C>;

// ─── Tab identity colors ─────────────────────────────────────────

export const TAB_HUES = [275, 190, 355, 240, 115, 305];
const TAB_A16 = [34, 36, 35, 34, 32, 35]; // 16-color fallback per hue
const ACTIVE = { L: 0.72, C: 0.09 };
const DIM = { L: 0.4, C: 0.04 };

export function tabColor(index: number, focused: boolean): C {
	const n = TAB_HUES.length;
	const i = ((index % n) + n) % n;
	const { L, C } = focused ? ACTIVE : DIM;
	return { rgb: oklchToSrgb(L, C, TAB_HUES[i]), a16: focused ? TAB_A16[i] : 90 };
}

const RESERVED = [45, 80, 155, 25]; // brand, warn, ok, error
const hueDist = (a: number, b: number) => {
	const d = Math.abs(a - b) % 360;
	return Math.min(d, 360 - d);
};
export function validateHues(hues: number[]): string[] {
	const errs: string[] = [];
	for (const h of hues) for (const r of RESERVED) if (hueDist(h, r) < 25) errs.push(`hue ${h} too close to reserved ${r}`);
	for (let i = 0; i < hues.length; i++)
		for (let j = i + 1; j < hues.length; j++) if (hueDist(hues[i], hues[j]) < 25) errs.push(`hue ${hues[i]} too close to ${hues[j]}`);
	return errs;
}

export function fnv1a32(s: string): number {
	let h = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(s)) {
		h ^= byte;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export function assignTabIndex(key: string, taken: Map<number, string>): number {
	const n = TAB_HUES.length;
	const preferred = fnv1a32(key) % n;
	for (let k = 0; k < n; k++) {
		const i = (preferred + k) % n;
		const owner = taken.get(i);
		if (owner === undefined || owner === key) return i;
	}
	return preferred;
}

// ─── Terminal capability + escapes ───────────────────────────────

export function detectMode(env: Record<string, string | undefined> = process.env): ColorMode {
	if (env.NO_COLOR !== undefined) return "none";
	const ct = env.COLORTERM;
	if (ct === "truecolor" || ct === "24bit") return "truecolor";
	if (["iTerm.app", "WezTerm", "ghostty", "vscode", "WarpTerminal"].includes(env.TERM_PROGRAM ?? "")) return "truecolor";
	if ((env.TERM ?? "").includes("256color")) return "256";
	return "16";
}

const CUBE = [0, 95, 135, 175, 215, 255];
let pal256: { idx: number; lab: Lab }[] | undefined;
const near256Cache = new Map<number, number>();
function nearest256(rgb: RGB): number {
	const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
	const hit = near256Cache.get(key);
	if (hit !== undefined) return hit;
	if (!pal256) {
		pal256 = [];
		for (let i = 16; i < 232; i++) {
			const n = i - 16;
			pal256.push({ idx: i, lab: srgbToOklab([CUBE[Math.floor(n / 36)], CUBE[Math.floor(n / 6) % 6], CUBE[n % 6]]) });
		}
		for (let i = 232; i < 256; i++) {
			const v = 8 + 10 * (i - 232);
			pal256.push({ idx: i, lab: srgbToOklab([v, v, v]) });
		}
	}
	const t = srgbToOklab(rgb);
	let best = 16, bd = Infinity;
	for (const p of pal256) {
		const d = (p.lab[0] - t[0]) ** 2 + (p.lab[1] - t[1]) ** 2 + (p.lab[2] - t[2]) ** 2;
		if (d < bd) { bd = d; best = p.idx; }
	}
	if (near256Cache.size > 512) near256Cache.clear();
	near256Cache.set(key, best);
	return best;
}

export const RESET_FG = "\x1b[39m";

/** Foreground escape for a color in the given mode ('' when colors are off). */
export function fgSeq(c: C, mode: ColorMode): string {
	switch (mode) {
		case "truecolor": return `\x1b[38;2;${c.rgb[0]};${c.rgb[1]};${c.rgb[2]}m`;
		case "256": return `\x1b[38;5;${nearest256(c.rgb)}m`;
		case "16": return `\x1b[${c.a16}m`;
		default: return "";
	}
}

// ─── Fading rule ─────────────────────────────────────────────────

export const FADE_START = 0.45;
export const FADE_END_MIX = 0.82;
export const LEAD = 2;

export function ruleColorAt(i: number, W: number, base: RGB, bg: RGB): RGB {
	const t = W <= 1 ? 0 : i / (W - 1);
	if (t <= FADE_START) return base;
	const u = (t - FADE_START) / (1 - FADE_START);
	const s = u * u * (3 - 2 * u);
	return mixOklab(base, bg, s * FADE_END_MIX);
}

const ruleCache = new Map<string, string[]>();
/** Per-column escape sequences of a rule (cached by width/base/bg/mode). */
export function ruleSeqs(W: number, base: C, bg: RGB, mode: ColorMode): string[] {
	const key = `${W}|${base.rgb.join(",")}|${base.a16}|${bg.join(",")}|${mode}`;
	const hit = ruleCache.get(key);
	if (hit) return hit;
	let out: string[];
	if (mode === "none") out = new Array(W).fill("");
	else if (mode === "16") out = new Array(W).fill(fgSeq(base, mode));
	else if (mode === "256") {
		const segs = [fgSeq(base, mode), fgSeq({ rgb: mixOklab(base.rgb, bg, 0.4), a16: 0 }, mode), fgSeq({ rgb: mixOklab(base.rgb, bg, 0.75), a16: 0 }, mode)];
		out = Array.from({ length: W }, (_, i) => {
			const t = W <= 1 ? 0 : i / (W - 1);
			return t <= FADE_START ? segs[0] : t <= 0.75 ? segs[1] : segs[2];
		});
	} else out = Array.from({ length: W }, (_, i) => fgSeq({ rgb: ruleColorAt(i, W, base.rgb, bg), a16: 0 }, mode));
	if (ruleCache.size >= 48) ruleCache.clear();
	ruleCache.set(key, out);
	return out;
}

/** Draw `─` for columns [from, to), merging runs of identical escapes. No trailing reset. */
function dashRun(seqs: string[], from: number, to: number): string {
	let out = "", last: string | undefined;
	for (let i = from; i < to; i++) {
		const s = seqs[i];
		if (s !== last) { out += s; last = s; }
		out += "─";
	}
	return out;
}

/**
 * Compose a full-width rule with pre-rendered segments (already colored, `width` visible cols)
 * placed at absolute columns. Rule columns keep their absolute gradient position.
 */
export function composeRule(W: number, seqs: string[], mode: ColorMode, segs: { col: number; text: string; width: number }[] = []): string {
	let out = "", col = 0;
	for (const s of [...segs].sort((a, b) => a.col - b.col)) {
		if (s.col < col || s.col + s.width > W) continue;
		out += dashRun(seqs, col, s.col) + (mode === "none" ? "" : RESET_FG) + s.text;
		col = s.col + s.width;
	}
	out += dashRun(seqs, col, W);
	return mode === "none" ? out : out + RESET_FG;
}
