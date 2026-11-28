/** Unit tests for the route segment: virtual models show the physical tier, groups keep the old suffix. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { modelLabel, routeName } from "../src/segments/builtin.ts";

const painter = { tone: (_tone: string, text: string) => text } as any;
const label = (modelId: string, extra: Record<string, unknown> = {}) =>
	modelLabel({ modelId, thinkingLevel: "low", ...extra } as any, painter);

test("router/std labels the tier it routed to", () => {
	assert.equal(label("router/std", { lastMsg: { model: "group/std" } }), "Std"); // umbrella only, no probe yet: no arrow
	assert.equal(label("router/std", { lastMsg: { model: "group/model-gpt-terra" } }), "Std → GPT Terra");
	assert.equal(label("router/std", { lastMsg: { model: "group/model-claude-sonnet" } }), "Std → Sonnet");
	assert.equal(label("router/std"), "Std"); // selected, no response yet
});

test("a live router session is recognised by its provider, not by an id prefix", () => {
	// Pi reports the virtual model as {provider:"router", id:"std"} — no `router/` in the id.
	const live = (extra: Record<string, unknown> = {}) => label("std", { modelProvider: "router", ...extra });
	assert.equal(live({ lastMsg: { model: "group/std" } }), "Std");
	// Cheap tier: the message only names the umbrella, so the probe's served member is shown.
	assert.equal(live({ lastMsg: { model: "group/std" }, routedModel: "deepseek-v4.1-flash" }), "Std → DeepSeek V4.1 Flash");
	assert.equal(live({ lastMsg: { model: "group/model-gpt-terra" }, routedModel: "gpt-6.2-sol" }), "Std → GPT Terra");
	assert.equal(live({ lastMsg: { model: "group/model-gpt-terra" } }), "Std → GPT Terra");
	assert.equal(live({ routedModel: "gpt-6.2-sol" }), "Std → GPT 6.2 Sol");
	assert.equal(live(), "Std");
});

test("physical groups keep the responseModel / probe suffix", () => {
	assert.equal(label("group/std", { lastMsg: { model: "group/std", responseModel: "claude/claude-haiku-5-5" } }), "std → Haiku 5.5");
	assert.equal(label("group/std", { lastMsg: { model: "group/std" }, routedModel: "gemini-4-hydrogen" }), "std → Gemini 4 Hydrogen");
	assert.equal(label("group/model-gpt-terra"), "model-gpt-terra"); // group ids stay verbatim after `group/`
});

test("routeName strips group and model prefixes", () => {
	assert.equal(routeName("group/model-gpt-terra"), "GPT Terra");
	assert.equal(routeName("magpie/group/model-claude-sonnet"), "Sonnet");
	assert.equal(routeName("claude/claude-opus-5-5"), "Opus 5.5");
});

test("routeName keeps vendor casing for bare served ids", () => {
	assert.equal(routeName("deepseek-v4.1-flash"), "DeepSeek V4.1 Flash");
	assert.equal(routeName("minimax-m3"), "MiniMax M3");
	assert.equal(routeName("glm-5.3"), "GLM 5.3");
});
