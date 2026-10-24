/** Unit tests for the pure modules: format, layout, rules, stats, segments, push parser. */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as K from "../src/color.ts";
import { fmtDur, fmtRate, kfmt, prettyModel } from "../src/format.ts";
import { renderLines } from "../src/footer.ts";
import { layoutLine, type Piece } from "../src/layout.ts";
import { makePainter } from "../src/paint.ts";
import { bottomRule, headSeg, overflowSeg, topRule } from "../src/rules.ts";
import { buildSegments, PINNED, type FooterInput, type Segment } from "../src/segments/index.ts";
import { parsePushStatus, pushSegment, renderPush } from "../src/segments/push.ts";
import { doneMessage, easeShown, resetRun, runLabels, spinnerHead } from "../src/spinner.ts";
import type { RunState } from "../src/state.ts";
import { addMessage, cacheHit, scanEntries, type Stats } from "../src/stats.ts";

const P = makePainter("none");
const SEP = P.sep;

test("format", () => {
	assert.deepEqual([950, 9_100, 54_000, 1_200_000].map(kfmt), ["950", "9.1k", "54k", "1.2M"]);
	assert.deepEqual([999, 18_400, 74_000].map(fmtDur), ["0s", "18s", "1m 14s"]);
	assert.equal(prettyModel("claude/claude-sonnet-5-5"), "Sonnet 5.5");
	assert.equal(prettyModel("claude-haiku-4-5-20251001"), "Haiku 4.5");
	assert.deepEqual([12.345, 212.4].map(fmtRate), ["12.3", "212"]);
});

test("layout: gap, drop lowest prio, ties farthest from edge, pinned truncates", () => {
	const pc = (text: string, side: Piece["side"], order: number, prio: number): Piece => ({ text, side, order, prio });
	const L = pc("left", "left", 0, PINNED);
	const a = pc("aaa", "right", 0, 1), b = pc("bbb", "right", 1, 1), c = pc("ccc", "right", 2, 2);
	assert.equal(layoutLine([L, a, b, c], 30, SEP), "left" + " ".repeat(11) + "aaa · bbb · ccc");
	assert.equal(layoutLine([L, a, b, c], 18, SEP), "left" + " ".repeat(5) + "bbb · ccc"); // a: same prio, farther from edge
	assert.equal(layoutLine([L, a, b, c], 10, SEP), "left   ccc");
	assert.equal(layoutLine([L, c], 8, SEP), "left    "); // all droppable gone → padded left
	assert.equal(layoutLine([L, pc("RIGHT", "right", 0, PINNED)], 6, SEP), "left  RIGHT"); // caller truncates
	assert.equal(layoutLine([L, { ...pc("br", "left", 1, PINNED), join: "space" }], 10, SEP), "left br   ");
});

test("rules: overflow marker, head fallbacks, plain when too narrow", () => {
	const r = { width: 40, hidden: 3, base: K.tabColor(0, true), bg: K.BG, p: P };
	assert.equal(bottomRule(r), "─".repeat(15) + " ↓ 3 more " + "─".repeat(15));
	assert.equal(overflowSeg(9, 3, "↑", 1, P), undefined); // 10 cols marker can't fit
	const head = { glyph: "✻", verb: "Crunching…", verbCols: 10, labels: [{ id: "thinking" as const, text: "thinking" }, { id: "elapsed" as const, text: "18s" }, { id: "tokens" as const, text: "↓ 54 tok" }] };
	assert.equal(topRule({ ...r, hidden: 0 }, head), "── ✻ Crunching… 18s · ↓ 54 tok " + "─".repeat(9)); // "thinking" dropped first
	assert.equal(topRule({ ...r, width: 60, hidden: 3 }, head), "── ✻ Crunching… thinking · 18s · ↓ 54 tok " + "─".repeat(18)); // marker would collide → hidden
	assert.equal(headSeg(32, head, P)?.text, " ✻ Crunching… 18s · ↓ 54 tok "); // 2 lead + 29 + 1 dash
	assert.equal(headSeg(31, head, P)?.text, " ✻ Crunching… ↓ 54 tok ");
	assert.equal(headSeg(25, head, P)?.text, " ✻ Crunching… ");
	assert.equal(headSeg(17, head, P)?.text, " ✻ Crunching… ");
	assert.equal(topRule({ ...r, width: 12, hidden: 0 }, head), "─".repeat(12));
	assert.equal(topRule({ ...r, width: 0, hidden: 0 }), "");
});

test("rule escapes are cached per (width, base, bg, mode)", () => {
	const a = K.ruleSeqs(77, K.tabColor(2, true), K.BG, "truecolor");
	assert.equal(K.ruleSeqs(77, K.tabColor(2, true), K.BG, "truecolor"), a);
	assert.notEqual(K.ruleSeqs(77, K.tabColor(2, false), K.BG, "truecolor"), a);
});

test("spinner: labels, easing, head in none mode, done message", () => {
	const run = {} as RunState;
	resetRun(run, "Crunching", 0);
	assert.equal(run.textCols, 10);
	assert.deepEqual(runLabels(run, 900), []);
	run.responseLen = 400;
	easeShown(run);
	assert.equal(run.shownLen, 48); // ceil(400 * 0.12)
	run.requesting = false; run.thinking = true;
	assert.deepEqual(runLabels(run, 18_400).map((l) => l.text), ["thinking", "18s", "↓ 12 tok"]);
	const h = spinnerHead(run, 360, P, false);
	assert.equal(h.glyph + h.verb, "✻Crunching…"); // 360ms / 120ms → glyph 3
	assert.equal(doneMessage("aborted", 3_500, 0), "✻ Interrupted after 3s");
	assert.equal(doneMessage("stop", 74_000, 9000, (a) => a[0]), "✻ Baked for 1m 14s · 9,000 output tokens — Fresh out of the oven.");
});

