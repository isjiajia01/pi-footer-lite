import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weighted, simulate, analyze, usage, type Sample, type Usage } from '../src/tune-replay.ts';
import { scan, parseArgs, LIMITS } from '../src/tune-scan.ts';
import { formatReport, runTune } from '../src/tune.ts';

const u = (input: number, cacheRead = 0, output = 0, cacheWrite = 0): Usage => ({ input, cacheRead, output, cacheWrite });
const cost = u(2, 0.01, 10, 4); // read tariff deliberately differs from owner's 0.1 weight
const model = { key: 'fixture/test', contextWindow: 1000000, cost };
test('billing weights read once at 0.1; output and write use vendor multipliers, tiers use full prompt', () => {
 assert.equal(weighted(u(100, 1000, 10, 20), cost), 290); // 100 + 100 + 50 + 40
 assert.equal(weighted(u(100, 1000, 10, 20), { ...cost, tiers: [{ ...u(4, 0.1, 20, 8), inputTokensAbove: 1000 }] }), 580);
 assert.ok(Number.isNaN(weighted(u(10))));
 assert.equal(usage({ input: -1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
 assert.equal(usage({ input: 1, output: 1 }), undefined, 'absent cache fields are unknown, not a free cache');
});
test('synthetic trajectory hand calculation: summary + cold rewrite are included; strict > trigger', () => {
 const sample: Sample = { model, compactions: [{ before: 100, after: 20, usage: u(50, 0, 4), session: 1 }], calls: [
  { prompt: 80, usage: u(80, 0, 2), thinking: 'low', session: 1, reset: true, afterCompact: false },
  { prompt: 100, usage: u(20, 80, 2), thinking: 'low', session: 1, reset: false, afterCompact: false },
 ] };
 // threshold=100: first=90, second=20+8+10=38 => 128, no compaction at equality
 assert.deepEqual(simulate(sample, 100), { weighted: 128, raw: 184, compactions: 0, invalid: false });
 // threshold=99: first=90; summary=50+4*5=70; cold=20+2*5=30 => 190
 assert.deepEqual(simulate(sample, 99), { weighted: 190, raw: 158, compactions: 1, invalid: false });
 assert.equal(simulate(sample, 10).invalid, true, 'post-compaction context cannot fit');
 assert.equal(analyze(sample, {}).recommend, false, 'small sample cannot emit advice');
});
test('sensitivity changes summary output/context, and absent calibration cannot create a winner', () => {
 const sample: Sample = { model, compactions: [], calls: [{ prompt: 100, usage: u(100), thinking: 'high', session: 1, reset: true, afterCompact: false }] };
 const a = analyze(sample, { compaction: { modelOverrides: { [model.key]: { reserveTokens: 800000 } } } });
 assert.equal(a.current, 200000);
 assert.equal(a.recommend, false);
 assert.ok(a.reasons.some(r => r.includes('measured compactions')));
});

test('a well-calibrated robust winner is recommended; disabled compaction still suppresses it', () => {
 const sample: Sample = { model, calls: [], compactions: [] };
 for (let session = 1; session <= 3; session++) {
  for (let i = 0; i < 60; i++) {
   const prompt = (i % 20 + 1) * 10000, afterCompact = i > 0 && i % 20 === 0;
   sample.calls.push({ prompt, usage: i === 0 || afterCompact ? u(prompt) : u(0, prompt), thinking: 'low', session, reset: i === 0, afterCompact });
   if (afterCompact) sample.compactions.push({ before: 210000, after: 10000, usage: u(21000, 0, 10), session });
  }
 }
 const settings = { compaction: { reserveTokens: 800000 } };
 const result = analyze(sample, settings);
 assert.equal(result.recommend, true, result.reasons.join('; '));
 assert.equal(result.cheapest?.threshold, 75000);
 assert.ok(result.sensitivity.every(s => s.valid && s.fraction >= 0.1));
 assert.equal(analyze(sample, { compaction: { ...settings.compaction, enabled: false } }).recommend, false);
});

async function fixture(fn: (dir: string) => Promise<void>) {
 const dir = await mkdtemp(join(tmpdir(), 'tabline-tune-'));
 try {
  await mkdir(join(dir, 'sessions', 'project'), { recursive: true });
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ compaction: { modelOverrides: { [model.key]: { reserveTokens: 800000 } } }, untouched: 'keep-me' }));
  await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { fixture: { apiKey: 'secret-must-not-appear', models: [{ id: 'test', contextWindow: model.contextWindow, cost }] } } }));
  await fn(dir);
 } finally { await rm(dir, { recursive: true, force: true }); }
}
const now = Date.now();
const assistant = (id: string, parentId: string | null, prompt: number, extra: any = {}) => ({ type: 'message', id, parentId, timestamp: new Date(now - 1000).toISOString(), message: { role: 'assistant', provider: 'fixture', model: 'test', timestamp: now - 1000, thinkingLevel: 'low', stopReason: 'stop', usage: u(prompt, 0, 2), responseId: id, ...extra } });
const header = { type: 'session', id: 's', version: 3 };
const lines = (xs: any[]) => xs.map(x => JSON.stringify(x)).join('\n') + '\n';
test('streams synthetic Pi session, detects compaction, excludes errors and fork duplicates, never writes settings', async () => fixture(async dir => {
 const file = join(dir, 'sessions/project/a.jsonl');
 await writeFile(file, lines([header, assistant('a', null, 100), { type: 'compaction', id: 'b', parentId: 'a', tokensBefore: 100, usage: u(50, 0, 4) }, assistant('c', 'b', 20), assistant('d', 'c', 40, { stopReason: 'error' })]));
 await writeFile(join(dir, 'sessions/project/fork.jsonl'), lines([header, assistant('a', null, 100)]));
 const before = await readFile(join(dir, 'settings.json'), 'utf8');
 const report = await scan({ agentDir: dir, days: 30, sessions: 100, now });
 assert.equal(report.stats.calls, 2);
 assert.equal(report.stats.duplicates, 1);
 assert.equal(report.stats.excludedCalls, 1);
 // The newest fork can consume the first response identity. Use an older fork so
 // the original session supplies the complete calibration in a second run.
 await utimes(join(dir, 'sessions/project/fork.jsonl'), new Date(now - 20000), new Date(now - 20000));
 const ordered = await scan({ agentDir: dir, days: 30, sessions: 100, now });
 assert.equal(ordered.results[0].calibration, 1);
 assert.equal(ordered.results[0].reserve, 800000);
 assert.deepEqual(report.snippet, {});
 assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), before);
 assert.ok(!JSON.stringify(report).includes('secret-must-not-appear'));
 assert.match(formatReport(report), /causal token savings: N\/A/);
}));
test('malformed, huge, partial, non-Pi, old and unsupported model records cannot make recommendations', async () => fixture(async dir => {
 const p = join(dir, 'sessions/project');
 await writeFile(join(p, 'bad.jsonl'), JSON.stringify(header) + '\n{bad}\n' + 'x'.repeat(LIMITS.lineBytes + 1) + '\n' + lines([assistant('ok', null, 100), assistant('old', 'ok', 120, { timestamp: now - 40 * 86400000 }), assistant('missing-model', 'old', 130, { model: 'unknown' })]) + '{"partial":');
 await writeFile(join(p, 'other.jsonl'), lines([{ unrelated: true }, assistant('not-pi', null, 100)]));
 const report = await scan({ agentDir: dir, days: 30, sessions: 100, now });
 assert.equal(report.stats.calls, 2);
 assert.equal(report.stats.malformed, 1);
 assert.equal(report.stats.oversizedLines, 1);
 assert.equal(report.stats.interrupted, 1);
 assert.equal(report.stats.nonPiFiles, 1);
 assert.equal(report.stats.excludedCalls, 1);
 assert.deepEqual(report.snippet, {});
 assert.ok(report.results.every(r => !r.recommend));
}));
test('strict argument limits, empty sample, invalid configuration does not disclose secrets', async () => fixture(async dir => {
 assert.equal(parseArgs('--days 7 --sessions 20').days, 7);
 for (const arg of ['--days', '--days 0', '--sessions 201', '--days 7x', 'apply', '--days 1.5']) assert.throws(() => parseArgs(arg));
 const report = await scan({ agentDir: dir, days: 30, sessions: 100, now });
 assert.match(formatReport(report), /No usable Pi/);
 await writeFile(join(dir, 'models.json'), '{"apiKey":"secret-must-not-appear", broken}');
 await assert.rejects(scan({ agentDir: dir, days: 30, sessions: 100, now }), e => !String(e).includes('secret-must-not-appear'));
}));
test('command refuses active agent before scanning; viewer results cannot send a prompt', async () => {
 const notes: string[] = [];
 await runTune('', { isIdle: () => false, ui: { notify: (s: string) => notes.push(s) } });
 assert.match(notes[0], /idle/);
 await runTune('apply', { ui: { notify: (s: string) => notes.push(s) } });
 assert.match(notes[1], /Usage/);
});
