# Offline tuning advisor

Tabline is the host because it already owns token totals and cache-hit statistics. `/tune` adds an on-demand analysis to those metrics without another extension, request hook, or background process. Its implementation is dynamically imported only when invoked.

After `/reload` (or a fresh Pi process):

```text
/tune
/tune --days 7 --sessions 50
```

The report opens in Pi's copyable, scrollable editor dialog. Closing/saving the dialog discards any edits; it never sends a prompt, persists a transcript message, or applies settings. The report compares current and cheapest **simulated** compaction settings, gives sample sizes, raw/weighted token differences, calibration error, candidate costs, and sensitivity. `{}` is a valid settings snippet when no change is justified. Merge only recommended leaf keys into the existing settings object manually.

For terminal use and reproducible measurement, run the identical scanner without Pi:

```sh
node ~/.pi/agent/extensions/tabline/src/tune-cli.ts
node ~/.pi/agent/extensions/tabline/src/tune-cli.ts --days 7 --sessions 50 --json
/usr/bin/time -l node ~/.pi/agent/extensions/tabline/src/tune-cli.ts
node --test ~/.pi/agent/extensions/tabline/tests/tune.test.ts
```

Node 22.19+ is required, as for the installed Pi. `PI_CODING_AGENT_DIR` is honored; session root resolution is `PI_SESSION_DIR`, global `sessionDir`, then `<agentDir>/sessions`. Relative session paths resolve against process cwd. Scope is current **global** settings, not historical project, CLI, enabled-model suffix, or subagent overrides. Only custom models with context and prices in `models.json` are evaluable; unknown/built-in-only models remain N/A. The CLI additionally accepts `--json`; the slash command does not.

## What can be learned offline

Exact alternative outputs cannot be recovered from a usage log. This advisor therefore makes two deliberately different comparisons:

- **Compaction:** calibrated simulation on a fixed observed task trajectory. Threshold = contextWindow − reserveTokens, with a strict `>` trigger. Candidates are the current threshold plus 75k, 100k, 150k, 200k, 250k, 350k and 500k, filtered against the window, keepRecentTokens and at least 16,384 reserve. First calls establish context. Subsequent observed prompt growth is replayed; actual compaction drops are bridged with **zero inferred growth**, since logs cannot separate new user/tool content from retained context at that boundary. New compactions use median measured summary-input/before-context ratio, summary output, and subsequent prompt size. Each pays summary usage plus one cold prefix rewrite. Ordinary calls use aggregate observed steady cache fractions. Output tokens are held fixed. Branches, model/response-model changes, context decreases, corrupt/excluded records and duplicate calls reset the trajectory.
- **Thinking:** historical mean weighted tokens per call, grouped by recorded model and thinking level. “Cheapest observed” requires ≥10 calls and ≥2 sessions and an enabled thinking map entry if supplied. These are different tasks, routes and roles: savings are N/A and no thinking snippet is emitted. Roles are not guessed from a model name or directory.

Cache retention is excluded: it is not a Pi 1.5.2 `settings.json` setting. Provider `cacheRetention` options/`PI_CACHE_RETENTION` and model `promptCache` metadata are separate mechanisms, and gateway TTL behavior cannot be inferred from these session records. Cache warming is out of scope.

Weighted units are **input-equivalent tokens per model**, not dollars or gateway billing:

```text
(input × tier.input + cacheRead × tier.input × 0.1
 + cacheWrite × tier.cacheWrite + output × tier.output) / base.input
```

The 0.1 read weight follows the owner's request even where local tariffs specify a different read discount. Output/write multipliers and long-context tiers come from the current local catalog. Tier selection includes all prompt tokens. No token counts are added twice. Gateway routing, subscription billing, historical tariff changes and provider-specific write TTL are not independently verified; unknown prices remain N/A. No gateway connection or credential access is needed beyond parsing local models metadata (URLs/keys are discarded and never reported).

A copyable reserveTokens recommendation requires ≥30 calls from ≥3 sessions, ≥3 measured compactions from ≥2 sessions, a current-setting simulation within 25% of matched observed cost, and ≥10% savings for the same candidate under 0.5×, 1×, 1.5× and 2× summary input/output/post-context assumptions. These are conservative policy gates and sensitivity checks, **not statistical confidence or quality validation**. A threshold change may affect task success or recovery work; only an actual owner-run trial can measure that. Current-setting winners and unstable alternatives emit no change.

## Resource and data limits

Nothing polls, and no network call, LLM call, daemon, or cached analysis is added. The one hook is the biweekly automatic check described below: it stores a scalar summary and a copy of the last report, never settings. Repeated explicit commands recompute from disk; a single extension instance refuses overlapping dialogs/scans. `/tune` refuses while the agent is running.

Default: last 30 days, newest 100 JSONL files by mtime. Options allow at most 90 days/200 files. Each selected file is streamed once; only scalar usage records are retained. Hard limits: 128 MiB total, 16 MiB/file, 1 MiB/line, 25,000 successful calls, 10,000 directory entries, depth 6, 10 seconds discovery/reading. The final scalar simulation is O(calls × a fixed candidate/sensitivity count), with no second file pass. Large files/lines, invalid or failed calls, partial final lines, non-Pi files and duplicate response IDs are excluded and reported. Symlink entries are not followed during discovery. Appending files are read only to their starting size; this is an observational snapshot, not a transaction.

