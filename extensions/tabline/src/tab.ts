/**
 * Tab identity: same project (git toplevel, case-folded on macOS) → same hue; live tabs
 * avoid each other's hues via a per-pid registry in $TMPDIR/pi-tabline/<pid>
 * ({key, index}). Dead pids are swept on every resolve. Runs once per session_start
 * (one `git rev-parse`, ≤500ms timeout).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as K from "./color.ts";
import { S } from "./state.ts";

const REG_DIR = path.join(os.tmpdir(), "pi-tabline");
const regFile = path.join(REG_DIR, String(process.pid));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

export const unregisterTab = () => { try { fs.unlinkSync(regFile); } catch {} };

export function projectRoot(cwd: string): string {
	let root = cwd;
	try { root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 500, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || cwd; } catch {}
	root = root.replace(/\/+$/, "");
	return process.platform === "darwin" ? root.toLowerCase() : root;
}

/** Hue indices held by other live pi processes. */
function takenIndices(): Map<number, string> {
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
	return taken;
}

export function resolveTab(cwd: string): void {
	const key = projectRoot(cwd);
	if (key === S.tab.key) return;
	const index = K.assignTabIndex(key, takenIndices());
	S.tab = { key, index, active: K.tabColor(index, true), dim: K.tabColor(index, false) };
	try { fs.writeFileSync(regFile, JSON.stringify({ key, index })); } catch {}
}
