/**
 * footer-lite — single-file replacement footer.
 *
 *   project (branch) • session
 *   main → Sonnet 5.5 • medium                 ctx 4.6% · ch 98.9% · out 8.0k
 *   <extension statuses>                       (only when published)
 *
 * Token totals cover the whole session file, like pi's built-in footer. Speed (tok/s) is left to pi-speedometer.
 * Off switch: /footerlite off. Remove this directory + /reload to uninstall.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Msg = {
	role?: string;
	model?: string;
	responseModel?: string;
	stopReason?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};

const k = (n: number) => (n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : `${(n / 1e6).toFixed(1)}M`);

/** `claude/claude-sonnet-5-5` → `Sonnet 5.5`. */
function pretty(id: string): string {
	const parts = id.slice(id.lastIndexOf("/") + 1).replace(/^claude-/, "").split("-").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (/^\d+$/.test(p) && /^\d+$/.test(parts[i + 1] ?? "")) out.push(`${p}.${parts[++i]}`);
		else if (!/^20\d{6}$/.test(p)) out.push(p[0].toUpperCase() + p.slice(1));
	}
	return out.join(" ") || id;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let unsubs: (() => void)[] = [];
	// Same scope as pi's own ↓: every entry in the session file (all branches, usage/compaction/summary entries).
	// Updated on message_end; rescanned once per turn (agent_end) and after tree/compact changes.
	let outTotal = 0;
	let last: Msg | undefined;
	let dirty = true;
	const ok = (m: Msg) => m.stopReason !== "error" && m.stopReason !== "aborted";
	const rescan = (ctx: any) => {
		outTotal = 0;
		last = undefined;
		for (const e of ctx.sessionManager.getEntries() as any[]) {
			if (e?.type === "message") {
				const m = e.message as Msg;
				if (m?.role === "assistant") {
					outTotal += m.usage?.output ?? 0;
					if (ok(m)) last = m;
				} else if (m?.role === "toolResult") outTotal += m.usage?.output ?? 0;
			} else if (e?.type === "usage" || e?.type === "compaction" || e?.type === "branch_summary") {
				outTotal += e.usage?.output ?? 0;
			}
		}
		dirty = false;
	};

	const uninstall = (ctx: any) => {
		unsubs.forEach((u) => u());
		unsubs = [];
		ctx.ui.setFooter(undefined);
	};

	const install = (ctx: any) => {
		if (ctx.mode && ctx.mode !== "tui") return;
		unsubs.forEach((u) => u());
		unsubs = [];
		dirty = true;
		ctx.ui.setFooter((tui: any, theme: any, data: any) => {
			const dim = (s: string) => theme.fg("dim", s);
			unsubs.push(data.onBranchChange(() => tui.requestRender()));
			for (const ev of ["agent_end", "session_info_changed", "model_select", "thinking_level_select"])
				unsubs.push(pi.on(ev as any, () => tui.requestRender()));
			unsubs.push(
				pi.on("message_end", (e: any) => {
					const m = e?.message as Msg | undefined;
					if (!dirty && m?.role === "assistant") {
						outTotal += m.usage?.output ?? 0;
						if (ok(m)) last = m;
					} else if (!dirty && m?.role === "toolResult") outTotal += m.usage?.output ?? 0;
					tui.requestRender();
				}),
			);
			// Entries can change outside message_end (usage entries, tree, compaction); recount lazily.
			for (const ev of ["session_start", "session_tree", "session_compact", "agent_end"])
				unsubs.push(pi.on(ev as any, () => (dirty = true)));

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

				// line 1: project (branch) • session
				const cwd = String(ctx.cwd ?? "").replace(/\/+$/, "");
				const project = cwd === process.env.HOME ? "~" : cwd.slice(cwd.lastIndexOf("/") + 1);
				const branch = data.getGitBranch();
				const session = ctx.sessionManager.getSessionName();
				const l1 = project + (branch ? theme.fg("accent", ` (${branch})`) : "") + (session ? dim(` • ${session}`) : "");

				// line 2 left: logical model → actual model • thinking
				const id: string | undefined = ctx.model?.id;
				let left = id?.startsWith("group/") ? id.slice(6) : id ? pretty(id) : "no-model";
				const actual = last?.responseModel;
				if (ctx.isIdle() && id?.startsWith("group/") && last?.model === id && actual && actual !== id)
					left += theme.fg("accent", ` → ${pretty(actual)}`);
				if (ctx.thinkingLevel) left += dim(` • ${ctx.thinkingLevel}`);

				// line 2 right: ctx · ch · out
				const pct: number | null | undefined = ctx.getContextUsage()?.percent;
				const pctTone = pct != null && pct > 90 ? "error" : pct != null && pct > 70 ? "warning" : "dim";
				const parts = [theme.fg(pctTone, `ctx ${pct == null ? "?" : pct.toFixed(1)}%`)];
				const u = last?.usage;
				const denom = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
				if (u && denom > 0 && (u.cacheRead || u.cacheWrite))
					parts.push(dim(`ch ${Math.min(100, ((u.cacheRead ?? 0) / denom) * 100).toFixed(1)}%`));
				if (outTotal > 0) parts.push(dim(`out ${k(outTotal)} (session)`));

				// drop right-hand pieces (ch/out first) until it fits next to the model
				let right = parts.join(dim(" · "));
				while (parts.length > 1 && visibleWidth(left) + 2 + visibleWidth(right) > width) {
					parts.pop();
					right = parts.join(dim(" · "));
				}
				const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
				const l2 = visibleWidth(left) + gap + visibleWidth(right) <= width ? left + " ".repeat(gap) + right : left;

				const lines = [l1, l2];
				const status = [...data.getExtensionStatuses().values()]
					.map((s: string) => s.replace(/\s+/g, " ").trim())
					.filter(Boolean)
					.join(" · ");
				if (status) lines.push(dim(status));
				return lines.map((l) => truncateToWidth(l, width));
			}
		});
	};

	pi.on("session_start", (_e, ctx) => {
		if (enabled) install(ctx);
	});
	pi.on("session_shutdown", () => {
		unsubs.forEach((u) => u());
		unsubs = [];
	});

	pi.registerCommand("footerlite", {
		description: "footer-lite: on | off",
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim();
			if (a === "off") {
				enabled = false;
				uninstall(ctx);
			} else if (a === "on") {
				enabled = true;
				install(ctx);
			}
			ctx.ui.notify(`footer-lite: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
