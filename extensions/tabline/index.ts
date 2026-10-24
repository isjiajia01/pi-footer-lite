/**
 * tabline — one extension for pi's editor rules, working spinner and status bar.
 *
 *   ── ✻ Crunching… 18s · ↓ 54 tok ───────────────   top rule (spinner embedded)
 *   ▏ input
 *   ─────────────────────────────────────────────   bottom rule
 *   10.14_Slip ●  main                 1 peer · ● relay
 *   Sonnet 5.5 · low  ctx 9.1% · ch 98.8% · out 13k · 212 tok/s
 *
 * This file only wires pi events to the modules in src/ (see DESIGN.md for the map).
 * Cost model: no timers while idle; exactly one while the agent runs; short-lived ones for
 * the 140ms focus fade and a pulsing dot. Rule strings are cached per (width, color, bg).
 * Off switch: /tabline off. Uninstall: delete the directory + /reload.
 * Shimmer derived from pi-claude-shimmer (MIT, ouzhenkun — see LICENSE).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pulse } from "./src/animate.ts";
import { attachBorders, detachBorders, tabEditorFactory } from "./src/editor.ts";
import { footerFactory } from "./src/footer.ts";
import { paint } from "./src/paint.ts";
import { doneMessage, onStreamEvent, startRun, stopRun } from "./src/spinner.ts";
import { redraw, S } from "./src/state.ts";
import { addMessage, type Msg } from "./src/stats.ts";
import { resolveTab, unregisterTab } from "./src/tab.ts";
import { startFocusReporting, stopFocusReporting } from "./src/terminal.ts";

export default function tabline(pi: ExtensionAPI) {
	/** The editor factory we installed (only when no other extension owned the editor). */
	let ownFactory: unknown;
	// Scope the process listener to an installed TUI session; /reload otherwise
	// accumulates old closures (one per extension load) until process exit.
	const exitCleanup = () => unregisterTab();

	const detach = (ctx?: any) => {
		stopFocusReporting();
		pulse(false);
		detachBorders();
		if (ctx && ownFactory && ctx.ui.getEditorComponent?.() === ownFactory) ctx.ui.setEditorComponent(undefined);
		if (ctx) ownFactory = undefined;
	};

	const install = (ctx: any) => {
		if (ctx.mode && ctx.mode !== "tui") return;
		process.removeListener("exit", exitCleanup);
		process.once("exit", exitCleanup);
		detach();
		S.stats.dirty = true;
		resolveTab(String(ctx.cwd ?? process.cwd()));
		ctx.ui.setFooter(footerFactory(ctx));
		if (!ctx.ui.getEditorComponent?.()) {
			ownFactory = tabEditorFactory;
			ctx.ui.setEditorComponent(tabEditorFactory);
		}
		attachBorders();
		startFocusReporting(ctx.ui);
	};

	// ─── session lifecycle ───────────────────────────────────────────
	pi.on("session_start", (_e, ctx) => {
		if (S.enabled) install(ctx);
		S.stats.dirty = true;
	});
	pi.on("session_shutdown", (_e, ctx: any) => {
		stopRun();
		detach(ctx);
		unregisterTab();
		process.removeListener("exit", exitCleanup);
		S.tab.key = "";
		S.tui = undefined;
	});
	const markDirty = () => { S.stats.dirty = true; };
	pi.on("session_tree" as any, markDirty);
	pi.on("session_compact" as any, markDirty);
	for (const ev of ["session_info_changed", "model_select", "thinking_level_select"]) pi.on(ev as any, redraw);

	// ─── agent run → spinner + stats ─────────────────────────────────
	const beginRun = (_e: unknown, ctx: any) => {
		if (S.enabled && ctx.mode === "tui" && attachBorders() && !S.run.active) startRun(ctx.ui);
	};
	pi.on("agent_start", beginRun);
	pi.on("turn_start", beginRun);
	pi.on("message_start", () => { S.streamStart = undefined; });
	pi.on("message_update", (event: any) => {
		S.streamStart ??= Date.now();
		if (S.run.active) onStreamEvent(S.run, event.assistantMessageEvent);
	});
	pi.on("message_end", (e: any) => {
		const m = e?.message as Msg | undefined;
		if (m?.role === "assistant") {
			S.run.out += m.usage?.output ?? 0;
			addMessage(S.stats, m, Date.now(), S.streamStart);
			S.streamStart = undefined;
		} else if (m?.role === "toolResult") addMessage(S.stats, m, Date.now(), undefined);
		redraw();
	});
	pi.on("agent_end", (event: any, ctx: any) => {
		S.stats.dirty = true;
		if (!S.run.active) { redraw(); return; }
		const elapsed = Date.now() - S.run.start;
		const outTokens = S.run.out;
		stopRun();
		redraw();
		const last = [...(event?.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
		ctx.ui?.notify?.(paint.tone("label", doneMessage(last?.stopReason, elapsed, outTokens)), "info");
	});

	// ─── /tabline on|off ─────────────────────────────────────────────
	pi.registerCommand("tabline", {
		description: "tabline: on | off",
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim();
			if (a === "off") {
				S.enabled = false;
				stopRun();
				detach(ctx);
				ctx.ui.setFooter(undefined);
			} else if (a === "on") {
				S.enabled = true;
				install(ctx);
			}
			ctx.ui.notify(`tabline: ${S.enabled ? "on" : "off"}`, "info");
		},
	});
}
