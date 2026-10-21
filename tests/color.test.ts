// Run: node tests/color.test.ts  (spec sample values; exits 1 on failure)
import * as c from "../extensions/tabline/color.ts";
let failed = 0;
const eq = (n: string, a: any, b: any) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) failed++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : `${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const H = c.toHex;
eq("periwinkle", H(c.oklchToSrgb(0.72,0.09,275)), "#94A0DD");
eq("teal dim", H(c.oklchToSrgb(0.40,0.04,190)), "#2D4F4C");
eq("brand", H(c.oklchToSrgb(0.74,0.12,45)), "#E99169");
eq("mix", H(c.mixOklab([0x94,0xA0,0xDD],[0x13,0x13,0x19],0.82)), "#272937");
eq("hues", c.validateHues(c.TAB_HUES), []);
eq("warn", c.validateHues([80]).length, 1);
eq("bg", H(c.BG), "#131319");
const t = c.TOKEN; eq("tokens", [t.primary,t.secondary,t.label,t.separator,t.ruleNeutral,t.brandHighlight,t.ok,t.warn,t.error].map(x=>H(x.rgb)), ["#EAEAF3","#8E8E96","#5D5D64","#3C3C43","#2D2D34","#FBC49F","#63D18F","#E9B452","#EF6661"]);
eq("tabs", [0,1,2,3,4,5].map(i=>H(c.tabColor(i,true).rgb)), ["#94A0DD","#58B7B1","#D28DA7","#6EACD7","#A3AC69","#B296D2"]);
eq("tabs dim", [0,1,2,3,4,5].map(i=>H(c.tabColor(i,false).rgb)), ["#41465E","#2D4F4C","#593F49","#344B5B","#474A31","#4D4259"]);
process.exit(failed ? 1 : 0);
