# Tabline performance pass (2026-10-24)

Baseline: `1e399c4`. Same Node v26.7.0 machine, headless mocked TUI, five batches per render case.
40 cases cover dark/light × motion/truecolor/256/16/none × 40/80/160/240 columns.
Raw output: `benchmarks/before.json`, `after.json`. Reproduce with
`node --expose-gc tests/benchmark.ts result.json`. The mock surfaces follow `tests/harness.ts`.
These numbers measure Tabline CPU work, not whole-Pi CPU usage or terminal drawing latency.

## Implemented, ranked

| Change | Evidence before → after | Behavior/risk |
|---|---|---|
| Skip unnecessary footer truncation when the painted line fits; cache composed plain rules | Representative full footer + two editor rules at 120 columns: **61.67 → 7.82 µs/frame** (87% less). Estimated temporary allocations **64.7 → 20.6 KB/frame** (68% less). | A cached width check bypasses pi's expensive ANSI/grapheme traversal for fitting lines. Pinned overflow still uses original truncation. Plain-rule cache weakly keys existing bounded escape arrays. Exact strings unchanged. |
| Move focus-in appearance checks off the input thread, coalesce bursts | Old auto check: **13.87 ms blocking per call**. Ten rapid new refresh calls: **2.71 ms total synchronous work**, versus ~139 ms before; one subprocess remains in flight, one trailing refresh maximum per burst. | The OS query still takes ~13–14 ms, now asynchronously. Initial attach deliberately stays synchronous (~14 ms) to avoid a wrong-color first frame. Stale/coalesced/detached responses are suppressed; explicit overrides apply immediately. |
| Scope process exit listener to installed TUI lifecycle | Previously extension load added one retained `exit` closure per reload; now loading adds 0, install owns 1, repeated session start stays 1, shutdown returns to 0. | Does not alter rendering. Abnormal process-exit cleanup remains installed for a running TUI session. Tested listener counts. |

160-column footer + rules + spinner, median µs/frame:

| Mode | Dark before → after | Light before → after |
|---|---:|---:|
| Truecolor, no motion | 122.3 → 9.0 | 123.1 → 9.0 |
| Truecolor + shimmer/pulse | 128.8 → 11.6 | 130.7 → 11.4 |
| 256 | 120.4 → 7.3 | 122.6 → 7.1 |
| 16 | 116.3 → 6.4 | 121.8 → 6.2 |
| No color | 34.0 → 4.9 | 33.7 → 4.8 |

V8 HeapProfiler used 16KiB statistical sampling including objects collected during the sample.
The byte estimates are allocation pressure, **not exact allocation counts**. Retained heap delta
across 5,000 frames was ~1.09MB before / ~0.32MB after, including profiler bookkeeping and cache
warmup; this is not proof of a leak or a steady-state retained-memory budget.

## Audit and changes rejected

- `message_end`: ~0.048 → 0.039 µs in the mock (noise-scale; handler unchanged), O(1) stats update.
  **No `tool_execution_start` handler exists** in this extension; its direct cost is zero.
- Full 10k-entry recount: ~41 µs baseline. It runs after dirty lifecycle events, not every frame.
  Retained unchanged: replacing it with only incremental counters risks incorrect totals after
  tree/compaction/session edits.
- Startup import ~771 → 479 ms in these single process samples, mostly Pi imports/cache effects;
  **no startup speedup claimed**. Mock installation ~21.6 → 20.0 ms. Synchronous first appearance
  and `git rev-parse` remain, each with its existing 500ms bound. Async startup would change
  initial palette/project hue, so not included in this no-visual-change pass.
- `tab.ts` does no per-frame file I/O. Registry sweep/write happens when project identity changes;
  git root detection occurs on install/session start, before the same-key check. No TTL cache
  added: cwd can be reinitialized/moved into a repository. Existing registry has best-effort
  cross-process hue selection, not a lock; changing that is unnecessary for this task.
- Rule escape cache: identical inputs return the same array (existing test); bounded to 48 keys,
  cleared on overflow. Plain rules reuse a WeakMap value attached to that array; theme/background/
  width/color mode changes get another key. Nearest-256 cache is bounded (~513 entries).
- Pi `requestRender` already coalesces requests (`pi-tui/dist/tui.js:658`). Additional debounce
  here would add latency without a meaningful measured benefit. No redraw schedule change.
- No repeating timer when idle **without a live status**. A waiting/reconnecting relay dot can
  keep an 80ms pulse interval alive indefinitely; it is not intrinsically short-lived. Running
  spinner has one 55ms/120ms interval; a pulse and 140ms focus fade can coexist temporarily.
  Merging their clocks would change animation sampling/cadence, so rejected. Existing golden
  harness verifies normal idle/shutdown returns to zero intervals.
- Kept editor-tree traversal on each footer render: it is how a newly replaced foreign editor
  is detected. Caching only the previous editor would silently break supi/other editor ownership.
- No additional full-frame or normalized-status cache: invalidation complexity and mutable
  status maps outweigh remaining ~8µs per representative frame.
- Focus probe uses no polling/TTL. Cancel invalidates an outstanding result rather than killing
  the subprocess; its existing 500ms timeout bounds it. At most one read plus one queued refresh
  exists, and results after shutdown do not redraw.

## Adjacent finding (not changed)

`src/spinner.ts` computes `BRAND_LAB` / `HI_LAB` at module import. Animated truecolor shimmer
therefore still interpolates old dark-palette endpoints after switching to light; non-animated
text uses the corrected Painter. This is a pre-existing appearance defect, outside this pass's
byte-identical requirement. It deserves a separate light-shimmer regression/fix, not a hidden
visual change under a performance claim. Existing contrast tests cover footer/status text,
not every animated shimmer sample.

## Validation and deployment

- 26 Node tests pass: all five original dark goldens byte-identical, light/256 contrast,
  Pi loader and editor paths, async focus coalescing/cancel/error, retained listener lifecycle,
  original-vs-fast-path equality at widths 0–240 including Chinese/emoji/combining text,
  and plain-rule exact escape comparison.
- TypeScript typecheck passed using the existing compiler; no dependencies installed.
- Live code is synchronized only after verifying it still matches baseline `1e399c4`.
- Existing Pi sessions need `/reload`. No live terminal screenshot or long-running RSS/energy
  profile was captured; timings are reproducible microbenchmarks, not a battery-life claim.
