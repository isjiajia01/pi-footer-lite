import { createReadStream } from 'node:fs';
import { opendir, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { analyze, promptTokens, usage, type Model, type Sample, type Settings } from './tune-replay.ts';

export const LIMITS = { days: 30, sessions: 100, bytes: 128 * 1024 ** 2, fileBytes: 16 * 1024 ** 2, lineBytes: 1024 ** 2, entries: 10000, calls: 25000, ms: 10000 };
export type Options = { days: number; sessions: number; agentDir: string; now?: number; sessionDir?: string };
export function parseArgs(args: string): Options {
 const result: Options = { days: LIMITS.days, sessions: LIMITS.sessions, agentDir: process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent') };
 const words = args.trim() ? args.trim().split(/\s+/) : [];
 for (let i = 0; i < words.length; i += 2) {
  const key = words[i], value = Number(words[i + 1]);
  if (!['--days', '--sessions'].includes(key) || !Number.isInteger(value) || value < 1 || value > (key === '--days' ? 90 : 200))
   throw new Error('Usage: /tune [--days 1..90] [--sessions 1..200]');
  if (key === '--days') result.days = value; else result.sessions = value;
 }
 return result;
}
async function json(path: string, optional = false): Promise<any> {
 try {
  const st = await lstat(path);
  if (!st.isFile() || st.size > 1024 ** 2) throw new Error('Expected a regular configuration file under 1 MiB');
  return JSON.parse(await readFile(path, 'utf8'));
 } catch (e: any) {
  if (optional && e.code === 'ENOENT') return {};
  // Do not expose raw JSON/parse errors: models.json may contain credentials.
  throw new Error(`Cannot read valid configuration: ${path.endsWith('models.json') ? 'models.json' : 'settings.json'}`);
 }
}
function modelsFrom(raw: any): Map<string, Model> {
 const models = new Map<string, Model>();
 for (const [provider, definition] of Object.entries(raw.providers ?? {}) as [string, any][]) {
  for (const base of Array.isArray(definition.models) ? definition.models : []) {
   const m = { ...base, ...definition.modelOverrides?.[base.id] };
   if (typeof m.id !== 'string' || !(m.contextWindow > 0)) continue;
   const key = `${provider}/${m.id}`;
   // Deliberately keep only public model metadata; never return URLs or auth.
   models.set(key, { key, contextWindow: m.contextWindow, cost: m.cost, thinkingLevelMap: m.thinkingLevelMap });
  }
 }
 return models;
}
export async function scan(options: Options) {
 const start = performance.now(), cpuStart = process.cpuUsage();
 const now = options.now ?? Date.now(), cutoff = now - options.days * 86400000;
 const settings: Settings = await json(join(options.agentDir, 'settings.json'));
 const models = modelsFrom(await json(join(options.agentDir, 'models.json'), true));
 const configured = options.sessionDir ?? process.env.PI_SESSION_DIR ?? settings.sessionDir;
 const root = configured ? resolve(configured.replace(/^~(?=\/|$)/, homedir())) : join(options.agentDir, 'sessions');
 const stats = { entries: 0, discovered: 0, files: 0, bytes: 0, calls: 0, malformed: 0, oversizedLines: 0, skippedFiles: 0, duplicates: 0, excludedCalls: 0, interrupted: 0, nonPiFiles: 0 };
 const warnings = new Set<string>();
 const expired = () => performance.now() - start >= LIMITS.ms;
 const files: { path: string; mtime: number; size: number }[] = [];
 async function discover(dir: string, depth: number): Promise<void> {
  if (depth > 6) { warnings.add('Directory depth cap reached.'); return; }
  let directory;
  try { directory = await opendir(dir); } catch { warnings.add('A session directory was unavailable.'); return; }
  for await (const entry of directory) {
   if (++stats.entries > LIMITS.entries || expired()) { warnings.add('Discovery cap reached; newest selection is partial.'); return; }
   if (entry.isSymbolicLink()) continue;
   const path = join(dir, entry.name);
   if (entry.isDirectory()) await discover(path, depth + 1);
   else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
    try {
     const st = await lstat(path);
     if (st.isFile() && st.mtimeMs >= cutoff) { stats.discovered++; files.push({ path, mtime: st.mtimeMs, size: st.size }); }
    } catch { stats.skippedFiles++; }
   }
  }
 }
 await discover(root, 0);
 files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
 if (files.length > options.sessions) warnings.add(`Selected newest ${options.sessions} files by modification time; older files excluded.`);
 const samples = new Map<string, Sample>(), seen = new Set<string>();
 let session = 0;
 for (const file of files.slice(0, options.sessions)) {
  if (expired() || stats.calls >= LIMITS.calls || stats.bytes >= LIMITS.bytes) { warnings.add('Scan time/call/byte cap reached.'); break; }
  if (file.size > LIMITS.fileBytes || file.size > LIMITS.bytes - stats.bytes) { stats.skippedFiles++; continue; }
  stats.files++; session++;
  let isPi = false, header = false, previousId: string | undefined, previous: { key: string; prompt: number; route: string } | undefined;
  let thinking = 'unknown', reset = true;
  let pending: { key: string; before: number; usage: NonNullable<ReturnType<typeof usage>> } | undefined;
  const breakChain = () => { reset = true; previous = undefined; pending = undefined; };
  const consume = (line: Buffer) => {
   if (!line.length) return;
   let e: any;
   try { e = JSON.parse(line.toString('utf8')); } catch { stats.malformed++; breakChain(); return; }
   if (!e || typeof e !== 'object') { stats.malformed++; breakChain(); return; }
   if (!header) { header = true; isPi = e.type === 'session'; if (!isPi) stats.nonPiFiles++; }
   if (!isPi) return;
   if (e.type === 'session') return;
   if (previousId && e.parentId !== previousId) { breakChain(); thinking = 'unknown'; }
   previousId = e.id;
   if (e.type === 'thinking_level_change') { thinking = typeof e.thinkingLevel === 'string' ? e.thinkingLevel : 'unknown'; return; }
   if (e.type === 'model_change' || e.type === 'branch_summary' || e.type === 'context_edit') { breakChain(); return; }
   if (e.type === 'compaction') {
    const u = usage(e.usage);
    if (previous && u && e.fromHook !== true && Number.isFinite(e.tokensBefore) && e.tokensBefore > 0)
     pending = { key: previous.key, before: e.tokensBefore, usage: u };
    else breakChain();
    return;
   }
   const m = e.type === 'message' ? e.message : undefined;
   if (m?.role !== 'assistant') return;
   const timestamp = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(e.timestamp);
   const u = usage(m.usage);
   if (!u || !Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now || m.stopReason === 'error' || m.stopReason === 'aborted'
    || typeof m.provider !== 'string' || typeof m.model !== 'string') { stats.excludedCalls++; breakChain(); return; }
   const key = `${m.provider}/${m.model}`;
   const identity = typeof m.responseId === 'string' && m.responseId ? `${m.provider}:${m.responseId}` : `${key}:${timestamp}:${e.id}`;
   if (seen.has(identity)) { stats.duplicates++; breakChain(); return; }
   seen.add(identity);
   const model = models.get(key) ?? { key, contextWindow: 0 };
   let sample = samples.get(key);
   if (!sample) { sample = { model, calls: [], compactions: [] }; samples.set(key, sample); }
   const p = promptTokens(u), route = typeof m.responseModel === 'string' ? m.responseModel : m.model;
   if (previous && (previous.key !== key || previous.route !== route || (!pending && p < previous.prompt))) breakChain();
   const afterCompact = !!pending && pending.key === key && pending.before > p;
   if (afterCompact) sample.compactions.push({ before: pending!.before, after: p, usage: pending!.usage, session });
   // An invalid/unmeasured compaction must never be mistaken for steady growth.
   if (pending && !afterCompact) breakChain();
   sample.calls.push({ prompt: p, usage: u, thinking: typeof m.thinkingLevel === 'string' ? m.thinkingLevel : thinking, session, reset, afterCompact });
   pending = undefined; previous = { key, prompt: p, route }; reset = false; stats.calls++;
  };
  // Bound the line buffer too: readline alone can retain a multi-GB image line.
  let chunks: Buffer[] = [], length = 0, dropping = false;
  const stream = createReadStream(file.path, { highWaterMark: 64 * 1024, start: 0, end: Math.max(0, file.size - 1) });
  try {
   for await (const raw of stream) {
    const chunk = raw as Buffer; stats.bytes += chunk.length;
    let offset = 0;
    while (offset < chunk.length) {
     const end = chunk.indexOf(10, offset), stop = end < 0 ? chunk.length : end;
     const part = chunk.subarray(offset, stop);
     if (!dropping) {
      length += part.length;
      if (length > LIMITS.lineBytes) { chunks = []; dropping = true; stats.oversizedLines++; breakChain(); }
      else chunks.push(part);
     }
     if (end >= 0) {
      if (!dropping) consume(Buffer.concat(chunks, length));
      chunks = []; length = 0; dropping = false;
     }
     offset = stop + 1;
     if ((!isPi && header) || stats.calls >= LIMITS.calls || expired()) break;
    }
    if (!isPi && header) break;
    if (stats.calls >= LIMITS.calls || expired()) { warnings.add('Scan time/call cap reached.'); stats.interrupted++; break; }
   }
   // A final line without newline may be a live partial append: skip it.
   if (isPi && (length || dropping)) stats.interrupted++;
  } catch { stats.skippedFiles++; warnings.add('A session file could not be read completely.'); }
  finally { stream.destroy(); }
 }
 if (stats.skippedFiles) warnings.add('Oversized, over-budget, or unreadable files were skipped.');
 if (stats.malformed || stats.oversizedLines || stats.interrupted) warnings.add('Malformed/oversized/partial records were excluded; affected trajectories reset.');
 const results = [...samples.values()].map(s => analyze(s, settings)).sort((a, b) => b.calls - a.calls);
 const overrides: Record<string, { reserveTokens: number }> = {};
 for (const r of results) if (r.recommend && r.cheapest) overrides[r.key] = { reserveTokens: r.cheapest.reserveTokens };
 const snippet = Object.keys(overrides).length ? { compaction: { modelOverrides: overrides } } : {};
 const cpu = process.cpuUsage(cpuStart);
 return { generatedAt: new Date(now).toISOString(), days: options.days, sessionLimit: options.sessions, stats, warnings: [...warnings], results, snippet,
  performance: { wallMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000, rssMiB: process.memoryUsage().rss / 1024 ** 2 } };
}
export type Report = Awaited<ReturnType<typeof scan>>;
