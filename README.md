# pi-footer-lite

A tiny replacement footer for [pi](https://pi.dev). One file, no dependencies, no timers.

```
proj (main) • my-session
main → Sonnet 5.5 • medium              ctx 4.6% · ch 98.9% · out 8.0k (session)
<extension statuses, only when some extension publishes them>
```

- **Line 1**: project directory, git branch, session name.
- **Line 2 left**: selected model (`group/main` is shown as `main`), the model that actually answered (`→ Sonnet 5.5`), thinking level.
- **Line 2 right**: context usage, cache hit rate of the latest reply, cumulative output tokens. On narrow terminals `out`, then `ch`, are dropped first.
- **Line 3**: whatever extensions publish through `ctx.ui.setStatus()`.

`out` is the whole-session total (all branches, tool-result, usage, compaction and branch-summary entries), the same scope as pi's built-in `↓`. It is updated incrementally on `message_end` and recounted once per turn.

## The route arrow

`→ Sonnet 5.5` appears only when the selected model id starts with `group/` (a routing group on an OpenAI-compatible gateway) and the provider reports a different `responseModel`. It is shown while pi is idle and only if the last reply was sent with the current selection. For ordinary models there is no arrow.

## Install

```sh
pi install npm:pi-footer-lite      # once published to npm
# or straight from GitHub
pi install git:github.com/isjiajia01/pi-footer-lite
```

Then `/reload`.

## Commands

- `/footerlite off` restores pi's built-in footer.
- `/footerlite on` turns it back on.

## Not included

Tokens per second. Pair it with [pi-speedometer](https://www.npmjs.com/package/pi-speedometer) for TTFT, prefill and decode speed.

## Status

Tested against a mocked pi API (edge-case data, narrow widths, garbage event payloads). Not exhaustively tested in every pi version; issues welcome.

## License

MIT
