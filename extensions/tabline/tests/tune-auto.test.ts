/**
 * Biweekly automatic /tune check: due gating from the state file, the four notify rules,
 * silence by default, skipped contexts, and the real session_start wiring in index.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	INTERVAL_MS, autoCheck, enabled, isDue, notice, reportPath, review, scheduleAutoTune, statePath, summarize,
	type AutoState,
} from "../src/tune-auto.ts";

const DAY = 86400000;
const NOW = Date.parse("2026-01-15T12:00:00.000Z");
// The test runner can itself be a subagent child; the opt-outs are exercised explicitly below.
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.TABLINE_AUTOTUNE;
const stats = {
	entries: 0, discovered: 0, files: 0, bytes: 0, calls: 0, malformed: 0, oversizedLines: 0,
	skippedFiles: 0, duplicates: 0, excludedCalls: 0, interrupted: 0, nonPiFiles: 0,
};
const analyzeResult = (patch: Record<string, any> = {}) => ({
	key: "fixture/test", reserve: 800000, current: 200000, sessions: 3, calls: 120, calibration: 3,
	calibrationSessions: 2, observed: 120000, cacheReadShare: 0.9, evaluable: false, rows: [],
	gain: NaN, error: NaN, sensitivity: [], reasons: ["need ≥30 calls across ≥3 sessions"],
	recommend: false, currentThinking: "low", cohorts: [], ...patch,
});
const fakeReport = (results: any[], snippet: any = {}): any => ({
	generatedAt: new Date(NOW).toISOString(), days: 30, sessionLimit: 100, stats, warnings: [],
	results, snippet, performance: { wallMs: 1, cpuMs: 1, rssMiB: 1 },
});

/** HOME isolates both the state directory and, with PI_CODING_AGENT_DIR, the corpus. */
async function withHome(fn: (home: string) => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "tabline-auto-"));
	const saved = process.env.HOME;
	process.env.HOME = home;
	try { await fn(home); } finally {
		if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
		await rm(home, { recursive: true, force: true });
	}
}
const ctx = (notes: string[] = []) => ({ mode: "tui", ui: { notify: (text: string) => notes.push(text) } });
const seed = async (state: AutoState) => {
	await mkdir(join(statePath(), ".."), { recursive: true });
	await writeFile(statePath(), JSON.stringify(state));
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("due after 14 days, not due before, and an unusable lastRun is due", () => {
	assert.equal(isDue(undefined, NOW), true);
	assert.equal(isDue({ lastRun: new Date(NOW - INTERVAL_MS + DAY).toISOString(), models: {} }, NOW), false);
	assert.equal(isDue({ lastRun: new Date(NOW - INTERVAL_MS).toISOString(), models: {} }, NOW), true);
	assert.equal(isDue({ lastRun: "yesterday", models: {} }, NOW), true);
});

test("summary keeps unknown values unknown instead of reporting zero growth or zero error", () => {
	const state = summarize(fakeReport([
		analyzeResult(),
		analyzeResult({ key: "priced/other", observed: 600, calls: 200, error: 0.02, cacheReadShare: 0.5 }),
	]), NOW);
	assert.equal(state.lastRun, new Date(NOW).toISOString());
	assert.equal(state.models["fixture/test"].mean, 1000);
	assert.equal(state.models["fixture/test"].calls, 120);
	assert.equal(state.models["fixture/test"].compactions, 3);
	assert.equal(state.models["fixture/test"].cacheRead, 0.9);
	assert.equal(JSON.parse(JSON.stringify(state)).models["fixture/test"].discrepancy, null);
	assert.equal(state.models["priced/other"].mean, 3);
	assert.equal(state.models["priced/other"].discrepancy, 0.02);
});

test("notify rules: robust winner, +25% growth on 100+ calls, >5% discrepancy; first run only the winner", () => {
	const model = (patch: Record<string, any> = {}) => summarize(fakeReport([analyzeResult(patch)]), NOW);
	const baseline = model();
	const prior: AutoState = { lastRun: new Date(NOW - INTERVAL_MS).toISOString(), models: { "fixture/test": { mean: 1000, calls: 120, compactions: 1, cacheRead: 0.9, discrepancy: 0.01 } } };
	// (a) a non-empty settings snippet
	assert.equal(review(undefined, baseline, { compaction: { modelOverrides: { "fixture/test": { reserveTokens: 800000 } } } }).length, 1);
	assert.deepEqual(review(undefined, baseline, {}), []);
	// (b) mean weighted tokens/call rose >=25% with at least 100 calls on both sides
	assert.match(review(prior, model({ observed: 120 * 1250 }), {})[0], /weighted tokens\/call up 25%/);
	assert.deepEqual(review(prior, model({ observed: 120 * 1240 }), {}), []);
	assert.deepEqual(review(prior, model({ observed: 120 * 1250, calls: 99 }), {}), [], "current sample too small");
	assert.deepEqual(review({ lastRun: prior.lastRun, models: { "fixture/test": { ...prior.models["fixture/test"], calls: 99 } } }, model(), {}), [], "previous sample too small");
	// (c) baseline-vs-observed discrepancy
	assert.match(review(prior, model({ error: 0.08 }), {})[0], /8% off observed/);
	assert.deepEqual(review(prior, model({ error: 0.05 }), {}), []);
	// a first run is a baseline: anomalies and growth need a previous summary
	assert.deepEqual(review(undefined, model({ error: 0.5, observed: 120 * 500 }), {}), []);
	assert.equal(notice(["a", "b", "c"]), "Tuning: a; b +1 more · run /tune");
});

test("not due: one state read, no scan, no write", () => withHome(async () => {
	const seeded = { lastRun: new Date(NOW - INTERVAL_MS + DAY).toISOString(), models: {} };
	await seed(seeded);
	let scans = 0;
	const notes: string[] = [];
	const result = await autoCheck(ctx(notes), { now: () => NOW, runScan: async () => { scans++; return fakeReport([]); } });
	assert.deepEqual(result, { due: false, notes: [] });
	assert.equal(scans, 0);
	assert.deepEqual(JSON.parse(await readFile(statePath(), "utf8")), seeded, "state is untouched");
	assert.deepEqual(notes, []);
}));

test("due: scans once, writes state and the full report, and stays silent for a quiet baseline", () => withHome(async () => {
	let scans = 0;
	const notes: string[] = [];
	const result = await autoCheck(ctx(notes), { now: () => NOW, runScan: async () => { scans++; return fakeReport([analyzeResult()]); } });
	assert.equal(result.due, true);
	assert.equal(scans, 1);
	assert.deepEqual(notes, [], "a first run with no winner is silent");
	const state = JSON.parse(await readFile(statePath(), "utf8"));
	assert.equal(state.lastRun, new Date(NOW).toISOString());
	assert.equal(state.models["fixture/test"].calls, 120);
	assert.match(await readFile(reportPath(), "utf8"), /Tabline tuning advisor/);
}));

test("each notify rule reaches ui.notify as one line ending in run /tune", () => withHome(async () => {
	const prior: AutoState = { lastRun: new Date(NOW - INTERVAL_MS).toISOString(), models: { "fixture/test": { mean: 1000, calls: 120, compactions: 1, cacheRead: 0.9, discrepancy: 0.01 } } };
	const cases: { scan: () => Promise<any>; match: RegExp; level?: string }[] = [
		{ scan: async () => fakeReport([analyzeResult()], { compaction: { modelOverrides: { "fixture/test": { reserveTokens: 800000 } } } }), match: /suggested compaction change for fixture\/test/ },
		{ scan: async () => fakeReport([analyzeResult({ observed: 120 * 1300 })]), match: /up 30%/ },
		{ scan: async () => fakeReport([analyzeResult({ error: 0.12, sessions: 3, calls: 120 })]), match: /12% off observed/ },
		{ scan: async () => { throw new Error("Cannot read valid configuration: settings.json"); }, match: /check failed: Cannot read valid configuration/, level: "error" },
	];
	for (const c of cases) {
		await seed(prior);
		const notes: string[] = [], levels: string[] = [];
		const result = await autoCheck({ mode: "tui", ui: { notify: (text: string, level = "info") => { notes.push(text); levels.push(level); } } },
			{ now: () => NOW, runScan: c.scan });
		assert.equal(result.due, true);
		assert.equal(notes.length, 1, `one notice per run: ${notes.join(" | ")}`);
		assert.match(notes[0], c.match);
		assert.match(notes[0], / · run \/tune$/);
		assert.equal(levels[0], c.level ?? "info");
		assert.doesNotMatch(notes[0], /\n/);
	}
}));

test("a failing scan keeps the old baseline and records the attempt, so it retries in 14 days", () => withHome(async () => {
	const prior: AutoState = { lastRun: new Date(NOW - INTERVAL_MS).toISOString(), models: { "fixture/test": { mean: 100, calls: 120, compactions: 1, cacheRead: 0.9, discrepancy: 0.01 } } };
	await seed(prior);
	await autoCheck(ctx(), { now: () => NOW, runScan: async () => { throw new Error("Cannot read valid configuration: models.json"); } });
	const state = JSON.parse(await readFile(statePath(), "utf8"));
	assert.equal(state.lastRun, new Date(NOW).toISOString());
	assert.equal(state.models["fixture/test"].mean, 100);
	assert.equal(isDue(state, NOW), false);
}));

test("skipped without a scan: non-TUI, subagent child, env opt-out", () => withHome(async () => {
	const savedChild = process.env.PI_SUBAGENT_CHILD, savedOpt = process.env.TABLINE_AUTOTUNE;
	try {
		let scans = 0;
		const runScan = async () => { scans++; return fakeReport([]); };
		for (const mode of ["print", "rpc", "json"]) scheduleAutoTune({ mode, ui: { notify() {} } }, 0, { runScan });
		process.env.PI_SUBAGENT_CHILD = "1";
		scheduleAutoTune({ mode: "tui", ui: { notify() {} } }, 0, { runScan });
		delete process.env.PI_SUBAGENT_CHILD;
		process.env.TABLINE_AUTOTUNE = "0";
		scheduleAutoTune({ mode: "tui", ui: { notify() {} } }, 0, { runScan });
		assert.equal(enabled({ mode: "tui" }, { PI_SUBAGENT_CHILD: "1" }), false);
		assert.equal(enabled({ mode: "rpc" }, {}), false);
		assert.equal(enabled({ mode: "tui" }, { TABLINE_AUTOTUNE: "0" }), false);
		assert.equal(enabled(undefined, {}), true);
		await wait(50);
		assert.equal(scans, 0);
		await assert.rejects(readFile(statePath(), "utf8"));
	} finally {
		if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = savedChild;
		if (savedOpt === undefined) delete process.env.TABLINE_AUTOTUNE; else process.env.TABLINE_AUTOTUNE = savedOpt;
	}
}));

test("a due schedule runs the scan after the deferral window", () => withHome(async () => {
	const notes: string[] = [];
	scheduleAutoTune(ctx(notes), 0, { now: () => NOW, runScan: async () => fakeReport([analyzeResult()]) });
	await wait(50);
	const state = JSON.parse(await readFile(statePath(), "utf8"));
	assert.equal(state.models["fixture/test"].calls, 120);
	assert.deepEqual(notes, []);
}));

test("index.ts schedules the real check on a TUI session_start and skips other modes", async () => {
	const here = fileURLToPath(new URL(".", import.meta.url));
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, TABLINE_AUTOTUNE: process.env.TABLINE_AUTOTUNE, TMPDIR: process.env.TMPDIR };
	await withHome(async home => {
		const agent = join(home, "agent");
		await mkdir(join(agent, "sessions"), { recursive: true });
		await writeFile(join(agent, "settings.json"), "{}");
		await mkdir(join(home, "tmp"), { recursive: true });
		process.env.TMPDIR = join(home, "tmp");
		process.env.PI_CODING_AGENT_DIR = agent;
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.TABLINE_AUTOTUNE;
		try {
			const handlers = new Map<string, any[]>();
			const pi: any = { on: (ev: string, h: any) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]), registerCommand() {} };
			(await import(pathToFileURL(join(here, "..", "index.ts")).href)).default(pi);
			const ui: any = { setFooter() {}, setEditorComponent() {}, getEditorComponent: () => "foreign", onTerminalInput: () => () => {}, notify() {} };
			const base: any = { cwd: home, ui, sessionManager: { getEntries: () => [] }, getContextUsage: () => undefined, isIdle: () => true };
			for (const h of handlers.get("session_start")!) h({}, { ...base, mode: "print" });
			await wait(50);
			await assert.rejects(readFile(statePath(), "utf8"), "a non-TUI session must not check");
			for (const h of handlers.get("session_start")!) h({}, { ...base, mode: "tui" });
			// the extension defers by STARTUP_DELAY_MS (1500ms) before importing and scanning
			for (let i = 0; i < 120; i++) {
				try { await readFile(statePath(), "utf8"); break; } catch { await wait(50); }
			}
			const state = JSON.parse(await readFile(statePath(), "utf8"));
			assert.equal(typeof state.lastRun, "string");
			assert.ok(!Number.isNaN(Date.parse(state.lastRun)));
			assert.match(await readFile(reportPath(), "utf8"), /No usable Pi assistant usage/);
			assert.equal(await readFile(join(agent, "settings.json"), "utf8"), "{}", "the check never writes settings");
			for (const h of handlers.get("session_shutdown")!) h({}, base);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k]; else process.env[k] = v;
			}
		}
	});
});
