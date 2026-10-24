/**
 * Look-preservation test: tests/harness.ts drives index.ts through fixed scenarios in every
 * colour mode; output must match tests/golden/<mode>.json byte for byte. The golden files were
 * captured from the pre-redesign monolith (commit 6233530). To regenerate from the baseline:
 *   mkdir -p .cmp/old && git show 6233530:index.ts > .cmp/old/index.ts && git show 6233530:color.ts > .cmp/old/color.ts
 *   for m in motion truecolor 256 16 none; do node tests/harness.ts .cmp/old/index.ts $m tests/golden/$m.json; done
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

for (const mode of ["motion", "truecolor", "256", "16", "none"]) {
	test(`golden: ${mode}`, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabline-golden-"));
		const out = path.join(dir, `${mode}.json`);
		execFileSync(process.execPath, [path.join(here, "harness.ts"), path.join(here, "..", "index.ts"), mode, out], { stdio: ["ignore", "ignore", "inherit"] });
		const got = JSON.parse(fs.readFileSync(out, "utf8")) as { step: string; value: unknown }[];
		fs.rmSync(dir, { recursive: true, force: true });
		const want = JSON.parse(fs.readFileSync(path.join(here, "golden", `${mode}.json`), "utf8")) as typeof got;
		assert.deepEqual(got.map((r) => r.step), want.map((r) => r.step));
		for (let i = 0; i < want.length; i++) assert.deepEqual(got[i].value, want[i].value, want[i].step);
	});
}
