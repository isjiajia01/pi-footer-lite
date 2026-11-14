import { scan, parseArgs, type Report } from './tune-scan.ts';
const n = (v: number | undefined) => v !== undefined && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : 'N/A';
const safe = (v: string) => v.replace(/[\x00-\x1f\x7f]/g, '');
export function formatReport(report: Report): string {
 const s = report.stats;
 const lines = [
  'Tabline tuning advisor — cost simulation, not a task-quality benchmark',
  `Generated ${report.generatedAt} · last ${report.days} days · newest ≤${report.sessionLimit} files`,
  `${s.calls} successful calls · ${s.files} files read (${s.nonPiFiles} non-Pi) · ${(s.bytes / 1024 ** 2).toFixed(1)} MiB`,
  `Excluded: ${s.duplicates} duplicate calls, ${s.excludedCalls} old/failed/invalid calls, ${s.skippedFiles} files, ${s.malformed} malformed lines, ${s.oversizedLines} oversized lines, ${s.interrupted} partial/capped files.`,
  '',
  'Costs below are input-equivalent tokens PER MODEL: input=1, cache read=0.1;',
  'output and cache-write weights use local catalog tariffs, including context tiers.',
  'These are estimates, not gateway invoices. Recorded outputs/task paths stay fixed.',
  'Scope: current GLOBAL settings; project/CLI/role overrides are not reconstructed.',
  '',
 ];
 if (!report.results.length) lines.push('No usable Pi assistant usage in this sample. Cheapest settings and savings: N/A.');
 for (const r of report.results) {
  lines.push(safe(r.key), `  Sample: ${r.calls} calls / ${r.sessions} sessions; ${r.calibration} measured compactions / ${r.calibrationSessions} sessions.`);
  lines.push(`  reserveTokens: current ${n(r.reserve)} (trigger >${n(r.current)}).`);
  if (r.evaluable && r.cheapest && r.baseline) {
   lines.push(`  Cheapest simulated: ${n(r.cheapest.reserveTokens)} (trigger >${n(r.cheapest.threshold)}).`,
    `  Weighted tokens: current ${n(r.baseline.weighted)} → cheapest ${n(r.cheapest.weighted)}; saving ${n(r.gain)} (${(100 * r.gain / r.baseline.weighted).toFixed(1)}%).`,
    `  Raw tokens (incl. summaries): ${n(r.baseline.raw)} → ${n(r.cheapest.raw)}; saving ${n(r.baseline.raw - r.cheapest.raw)}.`,
    `  Baseline vs observed cost discrepancy: ${(r.error * 100).toFixed(1)}%.`,
    `  Sensitivity saving (0.5×/1×/1.5×/2× summary/context): ${r.sensitivity.map(s => s.valid ? n(s.saving) : 'invalid').join(' / ')} weighted tokens.`,
    '  Candidate trigger | reserveTokens | weighted tokens | summary calls');
   for (const c of r.rows) lines.push(`  ${n(c.threshold)} | ${n(c.reserveTokens)} | ${c.invalid ? 'invalid' : n(c.weighted)} | ${c.compactions}`);
  } else lines.push('  Cheapest simulated / token saving: N/A (insufficient calibration, samples, or supported pricing/window).');
  lines.push(r.recommend ? '  Recommendation: eligible for manual trial; quality is unmeasured.' : `  Recommendation withheld: ${r.reasons.join('; ')}.`);
  lines.push(`  Thinking: current global startup level ${safe(r.currentThinking)}; cheapest observed cohort ${safe(r.cheapestThinking?.level ?? 'N/A')}.`,
   '  Historical cohorts only (different tasks/roles/routes); causal token savings: N/A.');
  for (const c of r.cohorts) lines.push(`    ${safe(c.level)}: ${c.calls} calls / ${c.sessions} sessions, mean ${n(c.mean)} weighted tokens/call.`);
  lines.push('');
 }
 lines.push('Cache retention: current / cheapest / savings = N/A. Pi 1.5.2 has no cacheRetention or promptCache settings.json key.',
  'Role thinking: not inferred from model IDs or session paths; no role-setting recommendation.', '',
  'settings.json merge snippet (only robust compaction winners; {} means no justified change):',
  JSON.stringify(report.snippet, null, 2), '',
  'Merge only these leaf keys into your existing settings. This advisor never applies them.',
  'Calibration: measured post-compaction context and summary usage; one cold prefix rewrite;',
  'observed steady cache fractions; zero inferred growth across actual compaction boundaries.',
  'Resets on branches, model/route switches, context decreases, corrupt or excluded records.',
  'Eligibility: ≥30 calls/3 sessions, ≥3 compactions/2 sessions, baseline error ≤25%,',
  'and ≥10% saving across 0.5×–2× summary/context assumptions. This is sensitivity, not a confidence interval.',
  ...report.warnings.map(w => `Sample limit: ${w}`), '',
  `On-demand scan: ${report.performance.wallMs.toFixed(0)} ms wall, ${report.performance.cpuMs.toFixed(0)} ms CPU; process RSS ${report.performance.rssMiB.toFixed(1)} MiB (includes host).`,
  'No network, LLM calls, or settings writes; /tune adds no hooks or timers (the biweekly automatic check does). Close this viewer to return.');
 return lines.join('\n');
}
/** Lazy command module. The editor is just a scrollable/copyable viewer: its return
 * value is ignored, so it never submits text or adds a report to model context. */
export async function runTune(args: string, ctx: any): Promise<void> {
 try {
  const options = parseArgs(args);
  if (ctx.isIdle && !ctx.isIdle()) { ctx.ui.notify('Run /tune when the agent is idle.', 'info'); return; }
  const report = await scan(options), text = formatReport(report);
  if (ctx.hasUI && typeof ctx.ui.editor === 'function') await ctx.ui.editor('Tuning advisor · copy snippet; close to return', text);
  else if (ctx.mode === 'rpc') ctx.ui.notify(text, 'info');
  else process.stdout.write(text + '\n');
 } catch (error) {
  // scan() errors are sanitized; never print source file contents.
  ctx.ui.notify(error instanceof Error ? error.message : 'Tuning scan failed.', 'error');
 }
}
