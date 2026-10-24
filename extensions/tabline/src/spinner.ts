/**
 * Working spinner: run lifecycle, the single run timer, and the per-frame head
 * (glyph + shimmered verb + labels) that rules.ts embeds into the top rule.
 * Shimmer derived from pi-claude-shimmer 1.0.7 (MIT, ouzhenkun — see LICENSE).
 *
 * Cost: exactly one setInterval while a run is active (55ms with motion, else 120ms);
 * none otherwise. pi's own loader is hidden (setWorkingIndicator({frames: []})) so its
 * timer stops too.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import * as K from "./color.ts";
import { fmtDur, kfmt } from "./format.ts";
import { paint, term, type Painter } from "./paint.ts";
import { redraw, S, type RunState } from "./state.ts";

export const VERBS = [
	"Scampering", "Brewing", "Crafting", "Pondering", "Tinkering", "Analyzing", "Architecting", "Baking", "Building", "Calculating",
	"Cerebrating", "Churning", "Cogitating", "Composing", "Computing", "Concocting", "Conjuring", "Cooking", "Crunching", "Deciphering",
	"Discombobulating", "Doodling", "Elucidating", "Fermenting", "Finagling", "Flibbertigibbeting", "Forging", "Frolicking", "Gallivanting",
	"Generating", "Hatching", "Herding", "Ideating", "Incubating", "Mulling", "Musing", "Noodling", "Percolating", "Puzzling", "Ruminating",
	"Simmering", "Spelunking", "Synthesizing", "Wandering", "Whirring", "Wibbling", "Wrangling", "Zigzagging",
];
export const DONE = ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Percolated", "Pondered", "Sautéed", "Scampered", "Tinkered", "Worked"];
export const QUIPS = ["Fresh out of the oven.", "Nailed it. Probably.", "Tea break earned.", "Another one for the books.", "No bugs were harmed.", "That went smoothly.", "Stretch your legs!", "Ready for the next quest."];
export const GLYPHS = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"];

export const GLYPH_INTERVAL = 120;
const SHIMMER_PERIOD = 2000;
const SIGMA = 2.5;
const PEAK = 1;
export const FRAME_MS = term.motion ? 55 : GLYPH_INTERVAL; // ~18fps

const pick = <X,>(a: X[]) => a[Math.floor(Math.random() * a.length)];
// Like Painter's escapes, shimmer endpoints follow the palette revision. Convert
// only on the first animated frame after a theme change, never per glyph/frame.
let shimmerRevision = -1;
let brandLab: K.Lab, highlightLab: K.Lab;

let runTimer: ReturnType<typeof setInterval> | undefined;
let indicatorUi: any;

/** Reset `run` for a new run with the given verb (pure; exported for tests). */
export function resetRun(run: RunState, verb: string, now: number): void {
	run.active = true;
	run.verb = verb;
	run.text = verb + "…";
	run.colStart = [];
	let c = 0;
	for (const ch of run.text) { run.colStart.push(c); c += Math.max(1, visibleWidth(ch)); }
	run.textCols = c;
	run.start = now;
	run.thinking = false; run.requesting = true;
	run.responseLen = 0; run.shownLen = 0; run.out = 0;
}

/** Ease shown characters toward received ones: ≥3 chars or 12% of the gap per frame. */
export function easeShown(run: RunState): void {
	const gap = run.responseLen - run.shownLen;
	if (gap > 0) run.shownLen += Math.min(gap, Math.max(3, Math.ceil(gap * 0.12)));
}

export function startRun(ui: any): void {
	if (S.run.active) return;
	resetRun(S.run, pick(VERBS), Date.now());
	indicatorUi = ui;
	ui?.setWorkingIndicator?.({ frames: [] }); // we draw the spinner; stops pi's loader timer
	runTimer = setInterval(() => { easeShown(S.run); redraw(); }, FRAME_MS);
	runTimer.unref?.();
	redraw();
}

export function stopRun(): void {
	if (runTimer) clearInterval(runTimer);
	runTimer = undefined;
	S.run.active = false;
	try { indicatorUi?.setWorkingIndicator?.(); } catch {}
	indicatorUi = undefined;
}

