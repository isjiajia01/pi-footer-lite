# tabline — design

One pi extension that owns three surfaces: the editor's **top rule** (with the working
spinner embedded), the **bottom rule**, and a two-line **footer**.

```
── ✻ Crunching… 18s · ↓ 54 tok ─────────────── ↑ 3 more ──   top rule (spinner while running)
▏ input
──────────────────────────────────────────────────────────   bottom rule (↓ N more when scrolled)
10.14_Slip ●  main                      iPhone · 1 peer · ● push · ● relay
Sonnet 5.5 · low               ctx 9.1% · ch 98.8% · out 13k · 212 tok/s
```

Color rules: each tab (= git project) gets one identity hue that only touches the rules and
the `●` after the project name. Everything else is neutral gray. Brand coral = "agent
working". Green/amber/red = status only. All mixing happens in OKLab (`src/color.ts`).

Off switch: `/tabline off` (and `/tabline on`). Uninstall: delete the directory, then `/reload`.

## Module map

Dependencies point downward only. Pure modules have no state and no I/O, and they are what
the unit tests cover.

| Layer | File | Role |
|---|---|---|
| entry | `index.ts` | Wires pi events to modules. `install` / `detach` / `/tabline`. No rendering. |
| stateful | `src/footer.ts` | `footerFactory(ctx)`: collect a `FooterInput` → `renderLines` (pure) → pulse on/off. |
| stateful | `src/editor.ts` | `TabEditor` (our CustomEditor) or in-place decoration of another extension's editor. `renderTop` / `renderBottom`. |
| stateful | `src/spinner.ts` | Run lifecycle (`startRun` / `stopRun`, the one run timer), stream-event mapping, `spinnerHead` (pure given `now`), `doneMessage`. |
| stateful | `src/animate.ts` | Short-lived timers: 140ms focus fade and an 80ms pulse tick. `pulseColor`. |
| stateful | `src/terminal.ts` | Focus reporting (DECSET 1004) and the one-shot OSC 11 background query. |
| stateful | `src/tab.ts` | Project root → hue index. Per-pid registry in `$TMPDIR/pi-tabline/<pid>` so live tabs avoid each other's hues. |
| store | `src/state.ts` | `S`, the only cross-module mutable state, plus `redraw()` and `tabColor()` (the focus-faded identity color). |
| pure | `src/rules.ts` | `topRule`, `bottomRule`, `headSeg` (spinner label fallbacks), `overflowSeg`. |
| pure | `src/layout.ts` | `layoutLine`: left/right pieces, a gap of at least 2, drop by prio. |
| pure | `src/segments/*` | Footer segments and the data-source contract (see below). |
| pure | `src/stats.ts` | Output total, last message, cache-hit %, tok/s bookkeeping. |
| pure | `src/format.ts` | `kfmt`, `fmtDur`, `prettyModel`, `fmtRate`. |
| pure | `src/paint.ts` | `Painter` (token → escape for a color mode) and `term` (mode, motion, nerd font) from the environment. |
| pure | `src/color.ts` | OKLab math, tokens, tab hues, color-mode detection, cached per-column rule escapes, `composeRule`. |

## Data model

- **`S` (state.ts)**: `enabled`, `tui`, `bg` (terminal background), `tab {key, index, active, dim}`,
  `focusP` (0 = dim … 1 = focused), `stats: Stats`, `streamStart`, `run: RunState`.
- **`RunState`**: `active, verb, text, colStart[], textCols, start, thinking, requesting,
  responseLen, shownLen, out`. `shownLen` eases toward `responseLen` once per frame
  (at least 3 characters or 12% of the gap). Tokens shown ≈ `shownLen / 4`. The arrow is `↑`
  until the first delta arrives, then `↓`.
