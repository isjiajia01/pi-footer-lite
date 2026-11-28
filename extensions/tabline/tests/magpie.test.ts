import assert from "node:assert/strict";
import test from "node:test";
import { parseMagpieUsage, PROBE_COOLDOWN_MS, probeMagpieRoute, stopMagpieProbe } from "../src/magpie.ts";
import { S } from "../src/state.ts";

test("parseMagpieUsage prefers matching session and ignores non-matching req", () => {
	const jsonl = [
		JSON.stringify({ req: "group/std", served: "claude-haiku-5-5", session: "s1" }),
		JSON.stringify({ req: "group/std", served: "gemini-4-hydrogen", session: "s2" }),
		JSON.stringify({ req: "group/other", served: "gpt-6-2-sol", session: "s1" }),
	].join("\n");

	assert.equal(parseMagpieUsage(jsonl, "group/std", "s1"), "claude-haiku-5-5");
	assert.equal(parseMagpieUsage(jsonl, "group/std", "s2"), "gemini-4-hydrogen");
	assert.equal(parseMagpieUsage(jsonl, "group/std"), "gemini-4-hydrogen");
});

test("parseMagpieUsage falls back to the newest row of a virtual model's session", () => {
	const jsonl = [
		JSON.stringify({ req: "group/std", served: "deepseek-v4.1-flash", session: "s1" }),
		JSON.stringify({ req: "group/std", served: "deepseek-v4.1-flash", session: "s2" }),
		JSON.stringify({ req: "group/model-gpt-terra", served: "gpt-6.2-sol", session: "s1" }),
	].join("\n");

	// router/std names no member, so only the session can identify the newest row.
	assert.equal(parseMagpieUsage(jsonl, "router/std", "s1"), "gpt-6.2-sol");
	// Another session's newer row must not be borrowed.
	assert.equal(parseMagpieUsage(jsonl, "router/std", "s3"), undefined);
	// Exact `req` + session still wins over a newer row of the same session.
	assert.equal(parseMagpieUsage(jsonl, "group/std", "s1"), "deepseek-v4.1-flash");
});

test("probeMagpieRoute throttles back-to-back calls and allows force override", async () => {
	stopMagpieProbe();
	const prevEnabled = S.enabled;
	const prevLastMsg = S.stats.lastMsg;
	S.enabled = true;
	S.stats.lastMsg = undefined;

	try {
		let now = 10_000;
		let calls = 0;
		const run: any = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
			calls++;
			cb(null, JSON.stringify({ req: "group/std", served: "gemini-4-hydrogen", session: "s1" }) + "\n");
		};
		const ctx = {
			mode: "tui",
			model: { provider: "magpie", id: "group/std" },
			sessionManager: { getSessionId: () => "s1" },
		};

		await probeMagpieRoute(ctx, { now: () => now, run });
		assert.equal(calls, 1);
		assert.equal(S.routedModel?.model, "gemini-4-hydrogen");

		// Within cooldown (e.g. agent_end right after message_end) -> skipped
		now += PROBE_COOLDOWN_MS - 100;
		await probeMagpieRoute(ctx, { now: () => now, run });
		assert.equal(calls, 1);

		// Force override (e.g. model_select) -> runs immediately
		await probeMagpieRoute(ctx, { force: true, now: () => now, run });
		assert.equal(calls, 2);

		// Past cooldown -> runs again
		now += PROBE_COOLDOWN_MS;
		await probeMagpieRoute(ctx, { now: () => now, run });
		assert.equal(calls, 3);
	} finally {
		stopMagpieProbe();
		S.enabled = prevEnabled;
		S.stats.lastMsg = prevLastMsg;
	}
});

test("probeMagpieRoute resolves each finished answer once, not once per event", async () => {
	stopMagpieProbe();
	const prevEnabled = S.enabled;
	const prevLastMsg = S.stats.lastMsg;
	S.enabled = true;

	try {
		let now = 50_000;
		let calls = 0;
		const run: any = (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
			calls++;
			cb(null, JSON.stringify({ req: "group/std", served: "gemini-4-hydrogen", session: "s1" }) + "\n");
		};
		const ctx = {
			mode: "tui",
			model: { provider: "magpie", id: "group/std" },
			sessionManager: { getSessionId: () => "s1" },
		};
		const answer = { role: "assistant", model: "group/std" };

		S.stats.lastMsg = answer as any;
		await probeMagpieRoute(ctx, { now: () => now, run });
		assert.equal(calls, 1);

		// agent_end for the same answer, even long past the cooldown, spawns nothing.
		now += 10 * PROBE_COOLDOWN_MS;
		await probeMagpieRoute(ctx, { now: () => now, run });
		assert.equal(calls, 1);

		// A forced probe (model_select) still runs for that same answer.
		await probeMagpieRoute(ctx, { force: true, now: () => now, run });
		assert.equal(calls, 2);

		// The next answer is a new lookup once the cooldown has passed.
		now += PROBE_COOLDOWN_MS;
		S.stats.lastMsg = { role: "assistant", model: "router/std" } as any;
		await probeMagpieRoute(ctx, { now: () => now, run });
		assert.equal(calls, 3);
		assert.equal(S.routedModel?.model, "gemini-4-hydrogen");
	} finally {
		stopMagpieProbe();
		S.enabled = prevEnabled;
		S.stats.lastMsg = prevLastMsg;
	}
});

