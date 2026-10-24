/**
 * Editor integration. Two paths, same rendering:
 *   1. No other extension owns the editor → we install TabEditor (a CustomEditor).
 *   2. Another extension's editor is mounted → we decorate its renderTop/BottomBorder in
 *      place and restore the original descriptors on detach (never re-run its factory).
 * Fallbacks: tabline off → pi's border; idle with another extension's embedded working
 * status indicator → that indicator's border.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { paint } from "./paint.ts";
import { bottomRule, topRule, type RuleInput } from "./rules.ts";
import { spinnerHead } from "./spinner.ts";
import { redraw, S, tabColor } from "./state.ts";

const ruleInput = (width: number, hidden: number): RuleInput => ({ width, hidden, base: tabColor(), bg: S.bg, p: paint });

export function renderTop(width: number, hidden: number, fallback: () => string, indicator?: unknown): string {
	if (!S.enabled) return fallback();
	if (!S.run.active && indicator && width > 0) return fallback();
	return topRule(ruleInput(width, hidden), S.run.active ? spinnerHead(S.run, Date.now()) : undefined);
}

export function renderBottom(width: number, hidden: number, fallback: () => string): string {
	return S.enabled ? bottomRule(ruleInput(width, hidden)) : fallback();
}

export class TabEditor extends CustomEditor {
	constructor(tui: any, theme: any, keybindings: any) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
	}
	override renderTopBorder(width: number, hiddenLineCount: number): string {
		return renderTop(width, hiddenLineCount, () => super.renderTopBorder(width, hiddenLineCount), (this as any).workingStatusIndicator);
	}
	override renderBottomBorder(width: number, hiddenLineCount: number): string {
		return renderBottom(width, hiddenLineCount, () => super.renderBottomBorder(width, hiddenLineCount));
	}
}

export const tabEditorFactory = (tui: any, theme: any, kb: any) => { S.tui = tui; return new TabEditor(tui, theme, kb); };

/**
 * The mounted main editor, found by duck typing (jiti module boundaries break instanceof
 * across extensions). Exactly one match or nothing: factories can be stateful (supi's later
 * calls create embedded, suggestion-less editors), so we never call them.
 */
export function mountedEditor(tui: any): any | undefined {
	const found: any[] = [];
	const visit = (node: any) => {
		if (node?.actionHandlers instanceof Map && typeof node.renderTopBorder === "function" && typeof node.renderBottomBorder === "function") found.push(node);
		else if (Array.isArray(node?.children)) node.children.forEach(visit);
	};
	visit(tui);
	return found.length === 1 ? found[0] : undefined;
}

let decorated: any;
let restore: (() => void) | undefined;

/** Make sure the mounted editor draws our rules. Returns false when no editor is mounted yet. Cheap when already attached. */
export function attachBorders(): boolean {
	const editor = mountedEditor(S.tui);
	if (editor && editor === decorated) return true;
	detachBorders();
	if (!editor || editor instanceof TabEditor) return !!editor;
	const top = editor.renderTopBorder, bottom = editor.renderBottomBorder;
	const topDesc = Object.getOwnPropertyDescriptor(editor, "renderTopBorder");
	const bottomDesc = Object.getOwnPropertyDescriptor(editor, "renderBottomBorder");
	const patchedTop = (w: number, h: number) => renderTop(w, h, () => top.call(editor, w, h), editor.workingStatusIndicator);
	const patchedBottom = (w: number, h: number) => renderBottom(w, h, () => bottom.call(editor, w, h));
	editor.renderTopBorder = patchedTop;
	editor.renderBottomBorder = patchedBottom;
	decorated = editor;
	restore = () => {
		for (const [key, patched, desc] of [["renderTopBorder", patchedTop, topDesc], ["renderBottomBorder", patchedBottom, bottomDesc]] as const) {
			if (editor[key] !== patched) continue; // someone re-patched after us: leave theirs
			if (desc) Object.defineProperty(editor, key, desc);
			else delete editor[key];
		}
	};
	editor.invalidate?.();
	redraw();
	return true;
}

export function detachBorders(): void {
	restore?.();
	restore = undefined;
	decorated = undefined;
}