test("stats: scan, increments only while clean, cache hit, tok/s", () => {
	const s: Stats = { outTotal: 0, lastMsg: undefined, tokPerSec: undefined, dirty: true };
	scanEntries([
		{ type: "message", message: { role: "assistant", usage: { output: 100 } } },
		{ type: "message", message: { role: "assistant", stopReason: "error", usage: { output: 5 } } },
		{ type: "message", message: { role: "toolResult", usage: { output: 7 } } },
		{ type: "compaction", usage: { output: 3 } },
	], s);
	assert.equal(s.outTotal, 115);
	assert.equal(s.lastMsg?.usage?.output, 100);
	addMessage(s, { role: "assistant", usage: { output: 300 } }, 2_000, 1_000);
	assert.equal(s.outTotal, 415);
	assert.equal(s.tokPerSec, 300);
	addMessage(s, { role: "assistant", usage: { output: 300 } }, 1_200, 1_000); // < 0.5s: speed kept
	assert.equal(s.tokPerSec, 300);
	s.dirty = true;
	addMessage(s, { role: "assistant", usage: { output: 1 } }, 0, undefined);
	assert.equal(s.outTotal, 715);
	assert.equal(cacheHit({ usage: { input: 10, cacheRead: 90 } }), 90);
	assert.equal(cacheHit({ usage: { input: 10 } }), undefined);
});

const frame = (o: Partial<FooterInput> = {}): FooterInput => ({
	now: 0, width: 80, cwd: "/x/10.14_Slip", home: "/h", branch: "main", modelId: "claude/claude-sonnet-5-5", thinkingLevel: "low",
	idle: true, contextPercent: 9.1, statuses: new Map(), outTotal: 13_000, lastMsg: { usage: { input: 10, cacheRead: 990 } },
	tokPerSec: 212, running: false, tabColor: K.tabColor(0, true), nerd: false, motion: false, ...o,
});

test("footer segments: spec example and drop order (out → ch → route)", () => {
	const f = frame({ statuses: new Map([["remote-pi:session", "📡 local (1)"], ["remote-pi:relay", "connected"]]) });
	const [l1, l2] = renderLines(f, P).lines;
	const row = (l: string, r: string) => l + " ".repeat(80 - [...l].length - [...r].length) + r;
	assert.equal(l1, row("10.14_Slip ● main", "1 peer · ● relay"));
	assert.equal(l2, row("Sonnet 5.5 · low", "ctx 9.1% · ch 99.0% · out 13k · 212 tok/s"));
	const at = (w: number) => renderLines(frame({ width: w }), P).lines[1].replace(/ {2,}/g, " | ");
	assert.equal(at(56), "Sonnet 5.5 · low | ctx 9.1% · ch 99.0% · 212 tok/s");
	assert.equal(at(44), "Sonnet 5.5 · low | ctx 9.1% · 212 tok/s");
	assert.equal(at(30), " | ctx 9.1% · 212 tok/s"); // route drops whole
});

test("segment registry: claims hide raw statuses; extra segments slot in by order", () => {
	const extra: Segment = { id: "x", line: 2, side: "right", order: 25, prio: 5, render: () => "X" };
	const f = frame({ statuses: new Map([["remote-pi:relay", "ok"], ["foo", "bar"]]), width: 120 });
	const [l1, l2] = renderLines(f, P, buildSegments([extra])).lines;
	assert.ok(l1.endsWith("bar · ● relay"));
	assert.ok(l2.endsWith("out 13k · X · 212 tok/s"));
	assert.equal(renderLines(frame({ statuses: new Map([["remote-pi:relay", "waiting"]]) }), P).live, true);
	assert.equal(renderLines(frame(), P).live, false);
});

test("push status: parser, rendering, claimed key", () => {
	assert.deepEqual(["push: registered", "🔔 push: not registered", "push: disabled", "push: error 410", "Registered", "something"].map((t) => parsePushStatus(t).state),
		["registered", "not-registered", "disabled", "error", "registered", "unknown"]);
	const f = frame();
	assert.equal(renderPush(parsePushStatus("push: registered"), f, P), "● push");
	assert.equal(renderPush(parsePushStatus("push: disabled"), f, P), "○ push");
	assert.equal(renderPush(parsePushStatus("hello"), f, P), "hello");
	assert.equal(renderPush(undefined, f, P), undefined);
	const c = makePainter("truecolor");
	assert.ok(renderPush(parsePushStatus("push: not registered"), f, c)!.startsWith(c.seq("warn")));
	assert.deepEqual(pushSegment().claims, ["remote-pi:push"]);
	const l1 = renderLines(frame({ width: 120, statuses: new Map([["remote-pi:relay", "ok"], ["remote-pi:push", "push: registered"], ["z", "zz"]]) }), P).lines[0];
	assert.ok(l1.endsWith("zz · ● push · ● relay"), l1);
	const narrow = renderLines(frame({ width: 34, statuses: new Map([["remote-pi:relay", "ok"], ["remote-pi:push", "push: registered"]]) }), P).lines[0];
	assert.ok(narrow.endsWith("● relay") && !narrow.includes("push"), narrow); // relay outranks push
});
