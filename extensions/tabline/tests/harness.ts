/**
 * Scenario harness: loads a tabline entry (new index.ts or the pre-redesign monolith) with a
 * mock ExtensionAPI, a fixed clock, fixed Math.random and fake timers, drives fixed scenarios and
 * writes every rendered string to a JSON file.
 *
 *   node tests/harness.ts <entry.ts> <mode> <out.json>
 *   mode: motion | truecolor | 256 | 16 | none
 *
 * Colour mode and motion are read at import time, so each mode needs its own process.
 * The fake timers also let the harness assert the cost model (live timer count per step).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [entryArg, mode, outFile] = process.argv.slice(2);
if (!entryArg || !mode || !outFile) throw new Error("usage: harness.ts <entry> <mode> <out>");

// ─── environment, before the extension is imported ───────────────────
const env = process.env;
for (const k of ["NO_COLOR", "COLORTERM", "TERM", "TERM_PROGRAM", "NO_MOTION", "REDUCE_MOTION"]) delete env[k];
env.PI_NERD_FONT = "1";
env.HOME = "/Users/fixture";
if (mode === "none") env.NO_COLOR = "1";
else if (mode === "motion" || mode === "truecolor") env.COLORTERM = "truecolor";
else if (mode === "256") env.TERM = "xterm-256color";
else env.TERM = "xterm";
Object.defineProperty(process.stdout, "isTTY", { value: mode === "motion", configurable: true });
const realWrite = process.stdout.write.bind(process.stdout);
const written: string[] = [];
(process.stdout as any).write = (s: any) => { written.push(String(s)); return true; };
env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "tabline-reg-")); // isolated tab registry

let NOW = 1_700_000_000_000;
Date.now = () => NOW;
Math.random = () => 0.3;

type Timer = { fn: () => void; ms: number };
const timers = new Map<number, Timer>();
let nextId = 1;
(globalThis as any).setInterval = (fn: () => void, ms: number) => {
	const id = nextId++;
	timers.set(id, { fn, ms });
	return { id, unref() { return this; }, ref() { return this; }, [Symbol.toPrimitive]: () => id };
};
(globalThis as any).clearInterval = (h: any) => { if (h) timers.delete(typeof h === "number" ? h : h.id); };
/** Advance the clock by each timer's period and fire it, `n` times. */
const tick = (n: number) => {
	for (let i = 0; i < n; i++) {
		const live = [...timers.values()];
		if (!live.length) return;
		NOW += Math.min(...live.map((t) => t.ms));
		for (const t of live) t.fn();
	}
};

// ─── mock pi ─────────────────────────────────────────────────────────
const handlers = new Map<string, ((e: any, ctx: any) => any)[]>();
const commands = new Map<string, any>();
const pi: any = {
	on: (ev: string, h: any) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev)!.push(h); },
	registerCommand: (name: string, c: any) => commands.set(name, c),
};
const emit = async (ev: string, e: any = {}) => { for (const h of handlers.get(ev) ?? []) await h(e, ctx); };

class ForeignEditor {
	actionHandlers = new Map();
	workingStatusIndicator: unknown = undefined;
	renderTopBorder(w: number, h: number) { return `ORIG-TOP(${w},${h})`; }
	renderBottomBorder(w: number, h: number) { return `ORIG-BOT(${w},${h})`; }
	invalidate() {}
}
const editor = new ForeignEditor();
const tui = {
	children: [{ children: [{ children: [] }, editor] }],
	requestRender() {},
	queryTerminalColors: () => Promise.resolve({ background: { r: 240 * 257, g: 236 * 257, b: 230 * 257 } }),
};

let footer: any;
let editorComponent: any = "foreign";
let input: ((d: string) => any) | undefined;
const notes: string[] = [];
const indicator: unknown[] = [];
const ui = {
	setFooter: (f: any) => { footer = f ? f(tui, {}, data) : undefined; },
	setEditorComponent: (f: any) => { editorComponent = f; },
	getEditorComponent: () => editorComponent,
	onTerminalInput: (h: any) => { input = h; return () => { if (input === h) input = undefined; }; },
	notify: (m: string) => notes.push(m),
	setWorkingIndicator: (x?: unknown) => indicator.push(x === undefined ? "reset" : x),
};

