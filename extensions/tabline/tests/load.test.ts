/**
 * Load smoke test through pi's real extension loader (jiti, the same path pi uses on
 * startup and /reload), then a short lifecycle against a mock ctx.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "index.ts");
// isolate the tab registry ($TMPDIR/pi-tabline) from live pi tabs; read at import time
const regTmp = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "tabline-load-"));
process.env.TMPDIR = regTmp;
after(() => fs.rmSync(regTmp, { recursive: true, force: true }));

test("pi's loader loads index.ts and registers /tabline + lifecycle handlers", async () => {
	const pkg = fs.realpathSync(path.join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent"));
	const loader = await import(pathToFileURL(path.join(pkg, "dist", "core", "extensions", "loader.js")).href);
	const r = await loader.loadExtensions([entry], here);
	assert.deepEqual(r.errors, []);
	const ext = r.extensions[0];
	assert.ok(ext.commands.has("tabline"));
	for (const ev of ["session_start", "session_shutdown", "agent_start", "turn_start", "message_update", "message_end", "agent_end"])
		assert.ok(ext.handlers.has(ev), `handler ${ev}`);
});

test("mock ExtensionAPI: non-tui mode is a no-op; tui mode installs footer + rules", async () => {
	const handlers = new Map<string, any[]>();
	const pi: any = { on: (e: string, h: any) => handlers.set(e, [...(handlers.get(e) ?? []), h]), registerCommand() {} };
	const exitListeners = process.listenerCount("exit");
	(await import(pathToFileURL(entry).href)).default(pi);
	assert.equal(process.listenerCount("exit"), exitListeners, "load alone adds no process listener");
	let footer: any;
	const ui: any = { setFooter: (f: any) => { footer = f; }, setEditorComponent() {}, getEditorComponent: () => "foreign", onTerminalInput: () => () => {}, notify() {} };
	const ctx: any = { mode: "print", cwd: "/tmp", ui };
	for (const h of handlers.get("session_start")!) h({}, ctx);
	assert.equal(typeof footer, "undefined");
	ctx.mode = "tui";
	ctx.sessionManager = { getEntries: () => [] };
	ctx.getContextUsage = () => undefined;
	ctx.isIdle = () => true;
	for (const h of handlers.get("session_start")!) h({}, ctx);
	assert.equal(typeof footer, "function");
	assert.equal(process.listenerCount("exit"), exitListeners + 1);
	for (const h of handlers.get("session_start")!) h({}, ctx);
	assert.equal(process.listenerCount("exit"), exitListeners + 1, "session replacement does not accumulate listeners");
	const ed = { actionHandlers: new Map(), renderTopBorder: () => "T", renderBottomBorder: () => "B" };
	const comp = footer({ children: [ed], requestRender() {} }, {}, { getGitBranch: () => undefined, getExtensionStatuses: () => new Map() });
	const lines = comp.render(40);
	assert.equal(lines.length, 2);
	assert.notEqual(ed.renderTopBorder(), "T"); // decorated
	for (const h of handlers.get("session_shutdown")!) h({}, ctx);
	assert.equal(Object.hasOwn(ed, "renderTopBorder") ? ed.renderTopBorder() : "restored", "T");
	assert.equal(process.listenerCount("exit"), exitListeners, "shutdown/reload releases process listener");
});

test("own editor path: TabEditor (real CustomEditor) draws our rules, pi's border when off", async () => {
	const { TabEditor } = await import("../src/editor.ts");
	const { S } = await import("../src/state.ts");
	const tui: any = { requestRender() {}, terminal: { rows: 40, columns: 80 }, children: [] };
	const id = (s: string) => s;
	const theme: any = { borderColor: id, selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id } };
	const e = new TabEditor(tui, theme, { matches: () => false, getKeys: () => [] } as any);
	tui.children.push(e);
	S.tui = tui;
	const on = e.render(40);
	S.enabled = false;
	const off = e.render(40);
	S.enabled = true;
	assert.equal(on.length, off.length);
	assert.notEqual(on[0], off[0]);
	assert.equal(on[0].replace(/\x1b\[[0-9;]*m/g, ""), "─".repeat(40));
});
