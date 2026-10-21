/**
 * tabline — one extension for pi's editor rules, working spinner and status bar.
 *
 *   ── ✻ Crunching… 18s · ↓ 54 tok ───────────────   top rule (spinner embedded)
 *   ▏ input
 *   ─────────────────────────────────────────────   bottom rule
 *   10.14_Slip ●  main                 1 peer · ● relay
 *   std · low        ctx 9.1% · ch 98.8% · out 13k · 212 tok/s
 *
 * Each tab (= project) gets one identity color that only touches the rules and the dot
 * after the project name; everything else is neutral gray. Brand coral = "agent working",
 * green/amber/red = status only. Merges the former claude-shimmer + footer-lite forks
 * (shimmer derived from pi-claude-shimmer, MIT, ouzhenkun — see LICENSE / PATCHES.md).
 *
 * Cost model: no timers while idle. While the agent runs there is exactly one timer
 * (~18fps with shimmer, 120ms without). Short-lived timers only for the 140ms focus fade
 * and for the reconnecting dot. Rule strings are cached per (width, color, bg).
 * Off switch: /tabline off. Uninstall: delete the directory + /reload.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as K from "./color.ts";

const { TOKEN: T } = K;
const mode = K.detectMode();
const env = process.env;
const motion = !!process.stdout.isTTY && mode === "truecolor" && env.NO_MOTION !== "1" && env.REDUCE_MOTION !== "1";

// ─── painting ────────────────────────────────────────────────────

const SEQ = Object.fromEntries(Object.entries(T).map(([k, c]) => [k, K.fgSeq(c, mode)])) as Record<keyof typeof T, string>;
const P = (tok: keyof typeof T, s: string) => (mode === "none" ? s : SEQ[tok] + s + K.RESET_FG);
const PC = (c: K.C, s: string) => (mode === "none" ? s : K.fgSeq(c, mode) + s + K.RESET_FG);
const SEP = ` ${P("separator", "·")} `;
const k = (n: number) => (n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : `${(n / 1e6).toFixed(1)}M`);

// ─── shared state ────────────────────────────────────────────────

type Msg = {
	role?: string; model?: string; responseModel?: string; stopReason?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};

let enabled = true;
let tuiRef: any;
const redraw = () => tuiRef?.requestRender?.();
let bg: K.RGB = K.BG;

// tab identity + focus fade
let tabKey = "";
let tabIndex = 0;
let tabActive = K.tabColor(0, true);
let tabDim = K.tabColor(0, false);
let focusP = 1; // 1 = focused color, 0 = dim color
let focusTimer: ReturnType<typeof setInterval> | undefined;
const baseColor = (): K.C =>
	focusP >= 1 ? tabActive : focusP <= 0 ? tabDim : { rgb: K.mixOklab(tabDim.rgb, tabActive.rgb, focusP), a16: focusP > 0.5 ? tabActive.a16 : tabDim.a16 };

function setFocus(focused: boolean) {
	const target = focused ? 1 : 0;
	if (focusTimer) clearInterval(focusTimer);
	focusTimer = undefined;
	if (!motion) { focusP = target; redraw(); return; }
	const from = focusP, t0 = Date.now();
	focusTimer = setInterval(() => {
		const p = Math.min(1, (Date.now() - t0) / 140);
		focusP = from + (target - from) * (1 - (1 - p) ** 3);
		if (p >= 1 && focusTimer) { clearInterval(focusTimer); focusTimer = undefined; }
		redraw();
	}, 16);
	focusTimer.unref?.();
}

// output / speed stats (session scope, matches pi's own ↓ total)
let outTotal = 0;
let lastMsg: Msg | undefined;
let dirty = true;
let tokPerSec: number | undefined;
let streamStart: number | undefined;
const okMsg = (m: Msg) => m.stopReason !== "error" && m.stopReason !== "aborted";
function rescan(ctx: any) {
	outTotal = 0;
	lastMsg = undefined;
	for (const e of ctx.sessionManager.getEntries() as any[]) {
		const m = e?.type === "message" ? (e.message as Msg) : undefined;
		if (m?.role === "toolResult") outTotal += m.usage?.output ?? 0;
		else if (m?.role === "assistant") { outTotal += m.usage?.output ?? 0; if (okMsg(m)) lastMsg = m; }
		else if (e?.type === "usage" || e?.type === "compaction" || e?.type === "branch_summary") outTotal += e.usage?.output ?? 0;
	}
	dirty = false;
}

// working run (spinner)
const VERBS = [
	"Scampering", "Brewing", "Crafting", "Pondering", "Tinkering", "Analyzing", "Architecting", "Baking", "Building", "Calculating",
	"Cerebrating", "Churning", "Cogitating", "Composing", "Computing", "Concocting", "Conjuring", "Cooking", "Crunching", "Deciphering",
	"Discombobulating", "Doodling", "Elucidating", "Fermenting", "Finagling", "Flibbertigibbeting", "Forging", "Frolicking", "Gallivanting",
	"Generating", "Hatching", "Herding", "Ideating", "Incubating", "Mulling", "Musing", "Noodling", "Percolating", "Puzzling", "Ruminating",
	"Simmering", "Spelunking", "Synthesizing", "Wandering", "Whirring", "Wibbling", "Wrangling", "Zigzagging",
];
const DONE = ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Percolated", "Pondered", "Sautéed", "Scampered", "Tinkered", "Worked"];
const QUIPS = ["Fresh out of the oven.", "Nailed it. Probably.", "Tea break earned.", "Another one for the books.", "No bugs were harmed.", "That went smoothly.", "Stretch your legs!", "Ready for the next quest."];
const GLYPHS = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"];
const GLYPH_INTERVAL = 120;
const SHIMMER_PERIOD = 2000;
const SIGMA = 2.5;
const PEAK = 1;
const FRAME_MS = motion ? 55 : GLYPH_INTERVAL; // ~18fps

const run = {
	active: false, verb: "", text: "", colStart: [] as number[], textCols: 0,
	start: 0, thinking: false, requesting: true,
	responseLen: 0, shownLen: 0, out: 0,
};
let runTimer: ReturnType<typeof setInterval> | undefined;
let runNotifyUi: any;
const BRAND_LAB = K.srgbToOklab(T.brand.rgb);
const HI_LAB = K.srgbToOklab(T.brandHighlight.rgb);
const pick = <X,>(a: X[]) => a[Math.floor(Math.random() * a.length)];

function startRun(ui: any) {
	if (run.active) return;
	run.active = true;
	run.verb = pick(VERBS);
	run.text = run.verb + "…";
	run.colStart = [];
	let c = 0;
	for (const ch of run.text) { run.colStart.push(c); c += Math.max(1, visibleWidth(ch)); }
	run.textCols = c;
	run.start = Date.now();
	run.thinking = false; run.requesting = true;
	run.responseLen = 0; run.shownLen = 0; run.out = 0;
	runNotifyUi = ui;
	ui?.setWorkingIndicator?.({ frames: [] }); // we draw the spinner ourselves; stops pi's own loader timer
	runTimer = setInterval(() => {
		const gap = run.responseLen - run.shownLen;
		if (gap > 0) run.shownLen += Math.min(gap, Math.max(3, Math.ceil(gap * 0.12)));
		redraw();
	}, FRAME_MS);
	runTimer.unref?.();
	redraw();
}
function stopRun() {
	if (runTimer) clearInterval(runTimer);
	runTimer = undefined;
	run.active = false;
	try { runNotifyUi?.setWorkingIndicator?.(); } catch {}
}

const fmtDur = (ms: number) => {
	const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
	return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

/** Shimmered verb + glyph, already colored. Returns [glyph, verb]. */
function spinnerParts(): [string, string] {
	const t = Date.now() - run.start;
	const gi = Math.floor(t / GLYPH_INTERVAL) % GLYPHS.length;
	if (!motion) return [PC(T.brand, GLYPHS[gi]), PC(T.brand, run.text)];
	const n = run.textCols;
	const pad = 2 * SIGMA;
	const x = -pad + (n - 1 + 2 * pad) * ((t % SHIMMER_PERIOD) / SHIMMER_PERIOD);
	const intensity = (col: number) => PEAK * Math.exp(-0.5 * ((col - x) / SIGMA) ** 2);
	const seqOf = (kk: number) => (kk < 0.02 ? SEQ.brand : K.fgSeq({ rgb: K.mixLab(BRAND_LAB, HI_LAB, kk), a16: 33 }, mode));
	let verb = "", last = "", i = 0;
	for (const ch of run.text) {
		const s = seqOf(intensity(run.colStart[i++]));
		if (s !== last) { verb += s; last = s; }
		verb += ch;
	}
	verb += K.RESET_FG;
	return [seqOf(0.5 * intensity(0)) + GLYPHS[gi] + K.RESET_FG, verb];
}

