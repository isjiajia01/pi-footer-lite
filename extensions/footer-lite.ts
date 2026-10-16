/**
 * footer-lite — single-file replacement footer.
 *
 *   project (branch) • session              ⬡ 1 peer · ⇄ relay · ◇ iPhone
 *   main → Sonnet 5.5 • medium                 ctx 4.6% · ch 98.9% · out 8.0k
 *
 * Extension statuses share line 1 with the context, drawn as one glyph per state
 * (remote-pi's texts are recognised and replaced). Total output matches pi's
 * built-in ↓. Off switch: /footerlite off. Remove this file + /reload to uninstall.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Msg = {
	role?: string; model?: string; responseModel?: string; stopReason?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};

const k = (n: number) => (n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : `${(n / 1e6).toFixed(1)}M`);

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

/**
 * Extension statuses → one glyph per state. `prio` is survival on narrow terminals:
 * 3 relay, 2 other extensions, 1 mesh, 0 phone. Unknown texts pass through, dimmed.
 */
function statusItems(theme: any, statuses: Map<string, string>) {
	const out: { text: string; prio: number }[] = [];
	const add = (text: string, prio: number, tone = "dim") => out.push({ text: theme.fg(tone, text), prio });
	for (const [key, raw] of statuses) {
		const t = String(raw).replace(/\s+/g, " ").trim();
		if (!t) continue;
		if (key === "remote-pi:relay") {
			const wait = /waiting|pair/i.test(t);
			add(wait ? "⇄ relay ○" : "⇄ relay", 3, wait ? "warning" : "success");
		} else if (key === "remote-pi:session") {
			// `📡 local (1)` → mesh peers online; the fixed session name is noise
			const m = /^📡\s*(\S+)\s*\((\d+)\)$/.exec(t);
			const n = m ? Number(m[2]) : NaN;
			if (n === 0) continue; // alone on the mesh: nothing worth a slot
			add(m ? `⬡ ${n} peer${n > 1 ? "s" : ""}${m[1] === "local" ? "" : ` ${m[1]}`}` : t, 1, "accent");
		} else if (key === "remote-pi:peer-active") {
			const m = /^📱\s*(.+)$/.exec(t);
			add(`◇ ${m ? m[1] : t}`, 0, "muted");
		} else add(t, 2);
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	// Same scope as pi's own ↓: every entry in the session file (all branches,
	// usage, compaction and branch-summary entries). Updated on message_end,
	// rescanned once per turn (agent_end) and after tree/compaction changes.
	let outTotal = 0;
	let last: Msg | undefined;
	let dirty = true;
	let tokPerSec: number | undefined;
	let streamStart: number | undefined;
	const unsubs: (() => void)[] = [];
	const stop = () => unsubs.splice(0).forEach((u) => u());
	const ok = (m: Msg) => m.stopReason !== "error" && m.stopReason !== "aborted";
	const rescan = (ctx: any) => {
		outTotal = 0;
		last = undefined;
		for (const e of ctx.sessionManager.getEntries() as any[]) {
			const m = e?.type === "message" ? (e.message as Msg) : undefined;
			if (m?.role === "toolResult") outTotal += m.usage?.output ?? 0;
			else if (m?.role === "assistant") { outTotal += m.usage?.output ?? 0; if (ok(m)) last = m; }
			else if (e?.type === "usage" || e?.type === "compaction" || e?.type === "branch_summary") outTotal += e.usage?.output ?? 0;
		}
		dirty = false;
	};

	const install = (ctx: any) => {
		if (ctx.mode && ctx.mode !== "tui") return;
		stop();
		dirty = true;
		ctx.ui.setFooter((tui: any, theme: any, data: any) => {
			const dim = (s: string) => theme.fg("dim", s);
			const watch = (evs: string[], fn: (e: any) => void) => evs.forEach((ev) => unsubs.push(pi.on(ev as any, fn)));
			watch(["agent_end", "session_info_changed", "model_select", "thinking_level_select"], () => tui.requestRender());
			watch(["message_start"], () => { streamStart = undefined; });
			watch(["message_update"], () => { streamStart ??= Date.now(); });
			watch(["message_end"], (e: any) => {
				const m = e?.message as Msg | undefined;
				if (!dirty && m?.role === "assistant") {
					const out = m.usage?.output ?? 0;
					outTotal += out;
					if (ok(m)) last = m;
					if (streamStart !== undefined && out > 0) {
						const secs = (Date.now() - streamStart) / 1000;
						if (secs >= 0.5) tokPerSec = out / secs;
					}
					streamStart = undefined;
				} else if (!dirty && m?.role === "toolResult") outTotal += m.usage?.output ?? 0;
				tui.requestRender();
			});
			// entries can change outside message_end (usage entries, tree, compaction)
			watch(["session_start", "session_tree", "session_compact", "agent_end"], () => (dirty = true));

			return {
				invalidate() {},
				render(width: number): string[] {
					try {
						return renderLines(width);
					} catch {
						return [truncateToWidth("footer-lite: render error (/footerlite off)", width)];
					}
				},
			};
			function renderLines(width: number): string[] {
				if (dirty) rescan(ctx);

				// line 1: project (branch) • session, then statuses on the right
				const cwd = String(ctx.cwd ?? "").replace(/\/+$/, "");
				const project = cwd === process.env.HOME ? "~" : cwd.slice(cwd.lastIndexOf("/") + 1);
				const branch = data.getGitBranch();
				const session = ctx.sessionManager.getSessionName();
				const l1 = project + (branch ? theme.fg("accent", ` (${branch})`) : "") + (session ? dim(` • ${session}`) : "");

				const items = statusItems(theme, data.getExtensionStatuses());
				const joined = () => items.map((s) => s.text).join(dim(" · "));
				let right1 = joined();
				// narrow terminal: drop the least important status first (never the relay)
				while (items.length > 1 && visibleWidth(l1) + 2 + visibleWidth(right1) > width) {
					items.splice(items.reduce((lo, s, i) => (s.prio <= items[lo].prio ? i : lo), 0), 1);
					right1 = joined();
				}
				const gap1 = Math.max(2, width - visibleWidth(l1) - visibleWidth(right1));
				const ln1 = items.length && visibleWidth(l1) + gap1 + visibleWidth(right1) <= width ? l1 + " ".repeat(gap1) + right1 : l1;

				// line 2 left: logical model → actual model • thinking
				const id: string | undefined = ctx.model?.id;
				let left = id?.startsWith("group/") ? id.slice(6) : id ? pretty(id) : "no-model";
				const actual = last?.responseModel;
				if (ctx.isIdle() && id?.startsWith("group/") && last?.model === id && actual && actual !== id)
					left += theme.fg("accent", ` → ${pretty(actual)}`);
				if (ctx.thinkingLevel) left += dim(` • ${ctx.thinkingLevel}`);

				// line 2 right: ctx · ch · out · speed
				const pct = ctx.getContextUsage()?.percent;
				const parts = [theme.fg(pct == null ? "dim" : pct > 90 ? "error" : pct > 70 ? "warning" : "dim", `ctx ${pct == null ? "?" : pct.toFixed(1)}%`)];
				const u = last?.usage;
				const denom = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
				if (u && denom > 0 && (u.cacheRead || u.cacheWrite)) parts.push(dim(`ch ${Math.min(100, ((u.cacheRead ?? 0) / denom) * 100).toFixed(1)}%`));
				if (outTotal > 0) parts.push(dim(`out ${k(outTotal)}`));
				if (tokPerSec !== undefined) parts.push(dim(`${tokPerSec < 100 ? tokPerSec.toFixed(1) : Math.round(tokPerSec)} tok/s`));

				// drop right-hand pieces (speed, out, ch first) until it fits next to the model
				let right = parts.join(dim(" · "));
				while (parts.length > 1 && visibleWidth(left) + 2 + visibleWidth(right) > width) {
					parts.pop();
					right = parts.join(dim(" · "));
				}
				const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
				const l2 = visibleWidth(left) + gap + visibleWidth(right) <= width ? left + " ".repeat(gap) + right : left;

				return [ln1, l2].map((l) => truncateToWidth(l, width));
			}
		});
	};

	pi.on("session_start", (_e, ctx) => {
		if (enabled) install(ctx);
	});
	pi.on("session_shutdown", stop);

	pi.registerCommand("footerlite", {
		description: "footer-lite: on | off",
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim();
			if (a === "off") {
				enabled = false;
				stop();
				ctx.ui.setFooter(undefined);
			} else if (a === "on") {
				enabled = true;
				install(ctx);
			}
			ctx.ui.notify(`footer-lite: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