- **`Stats`**: `outTotal` (assistant + toolResult output plus usage, compaction and
  branch_summary entries, which matches pi's own ↓ total), `lastMsg` (last non-error and
  non-aborted assistant message), `tokPerSec` (last streamed message, only when it took
  0.5s or more), and `dirty`. When `dirty` is set the next footer render runs a full rescan.
  It is set on session start/tree/compact and on agent_end. `message_end` increments only
  while the stats are clean.
- **`FooterInput` (segments/types.ts)**: one immutable frame collected per footer render.
  It holds `now, width, cwd, home, branch, modelId, thinkingLevel, idle, contextPercent,
  statuses` (setStatus map, with whitespace collapsed and empty values removed), plus
  `outTotal, lastMsg, tokPerSec, running, tabColor, nerd, motion`. `footer.collect()` is the
  only reader of pi's `ctx` and footer data.
- **`Segment`**: `{ id, line: 1|2, side, order, prio, join?, claims?, render(f, p), live?(f) }`.
  `render` is pure and returns painted text, `undefined` (hidden), or an array (several
  pieces that drop individually). `claims` lists the setStatus keys a segment owns, so the
  generic `statuses` segment skips them. `live` keeps the 80ms pulse timer alive.
- **`Source<T>`**: `{ read(f): T | undefined; start?(redraw): dispose }`. This is the
  contract for data that does not come from pi. `read` runs inside render and must be O(1),
  synchronous and free of I/O. A source that needs I/O keeps its own cache, refreshes it from
  events (it never polls while idle) and calls `redraw`.

## Render pipeline

Footer: `collect(ctx, data, width)` → each segment `render(f, paint)` → pieces grouped by line →
`layoutLine(pieces, width, sep)` → `truncateToWidth`. A render that throws shows
`tabline: render error (/tabline off)` instead of breaking pi.

Rules: `renderTop` / `renderBottom` (editor.ts) → `topRule` / `bottomRule` (rules.ts) with
`{width, hidden, base: tabColor(), bg: S.bg, p: paint}`. The fallbacks are:
- tabline off → pi's own border;
- idle while another extension's editor shows its embedded working indicator → that border;
- too narrow for the spinner text → a plain rule.

Editor ownership: if no extension has set an editor component, we install `TabEditor`.
Otherwise we find the single mounted editor by duck typing and patch its two border methods
in place. We never re-run another extension's factory, because factories can be stateful.
On detach we restore the original property descriptors, unless someone patched over us
after we attached.

## Layout and drop order

A line puts left pieces flush left and right pieces flush right, with at least 2 spaces between
them. While a line is too wide, the lowest-`prio` piece is dropped. Ties go to the piece
farthest from its own screen edge, and the right side goes first. `PINNED` pieces never drop.
If the pinned pieces alone still don't fit, the line is truncated.

| line | side | order → segment (prio) |
|---|---|---|
| 1 | left | 0 project ● (PINNED) · 10 branch (PINNED, joined by a space) |
| 1 | right | 10 peer-active (10) · 20 peers (20) · 30 other statuses (30) · 35 push (35) · 40 relay (40) |
| 2 | left | 0 route = model · thinking (30). They drop together, as in the pre-redesign footer. |
| 2 | right | 0 ctx (PINNED) · 10 cache (20) · 20 out (10) · 30 tok/s (PINNED) |

Thresholds: ctx turns warn at 60% or more and error at 85% or more. Cache hit turns warn below
50% and error below 20%. tok/s is coral while the agent runs. The relay dot is green when OK,
red on disconnect/offline/error/fail/closed/lost, and pulsing amber on waiting/pair/connect/retry
(OKLab L−0.25, 1200ms sine).

## Cost model (invariants)

- No timers while idle and focused. The footer and rules render only when pi asks.
- While the agent runs there is exactly one `setInterval` (`spinner.ts`): 55ms with motion,
  120ms without. pi's own loader is hidden with `setWorkingIndicator({frames: []})` so its
  timer stops as well.