Counts may be biased by caps, edited/forked histories, missing usage, omitted large tool/image entries, current-vs-historical settings, and gateway route metadata. Complete calibrated pairs require a subsequent assistant call; summaries at the end of a session are excluded from matched observed cost. Caps and excluded record counts are shown. No prompts, response text, session paths, or credentials are included in the report.

## Pinned implementation evidence

Checked against installed `@earendil-works/pi-coding-agent` **1.5.2**, under `~/.local/share/mise/installs/node/26.4.0/lib/node_modules/@earendil-works/pi-coding-agent/`:

- `dist/core/settings-manager.js:653–669`: model override → ordinary setting → defaults; `:600–604`: exact provider/model thinking map.
- `dist/core/compaction/compaction.js:53–57`: enabled, reserve 16384, keep 20000 defaults; `:173–176`: strict `>` threshold.
- `dist/core/compaction/compaction.js:513–540`: summary is an actual completion; reserve parameter is **unused** and summaries use the model output limit. Older prior-art advice that increasing reserve increases summary cap does not apply.
- `dist/core/settings-schema.js`: no `cacheRetention`/`promptCache` root setting; `:266` defines the separate cacheWarming switch.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:143–153,550–570`: retention resolution and transport compatibility; not a global settings key.
- `docs/extensions.md:1737–1754`: command registration; `:2834`: editor dialog. `sendMessage` would add context (`:1807`), so the advisor uses only the dialog.

Prior art read (no installation): [pi-auto-compact 1.3.1](https://github.com/Chasen-Liao/pi-auto-compact) provides threshold/alignment settings; [pi-custom-compaction 0.2.5](https://github.com/nicobailon/pi-custom-compaction) swaps summary models/templates; [pi-prefix-cache-compaction 0.6.1](https://github.com/jagdeepsinghdev/pi-prefix-cache-compaction) captures requests and calls providers for summaries/warming; [pi-cache-optimizer 2.10.6](https://github.com/jiangge/pi-cache-optimizer) changes cache behavior and collects statistics. Those runtime interventions are not needed for this offline advisor.

## Automatic check

`session_start` starts a biweekly run of the same scan when tabline is enabled, the session is a TUI, the process is not a subagent child (`PI_SUBAGENT_CHILD=1`), and the last run is 14+ days old. `TABLINE_AUTOTUNE=0` turns it off. The module is imported on demand and an unref'd one-shot timer defers the work past startup, so the first frames never wait on the scan. There is no daemon: nothing happens between sessions, and a session that is never started never checks.

Two files live under `~/.cache/agent-runtime/pi-autotune/`:

- `state.json` — `lastRun`, plus per model: mean weighted tokens/call, calls, measured compactions, observed cache-read share, and the current-threshold discrepancy (|simulated − observed| / observed). Unknown values are `null`, never `0`, so an unpriceable model cannot look like zero growth.
- `last-report.txt` — the full report `/tune` would show, so the evidence survives the notice.

A one-line notice (`… · run /tune`) appears only when something needs the owner:

- a non-empty settings snippet — a robust compaction winner exists. It is never applied by the extension; only `/tune` prints it for manual merging.
- per-model mean weighted tokens/call rose ≥25% against the previous state, with ≥100 calls on both sides.
- the current-threshold simulation is >5% away from observed weighted spend. Only evaluable models have a measured discrepancy (≥30 calls/3 sessions, ≥3 compactions, valid prices), so this repeats at most once per 14 days while it persists.
- the scan or its configuration is unreadable. The attempt is still recorded, so a broken config cannot notify on every session start.

The first run ever only records a baseline; it may notify on a winner or a failure, nothing else. Every other quiet outcome stays silent, and `/tune` remains the way to see details on demand.

Measured 2026-11-14 on the owner's corpus: cold lazy module load 35 ms inside the deferred timer, not-due check 0.06–0.21 ms (median 0.08 ms: one state read, no scan), due run 0.41 s wall for 3,001 calls / 58.5 MiB, writing a 1.2 KiB state and a 7.4 KiB report. That run produced no notice: snippet `{}`, no previous summary, no discrepancy above 5%.

## Verification

`tune.test.ts` covers exact billing math, context tiers, strict trigger equality, summary/cold rewrite cost, inadequate data, a robust positive recommendation, disabled compaction, fork deduplication, incomplete/corrupt/oversized records, non-Pi sessions, invalid arguments, missing prices, secret redaction, and unchanged settings. `tune-auto.test.ts` covers the 14-day gate, the state summary, each notify rule, the silent cases, failure handling, the non-TUI/subagent/opt-out skips, and a real `session_start` through `index.ts` that writes state from a fixture corpus without touching the real one. `load.test.ts` invokes `/tune` through Pi's actual loader and verifies the dialog receives a copyable snippet with no model turn. Existing golden outputs change only to include the new registered command; footer/spinner rendering and timers are unchanged.

Measured 2026-11-14 on the owner's corpus (default caps): final scan 2,929 calls / 59.3 MiB, `/usr/bin/time -l` 0.50 s real, 0.37 s user, 0.21 s system, peak RSS 191,758,336 bytes (182.9 MiB, includes Node and TypeScript parsing). Scanner itself reported 418 ms wall / 459 ms CPU. Runtime varies with selected files and the host process; the in-app report gives elapsed/CPU time and whole-process RSS, not claimed incremental memory. All 50 host tests passed, including 8 focused advisor tests, 10 automatic-check tests and real-loader invocation. The full host suite ran on an identical scratch copy with dependency symlinks to the installed Pi package (the live extension has no local node_modules); no dependencies were installed. Detailed run artifacts are under `~/.cache/agent-runtime/pi-autotune/`.
