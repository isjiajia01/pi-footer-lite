/** Repeatable headless benchmark using the same mock surfaces as harness.ts.
 * node --expose-gc tests/benchmark.ts [output.json]
 * Heap samples estimate allocation pressure (including collected objects); not exact allocation counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import inspector from 'node:inspector';
import { performance } from 'node:perf_hooks';
import type { RGB } from '../src/color.ts';
const output = process.argv[2];
const oldTmp = process.env.TMPDIR;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabline-bench-'));
process.env.TMPDIR = dir;
process.env.TABLINE_THEME = 'dark';
process.env.COLORTERM = 'truecolor';
const intervals = new Set<unknown>();
const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
(globalThis as any).setInterval = () => { const h = { unref() {} }; intervals.add(h); return h; };
(globalThis as any).clearInterval = (h: unknown) => intervals.delete(h);
const t0 = performance.now();
const { default: extension } = await import('../index.ts');
const loadMs = performance.now() - t0;
const K = await import('../src/color.ts');
const { makePainter } = await import('../src/paint.ts');
const { renderLines } = await import('../src/footer.ts');
const { topRule, bottomRule } = await import('../src/rules.ts');
const { spinnerHead, resetRun } = await import('../src/spinner.ts');
const { systemIsLight, syncTheme, refreshTheme } = await import('../src/terminal.ts');
const { S } = await import('../src/state.ts');
const { scanEntries } = await import('../src/stats.ts');
const handlers = new Map<string, any>();
extension({ on(e: string, h: any) { handlers.set(e, h); }, registerCommand() {} } as any);
const editor = { actionHandlers: new Map(), renderTopBorder: (_w: number, _h: number) => '', renderBottomBorder: (_w: number, _h: number) => '', invalidate() {} };
let footer: any, renders = 0;
const tui = { children: [editor], requestRender() { renders++; } };
const ctx: any = { mode: 'tui', cwd: dir, model: { id: 'claude/claude-sonnet-5-5' }, thinkingLevel: 'low', isIdle: () => false, getContextUsage: () => ({ percent: 9.1 }), sessionManager: { getEntries: () => [] }, ui: { setFooter(f: any) { footer = f?.(tui, {}, { getGitBranch: () => 'main', getExtensionStatuses: () => new Map() }); }, getEditorComponent: () => 'foreign', onTerminalInput: () => () => {}, setWorkingIndicator() {} } };
const start = performance.now();
handlers.get('session_start')({}, ctx);
const installMs = performance.now() - start;
let sink = 0;
const measure = (fn: (i: number) => void, n = 2000) => {
 for (let i=0;i<300;i++) fn(i);
 const samples: number[] = [];
 for(let r=0;r<5;r++) { const t = performance.now(); for(let i=0;i<n;i++) fn(i); samples.push((performance.now()-t)*1000/n); }
 samples.sort((a,b)=>a-b); return { medianUs: samples[2], minUs: samples[0], maxUs: samples[4] };
};
const rows: any[] = [];
for (const light of [false,true]) for (const mode of ['truecolor','256','16','none'] as const) for (const motion of mode === 'truecolor' ? [false,true] : [false]) for (const width of [40,80,160,240]) {
 K.applyTheme(light ? [250,247,242] : K.BG);
 const p = makePainter(mode), base = K.tabColor(0,true), bg: RGB = light ? [250,247,242] : K.BG;
 const frame: any = { width, now: 123456, cwd: '/x/Life-OS', home:'/h', branch:'main', modelId:'group/std', thinkingLevel:'low', idle:false, contextPercent:9.1, statuses:new Map([['remote-pi:relay','waiting'],['remote-pi:peer-active','📱 iPhone'],['remote-pi:session','📡 local (2)']]), outTotal:13000, lastMsg:{ usage:{input:100,cacheRead:900}},tokPerSec:212,running:true,tabColor:base,nerd:true,motion };
 resetRun(S.run,'Crunching',0); S.run.shownLen=40000;
 const rule = { width, hidden:0,base,bg,p };
 const one = (i: number) => { frame.now = 123456+i*55; sink += renderLines(frame,p).lines[0].length + topRule(rule,spinnerHead(S.run,frame.now,p,motion)).length + bottomRule(rule).length; };
 rows.push({ light, mode: motion?'motion':mode, width, ...measure(one) });
}
K.applyTheme(K.BG); resetRun(S.run,'Crunching',Date.now()-2000);
const fullFrame = (i: number) => { S.run.shownLen=i; sink+=footer.render(120)[0].length+editor.renderTopBorder(120,0).length+editor.renderBottomBorder(120,0).length; };
const fullFrameTime = measure(fullFrame);
const assistant={message:{role:'assistant',usage:{output:100,input:100,cacheRead:900}}}; S.stats.dirty=false;
const events = { messageEnd:measure(()=>handlers.get('message_end')(assistant,ctx),50000), toolExecutionStartHandlers:handlers.has('tool_execution_start')?1:0 };
const recount = Array.from({length:10000},()=>({type:'message',message:assistant.message}));
const scan10k = measure(()=>scanEntries(recount,S.stats),200);
const inspectorSession=new inspector.Session(); inspectorSession.connect();
const post=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>inspectorSession.post(method as any,params,(e,r)=>e?reject(e):resolve(r)));
globalThis.gc?.(); const heapBefore=process.memoryUsage().heapUsed;
await post('HeapProfiler.startSampling',{samplingInterval:16384,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
for(let i=0;i<5000;i++) fullFrame(i);
const {profile}=await post('HeapProfiler.stopSampling');
const sampledBytes=(node:any):number=>node.selfSize+node.children.reduce((n:number,c:any)=>n+sampledBytes(c),0);
globalThis.gc?.(); const retainedBytes=process.memoryUsage().heapUsed-heapBefore;
inspectorSession.disconnect();
const overriddenSync=measure(()=>syncTheme(),1000);
delete process.env.TABLINE_THEME;
const probe:number[]=[]; for(let i=0;i<12;i++){ const t=performance.now();systemIsLight();probe.push(performance.now()-t); }
probe.sort((a,b)=>a-b);
const tSync=performance.now(); for(let i=0;i<10;i++) syncTheme(); const autoSyncCallMs=(performance.now()-tSync)/10;
const tFocus=performance.now();for(let i=0;i<10;i++) refreshTheme();const focusBurstCallMs=(performance.now()-tFocus)/10;
handlers.get('session_shutdown')({},ctx);
const result={node:process.version,loadMs,installMs,rows,fullFrameTime,events,scan10k,heap:{sampledBytesPerFrame:sampledBytes(profile.head)/5000,retainedBytes,frames:5000,note:'V8 statistical allocation samples; retained delta includes profiler bookkeeping and cache warmup.'},theme:{systemProbeMedianMs:probe[6],systemProbeMaxMs:probe[11],autoSyncCallMs,focusBurstCallMs,overriddenSync},intervalsAfterShutdown:intervals.size,renders,sink};
if(output) fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n'); else console.log(JSON.stringify(result,null,2));
globalThis.setInterval=realSet;globalThis.clearInterval=realClear;
if(oldTmp===undefined) delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;
fs.rmSync(dir,{recursive:true,force:true});