- Short-lived timers: the focus fade (16ms ticks for 140ms, then it stops itself) and the
  pulse (80ms, only while a segment is `live`). Both are in `animate.ts`, and both are unref'd.
- Rule escapes are cached per (width, base color, bg, mode), up to 48 entries. An idle rule
  costs one join.
- `tab.ts` runs one `git rev-parse` (500ms timeout) per session_start.
- Motion (shimmer, fade, pulse) needs a truecolor TTY, and `NO_MOTION=1` / `REDUCE_MOTION=1`
  turn it off. `NO_COLOR` turns color off.

## How to add a footer segment

1. Write a `Segment`. It can go in `src/segments/builtin.ts` or in a new file under `src/segments/`:
   ```ts
   export const cost: Segment = {
   	id: "cost", line: 2, side: "right", order: 25, prio: 15,
   	render: (f, p) => (f.costUsd ? p.tone("label", "$ ") + p.tone("primary", f.costUsd.toFixed(2)) : undefined),
   };
   ```
2. If it needs new data, add a field to `FooterInput` and fill it in `footer.collect()`. Keep
   `render` free of I/O. For data that pi does not provide, implement `Source<T>`.
3. Register it in `buildSegments()` (`src/segments/index.ts`). Array order does not matter;
   `line`, `side` and `order` decide position, and `prio` decides survival.
4. If it renders a setStatus key itself, list that key in `claims` so the key is not printed
   twice.
5. Add a test in `tests/segments.test.ts` (render with `makePainter("none")`).

`index.ts`, `layout.ts` and `rules.ts` stay untouched.

## Perch push status (hook only, no Perch I/O)

`src/segments/push.ts` renders the `remote-pi:push` setStatus key. The Perch extension sets
self-describing values, so pi's default footer still reads well when tabline is off:

| value | renders |
|---|---|
| `push: registered` (or on/ok/ready) | green `● push` |
| `push: not registered` (or unregistered/no token/missing) | static amber `● push` |
| `push: disabled` (or off) | gray `○ push` |
| `push: error …` (or failed/denied) | red `● push` |
| unset | hidden |
| anything else | shown verbatim in secondary gray |

An in-process alternative is to pass any `Source<PushStatus>` to `pushSegment(source)`.
Today Perch does not set this key, so nothing changes until it does.

## Tests

Run `node --test "tests/*.test.ts"` (Node 23 or later runs `.ts` natively). `@earendil-works/pi-coding-agent`
and `pi-tui` must resolve from the repo. In the staging repo they are gitignored symlinks into
the pi install under `node_modules/`.

- `tests/pure.test.ts` covers format, layout, rules, rule cache, spinner, stats, segments and
  the push parser.
- `tests/load.test.ts` loads `index.ts` through pi's own extension loader (jiti, as on startup
  and `/reload`). It also checks the mock lifecycle: non-tui is a no-op, tui decorates the
  editor, shutdown restores it.
- `tests/golden.test.ts` runs `tests/harness.ts`. The harness uses a mock `ExtensionAPI`, a fixed
  clock and `Math.random`, and fake timers that count live intervals for the cost model. It
  drives about 150 steps per colour mode: footer widths 120→10, Perch statuses, relay
  pulse, thresholds, group routing, home dir, a full run (thinking and streaming, label
  fallbacks, overflow marker), done notices, focus fade, `/tabline off|on` and shutdown. The
  output must match `tests/golden/<mode>.json` byte for byte. Those files were captured from the
  pre-redesign monolith (commit `6233530`). Regeneration steps are in the file header.

Typecheck with `tsc -p .` (TS 5.9, `@types/node`). `tsconfig.json` sets `noEmit` and
`allowImportingTsExtensions`.

### Intentional differences from the monolith

- None in rendered output. The golden files match in all 5 modes.
- `remote-pi:push` used to render verbatim as a generic status. It is now `● push` / `○ push`.
  Perch does not set this key yet.