// ─── editor (rules) ──────────────────────────────────────────────

class TabEditor extends CustomEditor {
	constructor(tui: any, theme: any, keybindings: any) {
		super(tui, theme, keybindings, { embedWorkingStatus: true } as any);
	}

	private seqs(W: number) {
		const base = baseColor();
		// keep pi's fallback (retry/compaction indicators) in the identity color too
		const seq = K.fgSeq(base, mode);
		(this as any).borderColor = (s: string) => (mode === "none" ? s : seq + s + K.RESET_FG);
		return K.ruleSeqs(W, base, bg, mode);
	}

	private overflow(W: number, count: number, arrow: string, minCol: number) {
		if (count <= 0) return undefined;
		const text = ` ${arrow} ${count} more `;
		const width = visibleWidth(text);
		const col = Math.floor((W - width) / 2);
		return col >= minCol && width + 2 <= W ? { col, text: P("label", text), width } : undefined;
	}

	renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!enabled) return super.renderTopBorder(width, hiddenLineCount);
		const seqs = this.seqs(width);
		if (!run.active) {
			if ((this as any).workingStatusIndicator && width > 0) return super.renderTopBorder(width, hiddenLineCount);
			const o = this.overflow(width, hiddenLineCount, "↑", 1);
			return K.composeRule(width, seqs, mode, o ? [o] : []);
		}
		const [glyph, verb] = spinnerParts();
		const parts: string[] = [];
		const elapsed = Date.now() - run.start;
		if (run.thinking) parts.push("thinking");
		if (elapsed > 1000) parts.push(fmtDur(elapsed));
		const tokens = Math.round(run.shownLen / 4);
		if (tokens > 0) parts.push(`${run.requesting ? "↑" : "↓"} ${k(tokens)} tok`);
		const head = ` ${glyph} ${verb}`;
		const headW = 2 + 1 + run.textCols; // " g " + verb
		const lead = Math.min(K.LEAD, width);
		let text = head + " ", w = headW + 1;
		for (const cand of [parts, parts.filter((p) => p !== "thinking"), parts.slice(-1), []]) {
			const label = cand.join(" · ");
			const lw = visibleWidth(label);
			const total = headW + (lw ? 1 + lw : 0) + 1;
			if (lead + total + 1 <= width) {
				text = head + (lw ? " " + P("label", label) : "") + " ";
				w = total;
				break;
			}
		}
		if (lead + w + 1 > width) return K.composeRule(width, seqs, mode); // too narrow for text
		const o = this.overflow(width, hiddenLineCount, "↑", lead + w + 1);
		return K.composeRule(width, seqs, mode, [{ col: lead, text, width: w }, ...(o ? [o] : [])]);
	}

	renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (!enabled) return super.renderBottomBorder(width, hiddenLineCount);
		const o = this.overflow(width, hiddenLineCount, "↓", 1);
		return K.composeRule(width, this.seqs(width), mode, o ? [o] : []);
	}
}

