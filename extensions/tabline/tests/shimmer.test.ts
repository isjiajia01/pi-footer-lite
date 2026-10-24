import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as K from "../src/color.ts";
import { makePainter } from "../src/paint.ts";
import { headSeg } from "../src/rules.ts";
import { resetRun, spinnerHead } from "../src/spinner.ts";
import { S } from "../src/state.ts";

const bg: K.RGB = [250, 247, 242];
// ANSI-16/default foreground is terminal-defined. Model a readable light terminal;
// assert only SGR 39 is emitted, not a universal contrast guarantee for user palettes.
const defaultFg: K.RGB = [33, 33, 39];
function contrast(a: K.RGB): number {
 const lum = (c: K.RGB) => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
 return (lum(bg) + .05) / (lum(a) + .05);
}
function decode256(n: number): K.RGB {
 if (n >= 232) return [8 + 10 * (n - 232), 8 + 10 * (n - 232), 8 + 10 * (n - 232)];
 assert.ok(n >= 16 && n < 232);
 const cube = [0, 95, 135, 175, 215, 255], x = n - 16;
 return [cube[Math.floor(x / 36)], cube[Math.floor(x / 6) % 6], cube[x % 6]];
}
function minimumContrast(text: string, mode: K.ColorMode): number {
 let rgb = defaultFg, min = Infinity;
 for (const c of text.split(/(\x1b\[[\d;]+m)/)) {
  if (c.startsWith("\x1b[")) {
   if (mode === "16") assert.equal(c, K.RESET_FG, "light ANSI-16 must use terminal foreground");
   if (c.startsWith("\x1b[38;2;")) rgb = c.slice(7, -1).split(";").map(Number) as K.RGB;
   else if (c.startsWith("\x1b[38;5;")) rgb = decode256(Number(c.slice(7, -1)));
   else { assert.equal(c, K.RESET_FG); rgb = defaultFg; }
  } else for (const glyph of c) if (glyph.trim()) min = Math.min(min, contrast(rgb));
 }
 return min;
}
function times(): number[] {
 // Whole 2s cycle at 5ms intervals plus exact highlight peak at each character column.
 return [...Array.from({ length: 401 }, (_, i) => i * 5),
  ...S.run.colStart.map(col => (col + 5) / (S.run.textCols - 1 + 10) * 2000)];
}
afterEach(() => K.applyTheme(K.BG));

for (const mode of ["truecolor", "256", "16"] as const) {
 test(`${mode}: every light spinner glyph, peak, arrow and token label remains readable`, t => {
  K.applyTheme(K.BG);
  const p = makePainter(mode);
  resetRun(S.run, "Crunching", 0);
  S.run.shownLen = 216;
  // Populate the same renderer under dark appearance before switching it live.
  spinnerHead(S.run, 50, p, true);
  K.applyTheme(bg);
  let min = Infinity;
  for (const requesting of [true, false]) for (const thinking of [true, false]) {
   S.run.requesting = requesting; S.run.thinking = thinking;
   for (const now of times()) {
    const head = spinnerHead(S.run, now, p, true);
    const text = headSeg(160, head, p)!.text;
    assert.ok(text.includes(`${requesting ? "↑" : "↓"} 54 tok`));
    min = Math.min(min, minimumContrast(text, mode));
   }
  }
  t.diagnostic(`minimum sampled contrast ${min.toFixed(3)}:1${mode === "16" ? " (configured default foreground fixture)" : ""}`);
  assert.ok(min >= 4.5, `minimum shimmer contrast ${min.toFixed(3)}:1`);
 });
}

test("shimmer dark → light → dark restores every sampled dark frame exactly", () => {
 K.applyTheme(K.BG);
 const p = makePainter("truecolor");
 resetRun(S.run, "Crunching", 0); S.run.shownLen = 216;
 const stamps = times();
 const render = () => stamps.map(now => headSeg(160, spinnerHead(S.run, now, p, true), p)!.text);
 const dark = render();
 K.applyTheme(bg);
 const light = render();
 assert.notDeepEqual(light, dark);
 assert.ok(light.every(text => minimumContrast(text, "truecolor") >= 4.5));
 K.applyTheme(K.BG);
 assert.deepEqual(render(), dark);
});