const FIXTURE = "/tmp/tabline-fixture/10.14_Slip";
fs.mkdirSync(FIXTURE, { recursive: true });
let entries: any[] = [];
let statuses = new Map<string, string>();
let branch: string | undefined = "main";
let pct: number | undefined = 9.1;
let idle = true;
const ctx: any = {
	mode: "tui",
	cwd: FIXTURE,
	ui,
	sessionManager: { getEntries: () => entries },
	model: { id: "claude/claude-sonnet-5-5" },
	thinkingLevel: "low",
	isIdle: () => idle,
	getContextUsage: () => (pct === undefined ? undefined : { percent: pct }),
};
const data = { getGitBranch: () => branch, getExtensionStatuses: () => statuses };

const asst = (output: number, extra: any = {}) => ({ type: "message", message: { role: "assistant", usage: { input: 120, output, cacheRead: 9000, cacheWrite: 30 }, ...extra } });

// ─── record ──────────────────────────────────────────────────────────
const out: { step: string; value: unknown }[] = [];
const rec = (step: string, value: unknown) => out.push({ step, value });
const W = [120, 80, 64, 56, 48, 40, 30, 20, 10];
const footerAt = (tag: string, widths = W) => { for (const w of widths) rec(`${tag} footer w=${w}`, footer?.render(w)); };
const rulesAt = (tag: string, widths = [120, 40, 12, 3, 1, 0], hidden = [0, 3]) => {
	for (const w of widths) for (const h of hidden) {
		rec(`${tag} top w=${w} h=${h}`, editor.renderTopBorder(w, h));
		rec(`${tag} bottom w=${w} h=${h}`, editor.renderBottomBorder(w, h));
	}
};

const mod = await import(path.resolve(entryArg));
mod.default(pi);
rec("commands", [...commands.keys()]);

// 1. idle, no statuses
entries = [asst(1200), { type: "message", message: { role: "toolResult", usage: { output: 0 } } }, { type: "usage", usage: { output: 50 } }];
await emit("session_start");
rec("timers after session_start", timers.size);
rec("focus reporting written", written.filter((s) => s.includes("1004")));
footerAt("idle");
rulesAt("idle");
await new Promise((r) => setImmediate(r)); // OSC 11 reply lands
rulesAt("bg", [120, 40], [0]); // reply already applied during session_start awaits
footerAt("bg", [120]);

// 2. statuses (Perch remote-pi + another extension)
statuses = new Map([
	["remote-pi:peer-active", "📱 iPhone"],
	["remote-pi:session", "📡 local (2)"],
	["other:build", "  build   ok "],
	["empty", "   "],
	["remote-pi:relay", "connected"],
]);
footerAt("statuses");
for (const [label, relay] of [["waiting", "waiting for pair"], ["error", "disconnected"]] as const) {
	statuses.set("remote-pi:relay", relay);
	footerAt(`relay-${label}`, [120, 40]);
	rec(`relay-${label} timers`, timers.size);
}
statuses.delete("remote-pi:relay");
rec("relay gone timers (after one render)", (footer.render(120), timers.size));
for (const s of ["📡 host (1)", "📡 local (0)", "weird session text"]) {
	statuses.set("remote-pi:session", s);
	footerAt(`session ${s}`, [120]);
}
statuses = new Map();

