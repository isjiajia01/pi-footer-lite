# pi-footer-lite

A tiny replacement footer for [pi](https://pi.dev). One file, no dependencies, no timers.

```
proj (main) • my-session                ⬡ 1 peer · ⇄ relay · ◇ iPhone
main → Sonnet 5.5 • medium                 ctx 4.6% · ch 98.9% · out 8.0k · 42 tok/s
```

Two lines, nothing more. Line 1 carries context, line 2 carries the model and its usage.

- **Line 1 left**: project directory, git branch, session name.
- **Line 1 right**: extension statuses, redrawn compactly (see below). Nothing is shown when no extension publishes a status.
- **Line 2 left**: selected model (`group/main` is shown as `main`), the model that actually answered (`→ Sonnet 5.5`), thinking level.
- **Line 2 right**: context usage, cache hit rate of the latest reply, cumulative output tokens, and average output speed. On narrow terminals speed, then `out`, then `ch` are dropped first.

`out` is the whole-session total (all branches, tool-result, usage, compaction and branch-summary entries), the same scope as pi's built-in `↓`. It is updated incrementally on `message_end` and recounted once per turn.

## Extension statuses

Statuses published through `ctx.ui.setStatus()` are compressed to one glyph per state and moved onto the right of line 1, so the footer stays two lines. The texts published by [remote-pi](https://github.com/jacobaraujo7/remote_pi) are recognised and redrawn:

| published text | shown as | meaning |
| --- | --- | --- |
| `📡 local (0)` | *(nothing)* | alone on the local agent mesh — not worth a slot |
| `📡 local (2)` | `⬡ 2 peers` | agents online on the mesh |
| `🟢 relay` | `⇄ relay` | relay connected, a device is paired |
| `🟡 relay waiting for pairing` | `⇄ relay ○` | relay connected, no device yet |
| `📱 iPhone` | `◇ iPhone` | paired device |

Any other extension's status text is appended as-is, dimmed, so nothing is ever hidden. On narrow terminals line 1 gives up the least important status first: paired device, then mesh peers, then other extensions, and the relay last; if even the relay does not fit, the right side disappears.

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

## Output speed

`42 tok/s` is calculated from the provider's output token count divided by the elapsed time from the first stream update to message completion. It excludes the wait before streaming starts and updates after a reply ends. Windows shorter than 0.5 seconds do not update the value. There are no timers or live speed redraws; no separate speed extension is required.

## Status

Tested against a mocked pi API (edge-case data, narrow widths, garbage event payloads), including a differential check that the current rendering is byte-identical to the previous release across ~25k combinations of width, model, session, usage and status input. Not exhaustively tested in every pi version; issues welcome.

## License

MIT