// ─── footer ──────────────────────────────────────────────────────

/** `claude/claude-sonnet-5-5` → `Sonnet 5.5`. */
function pretty(id: string): string {
	const p = id.slice(id.lastIndexOf("/") + 1).replace(/^claude-/, "").split("-").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < p.length; i++) {
		if (/^\d+$/.test(p[i]) && /^\d+$/.test(p[i + 1] ?? "")) out.push(`${p[i]}.${p[++i]}`);
		else if (!/^20\d{6}$/.test(p[i])) out.push(p[i][0].toUpperCase() + p[i].slice(1));
	}
	return out.join(" ") || id;
}

const nerd = env.PI_NERD_FONT ? env.PI_NERD_FONT === "1" : ["ghostty", "WezTerm", "iTerm.app", "kitty"].includes(env.TERM_PROGRAM ?? "");
const BRANCH = nerd ? "\ue0a0 " : "";

// reconnecting dot pulses (L−0.25) with a 1200ms sine; the timer lives only while reconnecting
const WARN_LAB = K.srgbToOklab(T.warn.rgb);
const WARN_LOW: K.Lab = [WARN_LAB[0] - 0.25, WARN_LAB[1], WARN_LAB[2]];
let pulseTimer: ReturnType<typeof setInterval> | undefined;
function pulse(on: boolean) {
	if (on && !pulseTimer && motion) { pulseTimer = setInterval(redraw, 80); pulseTimer.unref?.(); }
	else if (!on && pulseTimer) { clearInterval(pulseTimer); pulseTimer = undefined; }
}
const warnDot = () => {
	if (!motion) return P("warn", "●");
	const t = (Math.sin((Date.now() / 1200) * Math.PI * 2) + 1) / 2;
	return PC({ rgb: K.mixLab(WARN_LOW, WARN_LAB, t), a16: 93 }, "●");
};