/** Map an assistantMessageEvent onto run flags/counters. */
export function onStreamEvent(run: RunState, evt: { type?: string; delta?: unknown }): void {
	switch (evt?.type) {
		case "thinking_start": run.thinking = true; run.requesting = false; break;
		case "thinking_end": run.thinking = false; break;
		case "thinking_delta":
		case "text_delta":
		case "toolcall_delta":
			if (evt.type === "text_delta") run.thinking = false;
			run.requesting = false;
			if (typeof evt.delta === "string") run.responseLen += evt.delta.length;
			break;
		case "text_start":
		case "toolcall_start": run.requesting = false; break;
	}
}

/** What the top rule shows while running. `labels` are in drop order: thinking, duration, tokens. */
export interface SpinnerHead {
	glyph: string;
	verb: string;
	/** Visible columns of `verb` (escapes excluded). */
	verbCols: number;
	labels: { id: "thinking" | "elapsed" | "tokens"; text: string }[];
}

/** Uncolored labels for a run at `now` (pure). Tokens ≈ shown chars / 4. */
export function runLabels(run: RunState, now: number): SpinnerHead["labels"] {
	const labels: SpinnerHead["labels"] = [];
	const elapsed = now - run.start;
	if (run.thinking) labels.push({ id: "thinking", text: "thinking" });
	if (elapsed > 1000) labels.push({ id: "elapsed", text: fmtDur(elapsed) });
	const tokens = Math.round(run.shownLen / 4);
	if (tokens > 0) labels.push({ id: "tokens", text: `${run.requesting ? "↑" : "↓"} ${kfmt(tokens)} tok` });
	return labels;
}

export function spinnerHead(run: RunState, now: number, p: Painter = paint, motion = term.motion): SpinnerHead {
	const t = now - run.start;
	const gi = Math.floor(t / GLYPH_INTERVAL) % GLYPHS.length;
	const labels = runLabels(run, now);
	if (!motion || p.mode !== "truecolor") {
		return { glyph: p.tone("brand", GLYPHS[gi]), verb: p.tone("brand", run.text), verbCols: run.textCols, labels };
	}
	if (shimmerRevision !== K.themeRevision) {
		brandLab = K.srgbToOklab(K.TOKEN.brand.rgb);
		highlightLab = K.srgbToOklab(K.TOKEN.brandHighlight.rgb);
		shimmerRevision = K.themeRevision;
	}
	const n = run.textCols;
	const pad = 2 * SIGMA;
	const x = -pad + (n - 1 + 2 * pad) * ((t % SHIMMER_PERIOD) / SHIMMER_PERIOD);
	const intensity = (col: number) => PEAK * Math.exp(-0.5 * ((col - x) / SIGMA) ** 2);
	const seqOf = (k: number) => (k < 0.02 ? p.seq("brand") : K.fgSeq({ rgb: K.mixLab(brandLab, highlightLab, k), a16: 33 }, p.mode));
	let verb = "", last = "", i = 0;
	for (const ch of run.text) {
		const s = seqOf(intensity(run.colStart[i++]));
		if (s !== last) { verb += s; last = s; }
		verb += ch;
	}
	verb += K.RESET_FG;
	return { glyph: seqOf(0.5 * intensity(0)) + GLYPHS[gi] + K.RESET_FG, verb, verbCols: run.textCols, labels };
}

/** Completion notice text (uncolored). `stopReason` of the last assistant message decides the wording. */
export function doneMessage(stopReason: string | undefined, elapsedMs: number, outTokens: number, rnd: <X>(a: X[]) => X = pick): string {
	const word = stopReason === "aborted" ? "Interrupted" : stopReason === "error" ? "Stopped" : undefined;
	if (word) return `✻ ${word} after ${fmtDur(elapsedMs)}`;
	const toks = outTokens > 0 ? ` · ${new Intl.NumberFormat("en-US").format(outTokens)} output tokens` : "";
	return `✻ ${rnd(DONE)} for ${fmtDur(elapsedMs)}${toks} — ${rnd(QUIPS)}`;
}