test("a resolved route is only shown for the message it describes", () => {
	const prevLastMsg = S.stats.lastMsg;
	try {
		const first = { role: "assistant", model: "router/std" };
		S.stats.lastMsg = first as any;
		S.routedModel = { req: "router/std", msg: first, model: "gpt-6.2-sol" };
		assert.equal(S.routedModel.msg, S.stats.lastMsg);
		S.stats.lastMsg = { role: "assistant", model: "router/std" } as any;
		assert.notEqual(S.routedModel.msg, S.stats.lastMsg);
	} finally {
		S.stats.lastMsg = prevLastMsg;
	}
});

function routeCtx(calls: { url: string; auth?: string }[], route: unknown) {
	return {
		mode: "tui",
		model: { provider: "router", id: "router/std" },
		sessionManager: { getSessionId: () => "01a21e8c-efa5-7383-8e66-9ab7e76e459d" },
		modelRegistry: {
			getModelsOfType: () => [{ provider: "magpie", id: "group/std", baseUrl: "https://gateway.test/v1/" }],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test" }),
		},
		// Injected through ProbeOptions in the callers below.
		__route: route,
		__calls: calls,
	};
}

const stubFetch = (calls: { url: string; auth?: string }[], body: unknown, ok = true) =>
	(async (url: string, init?: any) => {
		calls.push({ url: String(url), auth: init?.headers?.Authorization });
		return { ok, json: async () => body } as any;
	}) as unknown as typeof fetch;

test("the gateway's own route record answers instead of an SSH round trip", async () => {
	stopMagpieProbe();
	const prevEnabled = S.enabled, prevLastMsg = S.stats.lastMsg;
	S.enabled = true;
	try {
		const calls: { url: string; auth?: string }[] = [];
		let ssh = 0;
		const run: any = () => { ssh++; };
		const ctx = routeCtx(calls, undefined);
		S.stats.lastMsg = { role: "assistant", model: "router/std" } as any;

		await probeMagpieRoute(ctx, {
			now: () => 100_000,
			run,
			fetchImpl: stubFetch(calls, { route: { asked: "router/std", served: "gpt-6.2-sol", effort: "low" }, seq: 7 }),
		});

		assert.equal(ssh, 0, "no subprocess when the gateway answers");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://gateway.test/v1/magpie/route?session=01a21e8c-efa5-7383-8e66-9ab7e76e459d");
		assert.equal(calls[0].auth, "Bearer sk-test");
		assert.equal(S.routedModel?.model, "gpt-6.2-sol");
	} finally {
		stopMagpieProbe();
		S.enabled = prevEnabled;
		S.stats.lastMsg = prevLastMsg;
	}
});

test("an unknown session or a failing gateway falls back to the usage log over SSH", async () => {
	stopMagpieProbe();
	const prevEnabled = S.enabled, prevLastMsg = S.stats.lastMsg;
	S.enabled = true;
	try {
		for (const [label, fetchImpl] of [
			["route is null", stubFetch([], { route: null, seq: 0 })],
			["gateway errors", stubFetch([], {}, false)],
			["fetch throws", (async () => { throw new Error("offline"); }) as unknown as typeof fetch],
		] as const) {
			stopMagpieProbe();
			let ssh = 0;
			const run: any = (_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
				ssh++;
				cb(null, JSON.stringify({ req: "router/std", served: "deepseek-v4.1-flash", session: "01a21e8c-efa5-7383-8e66-9ab7e76e459d" }) + "\n");
			};
			const ctx = routeCtx([], undefined);
			S.stats.lastMsg = { role: "assistant", model: "router/std" } as any;
			S.routedModel = undefined;
			await probeMagpieRoute(ctx, { now: () => 200_000, run, fetchImpl });
			assert.equal(ssh, 1, label);
			assert.equal(S.routedModel?.model, "deepseek-v4.1-flash", label);
		}
	} finally {
		stopMagpieProbe();
		S.enabled = prevEnabled;
		S.stats.lastMsg = prevLastMsg;
	}
});