type Item = { text: string; prio: number };
/** Extension statuses → items. prio = survival on narrow terminals (higher stays). */
function statusItems(statuses: ReadonlyMap<string, string>): { items: Item[]; connecting: boolean } {
	const items: Item[] = [];
	let connecting = false;
	for (const [key, raw] of statuses) {
		const t = String(raw).replace(/\s+/g, " ").trim();
		if (!t) continue;
		if (key === "remote-pi:relay") {
			const err = /disconnect|offline|error|fail|closed|lost/i.test(t);
			const wait = !err && /waiting|pair|connect|retry/i.test(t);
			connecting ||= wait;
			items.push({ text: (err ? P("error", "●") : wait ? warnDot() : P("ok", "●")) + " " + P("secondary", "relay"), prio: 3 });
		} else if (key === "remote-pi:session") {
			const m = /^📡\s*(\S+)\s*\((\d+)\)$/.exec(t);
			const n = m ? Number(m[2]) : NaN;
			if (n === 0) continue;
			items.push({ text: P("secondary", m ? `${n} peer${n > 1 ? "s" : ""}${m[1] === "local" ? "" : ` ${m[1]}`}` : t), prio: 1 });
		} else if (key === "remote-pi:peer-active") {
			const m = /^📱\s*(.+)$/.exec(t);
			items.push({ text: P("secondary", m ? m[1] : t), prio: 0 });
		} else items.push({ text: P("secondary", t), prio: 2 });
	}
	// peer first, relay last (matches the spec's "1 peer · ● relay")
	items.sort((a, b) => a.prio - b.prio || 0);
	return { items, connecting };
}

const fit = (left: string, right: string, width: number) => {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 2 ? left + " ".repeat(gap) + right : undefined;
};

