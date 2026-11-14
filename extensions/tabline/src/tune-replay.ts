/** Offline scalar replay; no prompts, tokenizer, provider calls, or settings writes. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Rates = Usage & { tiers?: (Usage & { inputTokensAbove: number })[] };
export type Model = { key: string; contextWindow: number; cost?: Rates; thinkingLevelMap?: Record<string, string | null> };
export type Call = { prompt: number; usage: Usage; thinking: string; session: number; reset: boolean; afterCompact: boolean };
export type Calibration = { before: number; after: number; usage: Usage; session: number };
export type Sample = { model: Model; calls: Call[]; compactions: Calibration[] };
export type Settings = {
 compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number; modelOverrides?: Record<string, { reserveTokens?: number; keepRecentTokens?: number }> };
 modelThinkingLevels?: Record<string, string>; defaultThinkingLevel?: string; sessionDir?: string;
};
export const promptTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;
export function usage(value: any): Usage | undefined {
 if (!value || !['input', 'output', 'cacheRead', 'cacheWrite'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)) return;
 const u = { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite };
 return promptTokens(u) > 0 ? u : undefined;
}
export const median = (xs: number[]) => {
 const sorted = [...xs].sort((a, b) => a - b), n = sorted.length;
 return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : 0;
};
/** Input-equivalent tokens, normalized to this model's base input tariff.
 * Owner's requested cache-read weight is 0.1, even if the catalog says otherwise.
 * Write/output multipliers and long-context tiers come from the local catalog.
 */
export function weighted(u: Usage, cost?: Rates): number {
 if (!cost || !(cost.input > 0)) return NaN;
 const size = promptTokens(u);
 const tier = [...(cost.tiers ?? [])].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove).find(t => size > t.inputTokensAbove);
 const r = tier ?? cost;
 return (u.input * r.input + u.cacheRead * r.input * 0.1 + u.cacheWrite * r.cacheWrite + u.output * r.output) / cost.input;
}
export type Simulation = { weighted: number; raw: number; compactions: number; invalid: boolean };
/** Replay observed growth on a fixed task trajectory. Actual compaction drops are
 * bridged with zero growth (the unseen next user/tool delta cannot be recovered).
 * At synthetic compaction: price an empirical summary, shrink to measured post
 * context, and pay one cold prefix rewrite. Subsequent hits use observed steady
 * fractions, since observed post-compaction misses no longer occur at that time.
 */
