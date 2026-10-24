import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateToWidth } from '@earendil-works/pi-tui';
import * as K from '../src/color.ts';
import { renderLines } from '../src/footer.ts';
import { layoutLine, type Piece } from '../src/layout.ts';
import { makePainter } from '../src/paint.ts';
import { SEGMENTS, type FooterInput } from '../src/segments/index.ts';
import { appearanceProbe } from '../src/appearance.ts';

const drain = () => new Promise<void>(resolve => setImmediate(resolve));
test('focus probe is nonblocking, coalesces a burst, and ignores results after detach', async () => {
 const work: { resolve: (s:string)=>void; reject:(e:Error)=>void }[]=[];
 const applied:string[]=[];
 const probe=appearanceProbe(()=>new Promise((resolve,reject)=>work.push({resolve,reject})),s=>applied.push(s));
 probe.request(); probe.request(); probe.request();
 assert.equal(work.length,1); assert.deepEqual(applied,[]);
 work[0].resolve('old light'); await drain();
 assert.deepEqual(applied,[]); assert.equal(work.length,2);
 work[1].resolve('new dark'); await drain(); assert.deepEqual(applied,['new dark']);
 probe.request(); probe.cancel(); work[2].resolve('detached'); await drain();
 assert.deepEqual(applied,['new dark']);
 probe.request(); work[3].reject(new Error('defaults failed')); await drain();
 assert.deepEqual(applied,['new dark']);
 probe.request(); probe.cancel(); probe.request(); work[4].resolve('old session'); await drain();
 assert.equal(work.length,6); work[5].resolve('new session'); await drain();
 assert.deepEqual(applied,['new dark','new session']);
});

test('fitting footer fast path equals original truncation in every palette/mode and narrow Unicode cases', () => {
 try {
 for(const light of [false,true]) for(const mode of ['truecolor','256','16','none'] as const) {
  K.applyTheme(light?[250,247,242]:K.BG); const p=makePainter(mode);
  for(const width of [0,1,2,3,9,20,40,60,80,120,240]) for(const name of ['Life-OS','项目👩🏽‍💻e\u0301','plain']) {
   const frame:FooterInput={width,now:123456,cwd:'/x/'+name,home:'/h',branch:'feat/测',modelId:'group/std',thinkingLevel:'high',idle:false,contextPercent:9.1,statuses:new Map([['remote-pi:relay','waiting'],['custom','build ✓']]),outTotal:13000,lastMsg:{usage:{input:1,cacheRead:99}},tokPerSec:212,running:true,tabColor:K.tabColor(0,true),nerd:true,motion:true};
   const byLine:Piece[][]=[[],[]];
   for(const seg of SEGMENTS){const r=seg.render(frame,p);for(const text of r===undefined?[]:Array.isArray(r)?r:[r])if(text)byLine[seg.line-1].push({text,side:seg.side,order:seg.order,prio:seg.prio,join:seg.join});}
   const original=byLine.map(pcs=>truncateToWidth(layoutLine(pcs,width,p.sep),width));
   assert.deepEqual(renderLines(frame,p).lines,original,`${light}/${mode}/${width}/${name}`);
  }
 }
 } finally { K.applyTheme(K.BG); }
});

test('cached plain rules preserve exact escapes and key width/mode/gradient changes', () => {
 const reference=(w:number,seq:string[],mode:K.ColorMode)=>{
  let s='',last:string|undefined;
  for(let i=0;i<w;i++){if(seq[i]!==last){s+=seq[i];last=seq[i];}s+='─';}
  return s+(mode==='none'?'':K.RESET_FG);
 };
 for(const mode of ['truecolor','256','16','none'] as const) for(const bg of [K.BG,[250,247,242] as K.RGB]) for(const w of [0,1,40,80,240]) {
  const seq=K.ruleSeqs(w,K.tabColor(0,true),bg,mode);
  assert.equal(K.composeRule(w,seq,mode),reference(w,seq,mode));
  assert.equal(K.composeRule(w,seq,mode),reference(w,seq,mode));
 }
});