// 3. metrics thresholds, models, home
for (const p of [70, 90, undefined]) { pct = p; footerAt(`ctx=${p}`, [120]); }
pct = 9.1;
entries = [asst(500, { usage: { input: 9000, output: 500, cacheRead: 1000, cacheWrite: 10 } })];
ctx.sessionManager = { getEntries: () => entries };
await emit("session_tree");
footerAt("low cache", [120]);
entries = [asst(500, { usage: { input: 9000, output: 500 } })];
await emit("session_compact");
footerAt("no cache", [120]);
entries = [asst(20_000_000, { model: "group/fast", responseModel: "claude-haiku-4-5-20251001" })];
ctx.model = { id: "group/fast" };
await emit("session_tree");
footerAt("group idle", [120, 40]);
idle = false; footerAt("group busy", [120]); idle = true;
ctx.model = undefined; ctx.thinkingLevel = undefined; branch = undefined;
footerAt("no model", [120]);
ctx.model = { id: "openai/gpt-5-1-20250807" }; ctx.thinkingLevel = "high"; branch = "feature/x";
ctx.cwd = "/Users/fixture";
footerAt("home", [120]);
ctx.cwd = FIXTURE;

// 4. a run
ctx.model = { id: "claude/claude-sonnet-5-5" }; ctx.thinkingLevel = "low"; branch = "main";
entries = [asst(1200)];
await emit("session_tree");
await emit("agent_start");
rec("timers running", timers.size);
rec("indicator", indicator.slice());
rulesAt("run-start", [120, 30, 12], [0, 3]);
await emit("turn_start");
rec("timers after turn_start", timers.size);
await emit("message_start");
await emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
await emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(400) } });
tick(10);
rulesAt("thinking", [120, 40, 30, 24, 20, 12], [0, 3]);
footerAt("thinking", [120]);
await emit("message_update", { assistantMessageEvent: { type: "thinking_end" } });
await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "y".repeat(40_000) } });
tick(25);
NOW += 74_000;
tick(1);
rulesAt("streaming", [120, 40, 30], [0, 3]);
await emit("message_end", { message: { role: "assistant", usage: { input: 1, output: 9000, cacheRead: 5000 } } });
footerAt("running", [120, 56]);
await emit("message_end", { message: { role: "toolResult", usage: { output: 7 } } });
await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
rec("timers after agent_end", timers.size);
rec("notes", notes.slice());
rec("indicator after end", indicator.slice());
footerAt("after run", [120]);
rulesAt("after run", [120], [0]);
// aborted + error runs
for (const stop of ["aborted", "error"]) {
	await emit("agent_start");
	NOW += 3_500;
	await emit("agent_end", { messages: [{ role: "assistant", stopReason: stop }] });
}
rec("notes 2", notes.slice());
// working indicator from another extension while idle → fallback
editor.workingStatusIndicator = {};
rec("foreign indicator idle top", editor.renderTopBorder(80, 0));
editor.workingStatusIndicator = undefined;

// 5. focus fade (motion only)
rec("has focus hook", !!input);
if (input) {
	rec("focus out consumed", input("\x1b[O"));
	tick(3);
	rulesAt("fading", [80], [0]);
	tick(20);
	rec("timers after fade", timers.size);
	rulesAt("dim", [80], [0]);
	footerAt("dim", [80]);
	rec("other input", input("a") ?? null);
	input("\x1b[I");
	tick(20);
	rulesAt("refocused", [80], [0]);
}

// 6. /tabline off | on
await commands.get("tabline").handler("off", ctx);
rec("off footer", footer === undefined);
rulesAt("off", [80], [0, 2]);
rec("off timers", timers.size);
await emit("agent_start");
rec("off run timers", timers.size);
await emit("agent_end", { messages: [] });
await commands.get("tabline").handler("on", ctx);
rulesAt("on", [80], [0]);
footerAt("on", [80]);
rec("notes 3", notes.slice(-2));

// 7. own editor path (no foreign editor) + shutdown
await emit("session_shutdown");
rec("shutdown restored", [editor.renderTopBorder === ForeignEditor.prototype.renderTopBorder, Object.hasOwn(editor, "renderTopBorder")]);
rec("shutdown timers", timers.size);
editorComponent = undefined;
await emit("session_start");
rec("own editor installed", typeof editorComponent);
await emit("session_shutdown");
rec("own editor removed", editorComponent === undefined);
rec("focus escapes total", written.filter((s) => s.includes("1004")));

fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
fs.rmSync(env.TMPDIR!, { recursive: true, force: true });
realWrite("");