export function simulate(sample: Sample, threshold: number, factor = 1): Simulation {
 const result: Simulation = { weighted: 0, raw: 0, compactions: 0, invalid: false };
 const post = median(sample.compactions.map(c => c.after)) * factor;
 const summaryRatio = median(sample.compactions.map(c => promptTokens(c.usage) / c.before));
 const output = median(sample.compactions.map(c => c.usage.output)) * factor;
 const summaryRead = median(sample.compactions.map(c => c.usage.cacheRead / promptTokens(c.usage)));
 const summaryWrite = median(sample.compactions.map(c => c.usage.cacheWrite / promptTokens(c.usage)));
 const steady = sample.calls.filter(c => !c.reset && !c.afterCompact);
 const total = steady.reduce((s, c) => s + c.prompt, 0);
 const read = total ? steady.reduce((s, c) => s + c.usage.cacheRead, 0) / total : 0;
 const write = total ? steady.reduce((s, c) => s + c.usage.cacheWrite, 0) / total : 0;
 const hasWrites = sample.calls.some(c => c.usage.cacheWrite > 0);
 const add = (u: Usage) => { result.weighted += weighted(u, sample.model.cost); result.raw += promptTokens(u) + u.output; };
 let context = 0, previous = 0;
 for (const c of sample.calls) {
  let cold = false;
  if (c.reset) context = c.prompt;
  else {
   context += c.afterCompact ? 0 : Math.max(0, c.prompt - previous);
   if (context > threshold) {
    if (!sample.compactions.length || post >= threshold || context > sample.model.contextWindow) { result.invalid = true; return result; }
    const p = context * summaryRatio * factor;
    add({ input: p * Math.max(0, 1 - summaryRead - summaryWrite), cacheRead: p * summaryRead, cacheWrite: p * summaryWrite, output });
    context = Math.min(context, post);
    result.compactions++;
    cold = true;
   }
  }
  if (context > sample.model.contextWindow) result.invalid = true;
  const r = c.reset ? c.usage.cacheRead / c.prompt : cold ? 0 : read;
  const w = c.reset ? c.usage.cacheWrite / c.prompt : cold ? (hasWrites ? 1 : 0) : write;
  add({ input: context * Math.max(0, 1 - r - w), cacheRead: context * r, cacheWrite: context * w, output: c.usage.output });
  previous = c.prompt;
 }
 return result;
}
export function analyze(sample: Sample, settings: Settings) {
 const { model, calls, compactions } = sample;
 const local = settings.compaction?.modelOverrides?.[model.key];
 const reserve = local?.reserveTokens ?? settings.compaction?.reserveTokens ?? 16384;
 const keep = local?.keepRecentTokens ?? settings.compaction?.keepRecentTokens ?? 20000;
 const current = model.contextWindow - reserve;
 const sessions = new Set(calls.map(c => c.session)).size;
 const calibrationSessions = new Set(compactions.map(c => c.session)).size;
 const priceOK = !!model.cost && [model.cost, ...(model.cost.tiers ?? [])].every(r =>
  ['input', 'output', 'cacheWrite'].every(k => typeof r[k as keyof Usage] === 'number' && Number.isFinite(r[k as keyof Usage]) && r[k as keyof Usage] >= 0)) && model.cost.input > 0;
 const observed = priceOK ? calls.reduce((s, c) => s + weighted(c.usage, model.cost), 0) + compactions.reduce((s, c) => s + weighted(c.usage, model.cost), 0) : NaN;
 // Aggregate cache-read share of observed prompt tokens (calls plus measured summaries).
 const promptTotal = calls.reduce((s, c) => s + promptTokens(c.usage), 0) + compactions.reduce((s, c) => s + promptTokens(c.usage), 0);
 const cacheReadTotal = calls.reduce((s, c) => s + c.usage.cacheRead, 0) + compactions.reduce((s, c) => s + c.usage.cacheRead, 0);
 const cacheReadShare = promptTotal > 0 ? cacheReadTotal / promptTotal : 0;
 const candidates = [...new Set([current, 75000, 100000, 150000, 200000, 250000, 350000, 500000])]
  .filter(t => t > keep && t > 0 && t <= model.contextWindow - 16384).sort((a, b) => a - b);
 const rows = candidates.map(threshold => ({ threshold, reserveTokens: model.contextWindow - threshold, ...simulate(sample, threshold) }));
 const baseline = rows.find(r => r.threshold === current);
 const cheapest = rows.filter(r => !r.invalid && Number.isFinite(r.weighted)).sort((a, b) => a.weighted - b.weighted || Math.abs(a.threshold - current) - Math.abs(b.threshold - current))[0];
 const gain = baseline && cheapest ? baseline.weighted - cheapest.weighted : NaN;
 const error = baseline && observed > 0 ? Math.abs(baseline.weighted - observed) / observed : Infinity;
 const sensitivity = [0.5, 1, 1.5, 2].map(factor => {
  const b = simulate(sample, current, factor), c = simulate(sample, cheapest?.threshold ?? current, factor);
  return { factor, saving: b.weighted - c.weighted, fraction: b.weighted > 0 ? (b.weighted - c.weighted) / b.weighted : 0, valid: !b.invalid && !c.invalid };
 });
 const reasons: string[] = [];
 if (settings.compaction?.enabled === false) reasons.push('automatic compaction is disabled');
 if (!priceOK) reasons.push('missing/invalid local input, output or cache-write tariffs');
 if (calls.length < 30 || sessions < 3) reasons.push('need ≥30 calls across ≥3 sessions');
 if (compactions.length < 3 || calibrationSessions < 2) reasons.push('need ≥3 measured compactions across ≥2 sessions');
 if (!baseline || baseline.invalid) reasons.push('current threshold cannot be simulated safely');
 if (error > 0.25) reasons.push('current simulation differs from observed weighted spend by >25%');
 if (!cheapest || cheapest.threshold === current) reasons.push('current setting is cheapest, or no evaluable alternative');
 if (!sensitivity.every(s => s.valid && s.fraction >= 0.1)) reasons.push('saving is not ≥10% across 0.5×–2× summary/context assumptions');
 const currentThinking = settings.modelThinkingLevels?.[model.key] ?? settings.defaultThinkingLevel ?? 'off';
 const cohorts = [...new Set(calls.map(c => c.thinking))].sort().map(level => {
  const xs = calls.filter(c => c.thinking === level);
  return { level, calls: xs.length, sessions: new Set(xs.map(c => c.session)).size, mean: priceOK ? xs.reduce((s, c) => s + weighted(c.usage, model.cost), 0) / xs.length : NaN };
 });
 const cheapestThinking = cohorts.filter(c => c.level !== 'unknown' && c.calls >= 10 && c.sessions >= 2 && Number.isFinite(c.mean)
  && (!model.thinkingLevelMap || model.thinkingLevelMap[c.level] != null)).sort((a, b) => a.mean - b.mean)[0];
 const evaluable = priceOK && calls.length >= 30 && sessions >= 3 && compactions.length >= 3 && calibrationSessions >= 2 && !!baseline && !baseline.invalid;
 return { key: model.key, reserve, current, sessions, calls: calls.length, calibration: compactions.length, calibrationSessions, observed, cacheReadShare,
  evaluable, rows: evaluable ? rows : [], baseline: evaluable ? baseline : undefined, cheapest: evaluable ? cheapest : undefined,
  gain: evaluable ? gain : NaN, error: evaluable ? error : NaN, sensitivity: evaluable ? sensitivity : [],
  reasons, recommend: reasons.length === 0, currentThinking, cohorts, cheapestThinking };
}
