/**
 * Biweekly automatic check: one state read on session_start, the full /tune scan only
 * when the last run is 14+ days old, and a one-line notice only for an actionable change
 * or an anomaly. Loaded on demand; never blocks the startup path, writes settings, or
 * calls the network. The full text always lands in last-report.txt.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs, scan, type Report } from "./tune-scan.ts";
import { formatReport } from "./tune.ts";

export const INTERVAL_MS = 14 * 86400000;
/** Deferral past the first frames: the scan must never compete with startup rendering. */
export const STARTUP_DELAY_MS = 1500;
/** Per-model growth comparison needs a real sample on both sides. */
const MIN_CALLS = 100;
/** Baseline-vs-observed simulation error that counts as an anomaly. */
const MAX_DISCREPANCY = 0.05;

export type ModelSummary = {
	/** Input-equivalent weighted tokens per call, including measured summaries. */
	mean: number;
	calls: number;
	compactions: number;
	/** Share of observed prompt tokens served from cache. */
	cacheRead: number;
	/** |simulated − observed| / observed at the current threshold. */
	discrepancy: number;
};
export type AutoState = { lastRun: string; models: Record<string, ModelSummary> };
export type AutoResult = { due: boolean; notes: string[] };
export type AutoDeps = { now?: () => number; runScan?: () => Promise<Report> };

/** All state lives beside the other offline advisor artifacts. Read at call time so a
 * session that never gets here (tests, /tabline off) pays nothing. */
export const statePath = () => join(homedir(), ".cache/agent-runtime/pi-autotune/state.json");
export const reportPath = () => join(homedir(), ".cache/agent-runtime/pi-autotune/last-report.txt");

const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Automatic checks need an interactive session, no subagent child, and no opt-out. */
export function enabled(ctx: { mode?: string } | undefined, env = process.env): boolean {
	return (!ctx?.mode || ctx.mode === "tui") && env.PI_SUBAGENT_CHILD !== "1" && env.TABLINE_AUTOTUNE !== "0";
}

export function isDue(previous: AutoState | undefined, now: number): boolean {
	if (!previous) return true;
	const last = Date.parse(previous.lastRun);
	return !Number.isFinite(last) || now - last >= INTERVAL_MS;
}

/** NaN (serialized as null) marks an unknown value: unpriceable models, unmeasured
 * discrepancy. A later run must not read that as zero growth or a zero error. */
export function summarize(report: Report, now: number): AutoState {
	const models: Record<string, ModelSummary> = {};
	for (const r of report.results) models[r.key] = {
		mean: r.calls > 0 && known(r.observed) ? r.observed / r.calls : NaN,
		calls: r.calls,
		compactions: r.calibration,
		cacheRead: r.cacheReadShare,
		discrepancy: known(r.error) ? r.error : NaN,
	};
	return { lastRun: new Date(now).toISOString(), models };
}

const snippetKeys = (snippet: Report["snippet"]) =>
	Object.keys((snippet as { compaction?: { modelOverrides?: Record<string, unknown> } }).compaction?.modelOverrides ?? {});

/** The reasons that justify interrupting the owner. Silence is the normal outcome.
 * A first run only establishes the baseline: only a robust winner counts as news. */
export function review(previous: AutoState | undefined, next: AutoState, snippet: Report["snippet"]): string[] {
	const notes = snippetKeys(snippet).map(key => `suggested compaction change for ${key}`);
	if (!previous) return notes;
	for (const [key, model] of Object.entries(next.models)) {
		const before = previous.models?.[key];
		if (!known(model.mean) || !known(before?.mean) || before.mean <= 0) continue;
		if (model.calls < MIN_CALLS || before.calls < MIN_CALLS) continue;
		const growth = model.mean / before.mean - 1;
		if (growth >= 0.25) notes.push(`${key} weighted tokens/call up ${Math.round(growth * 100)}%`);
	}
	for (const [key, model] of Object.entries(next.models))
		if (known(model.discrepancy) && model.discrepancy > MAX_DISCREPANCY) notes.push(`${key} simulation is ${Math.round(model.discrepancy * 100)}% off observed`);
	return notes;
}

/** One short line: what happened, and how to see the evidence. */
export function notice(notes: string[]): string {
	const shown = notes.slice(0, 2).join("; ");
	return `Tuning: ${shown}${notes.length > 2 ? ` +${notes.length - 2} more` : ""} · run /tune`;
}

/** An unreadable, malformed, or absent state file means "no baseline": the check runs. */
async function load(): Promise<AutoState | undefined> {
	try {
		const state = JSON.parse(await readFile(statePath(), "utf8"));
		return state && typeof state.lastRun === "string" && state.models && typeof state.models === "object" ? state : undefined;
	} catch { return undefined; }
}

export async function autoCheck(ctx: any, deps: AutoDeps = {}): Promise<AutoResult> {
	const now = deps.now?.() ?? Date.now();
	const previous = await load();
	if (!isDue(previous, now)) return { due: false, notes: [] };
	let state: AutoState, text = "", notes: string[];
	try {
		const report = await (deps.runScan ? deps.runScan() : scan(parseArgs("")));
		text = formatReport(report);
		state = summarize(report, now);
		notes = review(previous, state, report.snippet);
	} catch (error) {
		// Rule (d): the scan or its configuration is unusable. Keep the old baseline and
		// still record the attempt so a broken config cannot notify on every session start.
		state = { lastRun: new Date(now).toISOString(), models: previous?.models ?? {} };
		notes = [`check failed: ${error instanceof Error ? error.message : "unknown error"}`];
	}
	try {
		await mkdir(dirname(statePath()), { recursive: true });
		if (text) await writeFile(reportPath(), `${text}\n`);
		await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		notes.push("state could not be written");
	}
	if (notes.length && typeof ctx?.ui?.notify === "function")
		ctx.ui.notify(notice(notes), notes[0].startsWith("check failed") ? "error" : "info");
	return { due: true, notes };
}

/** Fire-and-forget: unref'd one-shot timer, never awaited by the session_start handler.
 * One check at a time per process; a repeated session_start reads the fresh state instead. */
let running = false;
export function scheduleAutoTune(ctx: any, delayMs = STARTUP_DELAY_MS, deps: AutoDeps = {}): void {
	if (!enabled(ctx) || running) return;
	running = true;
	const timer = setTimeout(() => {
		void autoCheck(ctx, deps).catch(() => {}).finally(() => { running = false; });
	}, delayMs);
	timer.unref?.();
}