function renderFooter(ctx: any, data: any, width: number): string[] {
	if (dirty) rescan(ctx);

	// line 1: project ● branch ........ peers · relay
	const cwd = String(ctx.cwd ?? "").replace(/\/+$/, "");
	const project = cwd === env.HOME ? "~" : cwd.slice(cwd.lastIndexOf("/") + 1);
	const branch = data.getGitBranch();
	const l1 = P("primary", project) + " " + PC(baseColor(), "●") + (branch ? " " + P("label", BRANCH + branch) : "");
	const { items, connecting } = statusItems(data.getExtensionStatuses());
	pulse(connecting);
	while (items.length > 1 && visibleWidth(l1) + 2 + visibleWidth(items.map((s) => s.text).join(SEP)) > width)
		items.splice(items.reduce((lo, s, i) => (s.prio < items[lo].prio ? i : lo), 0), 1);
	const ln1 = fit(l1, items.map((s) => s.text).join(SEP), width) ?? l1;

	// line 2 left: route · thinking
	const id: string | undefined = ctx.model?.id;
	let model = id?.startsWith("group/") ? id.slice(6) : id ? pretty(id) : "no-model";
	const actual = lastMsg?.responseModel;
	let modelStr = P("secondary", model);
	if (ctx.isIdle() && id?.startsWith("group/") && lastMsg?.model === id && actual && actual !== id) modelStr += P("label", ` → ${pretty(actual)}`);
	const thinking = ctx.thinkingLevel ? P("secondary", ctx.thinkingLevel) : "";
	const modeStr = modelStr + (thinking ? SEP + thinking : "");

	// line 2 right: ctx · ch · out · tok/s   (drop order: out, ch, mode; ctx + tok/s stay)
	const pct = ctx.getContextUsage()?.percent;
	const metric = (label: string, value: string, tok: keyof typeof T = "primary") => P("label", label + " ") + P(tok, value);
	const ctxTok = pct == null ? "primary" : pct >= 85 ? "error" : pct >= 60 ? "warn" : "primary";
	const ctxPart = metric("ctx", pct == null ? "?" : `${pct.toFixed(1)}%`, ctxTok);
	const u = lastMsg?.usage;
	const denom = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
	let chPart: string | undefined;
	if (u && denom > 0 && (u.cacheRead || u.cacheWrite)) {
		const ch = Math.min(100, ((u.cacheRead ?? 0) / denom) * 100);
		chPart = metric("ch", `${ch.toFixed(1)}%`, ch < 20 ? "error" : ch < 50 ? "warn" : "primary");
	}
	const outPart = outTotal > 0 ? metric("out", k(outTotal)) : undefined;
	const speedPart = tokPerSec !== undefined ? P(run.active ? "brand" : "primary", `${tokPerSec < 100 ? tokPerSec.toFixed(1) : Math.round(tokPerSec)}`) + P("label", " tok/s") : undefined;
	const build = (withOut: boolean, withCh: boolean) => [ctxPart, withCh ? chPart : undefined, withOut ? outPart : undefined, speedPart].filter(Boolean).join(SEP);
	const tries: [string, boolean, boolean][] = [[modeStr, true, true], [modeStr, false, true], [modeStr, false, false], ["", false, false]];
	let ln2: string | undefined;
	for (const [left, o, c] of tries) {
		ln2 = fit(left, build(o, c), width) ;
		if (ln2) break;
	}
	ln2 ??= build(false, false);

	return [ln1, ln2].map((l) => truncateToWidth(l, width));
}

// ─── tab registry (same project → same color; avoid clashes across open tabs) ──

const REG_DIR = path.join(os.tmpdir(), "pi-tabline");
const regFile = path.join(REG_DIR, String(process.pid));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
const unregister = () => { try { fs.unlinkSync(regFile); } catch {} };

function resolveTab(cwd: string) {
	let root = cwd;
	try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 500, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || cwd; } catch {}
	root = root.replace(/\/+$/, "");
	if (process.platform === "darwin") root = root.toLowerCase();
	if (root === tabKey) return;
	const taken = new Map<number, string>();
	try {
		fs.mkdirSync(REG_DIR, { recursive: true });
		for (const f of fs.readdirSync(REG_DIR)) {
			const pid = Number(f);
			if (!pid || pid === process.pid) continue;
			if (!alive(pid)) { try { fs.unlinkSync(path.join(REG_DIR, f)); } catch {} continue; }
			try { const r = JSON.parse(fs.readFileSync(path.join(REG_DIR, f), "utf8")); if (typeof r.index === "number") taken.set(r.index, String(r.key)); } catch {}
		}
	} catch {}
	tabKey = root;
	tabIndex = K.assignTabIndex(root, taken);
	tabActive = K.tabColor(tabIndex, true);
	tabDim = K.tabColor(tabIndex, false);
	try { fs.writeFileSync(regFile, JSON.stringify({ key: root, index: tabIndex })); } catch {}
}

// ─── extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let unsubInput: (() => void) | undefined;
	let focusOn = false;
	process.once("exit", unregister);

	const writeOut = (s: string) => { try { process.stdout.write(s); } catch {} };
	const detach = (ctx?: any) => {
		unsubInput?.();
		unsubInput = undefined;
		if (focusOn) writeOut("\x1b[?1004l");
		focusOn = false;
		if (focusTimer) clearInterval(focusTimer);
		focusTimer = undefined;
		pulse(false);
		focusP = 1;
		void ctx;
	};

	const install = (ctx: any) => {
		if (ctx.mode && ctx.mode !== "tui") return;
		detach();
		dirty = true;
		resolveTab(String(ctx.cwd ?? process.cwd()));
		ctx.ui.setFooter((tui: any, _theme: any, data: any) => {
			tuiRef = tui;
			// real terminal background for the fade (OSC 11 via pi); falls back to the token
			try {
				void Promise.resolve(tui.queryTerminalColors?.({ timeoutMs: 100 })).then((c: any) => {
					const b = c?.background;
					if (b && [b.r, b.g, b.b].every((v: any) => typeof v === "number")) {
						const s = Math.max(b.r, b.g, b.b) > 255 ? 257 : 1; // tolerate 16-bit replies
						bg = [Math.round(b.r / s), Math.round(b.g / s), Math.round(b.b / s)];
						redraw();
					}
				}).catch(() => {});
			} catch {}
			return {
				invalidate() {},
				render(width: number): string[] {
					try { return renderFooter(ctx, data, width); } catch { return [truncateToWidth("tabline: render error (/tabline off)", width)]; }
				},
			};
		});
		const existing = ctx.ui.getEditorComponent?.();
		if (!existing) ctx.ui.setEditorComponent((tui: any, theme: any, kb: any) => { tuiRef = tui; return new TabEditor(tui, theme, kb); });
		if (motion && process.stdout.isTTY) {
			unsubInput = ctx.ui.onTerminalInput((d: string) => {
				if (d === "\x1b[I") { setFocus(true); return { consume: true }; }
				if (d === "\x1b[O") { setFocus(false); return { consume: true }; }
				return undefined;
			});
			writeOut("\x1b[?1004h");
			focusOn = true;
		}
	};

	pi.on("session_start", (_e, ctx) => { if (enabled) install(ctx); else dirty = true; dirty = true; });
	pi.on("session_shutdown", (_e, ctx: any) => {
		stopRun();
		detach(ctx);
		unregister();
		tabKey = "";
		tuiRef = undefined;
	});
	pi.on("session_tree" as any, () => { dirty = true; });
	pi.on("session_compact" as any, () => { dirty = true; });
	for (const ev of ["session_info_changed", "model_select", "thinking_level_select"]) pi.on(ev as any, redraw);

	pi.on("agent_start", (_e, ctx) => { if (enabled) startRun(ctx.ui); });
	pi.on("turn_start", (_e, ctx) => { if (enabled && !run.active) startRun(ctx.ui); });
	pi.on("message_start", () => { streamStart = undefined; });
	pi.on("message_update", (event) => {
		streamStart ??= Date.now();
		if (!run.active) return;
		const evt: any = event.assistantMessageEvent;
		switch (evt.type) {
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
	});
	pi.on("message_end", (e: any) => {
		const m = e?.message as Msg | undefined;
		const out = m?.usage?.output ?? 0;
		if (m?.role === "assistant") {
			run.out += out;
			if (!dirty) {
				outTotal += out;
				if (okMsg(m)) lastMsg = m;
				if (streamStart !== undefined && out > 0) {
					const secs = (Date.now() - streamStart) / 1000;
					if (secs >= 0.5) tokPerSec = out / secs;
				}
			}
			streamStart = undefined;
		} else if (m?.role === "toolResult" && !dirty) outTotal += out;
		redraw();
	});
	pi.on("agent_end", (event: any, ctx: any) => {
		dirty = true;
		if (!run.active) { redraw(); return; }
		const elapsed = Date.now() - run.start;
		const outTokens = run.out;
		stopRun();
		redraw();
		const last = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
		const word = last?.stopReason === "aborted" ? "Interrupted" : last?.stopReason === "error" ? "Stopped" : undefined;
		const msg = word
			? `✻ ${word} after ${fmtDur(elapsed)}`
			: `✻ ${pick(DONE)} for ${fmtDur(elapsed)}${outTokens > 0 ? ` · ${new Intl.NumberFormat("en-US").format(outTokens)} output tokens` : ""} — ${pick(QUIPS)}`;
		ctx.ui?.notify?.(P("label", msg), "info");
	});

	const command = {
		description: "tabline: on | off",
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim();
			if (a === "off") {
				enabled = false;
				stopRun();
				detach(ctx);
				ctx.ui.setFooter(undefined);
				if (ctx.ui.getEditorComponent?.()) ctx.ui.setEditorComponent(undefined);
			} else if (a === "on") {
				enabled = true;
				install(ctx);
			}
			ctx.ui.notify(`tabline: ${enabled ? "on" : "off"}`, "info");
		},
	};
	pi.registerCommand("tabline", command);
}
