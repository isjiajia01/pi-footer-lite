# pi-footer-lite → tabline

One pi extension that replaces the editor rules, the working spinner and the footer
(this repo previously held `footer-lite`; it now also contains the former `claude-shimmer` fork).

```
── ✻ Crunching… 18s · ↓ 54 tok ─────────────────────────   top rule, spinner embedded
▏ input
──────────────────────────────────────────────────────────   bottom rule
10.14_Slip ●  main                          1 peer · ● relay
std · low         ctx 9.1% · ch 98.8% · out 13k · 212 tok/s
```

## Color rules
- Hierarchy is gray only (4 steps, cool tint). Separators `·` and failed-focus rules are near-background.
- **Tab identity color** — one of 6 equal-lightness hues, hashed from the git root so a project keeps its color; avoids clashes with other open pi tabs (registry in `$TMPDIR/pi-tabline`). Used only for the rules and the dot after the project name. Focus changes fade over 140 ms (needs terminal focus reporting).
- **Brand coral** — spinner and live tok/s only. Shimmer is a Gaussian sweep, 2 s period.
- **Semantic** green/amber/red — relay dot, `ctx` ≥60/85 %, `ch` <50/20 %. Reconnecting dot breathes.
- Rules fade from the identity color to the real terminal background (OSC 11) in OKLab.
- All color math is OKLab/OKLCH; tokens live in `extensions/tabline/src/color.ts`.

Fallbacks: truecolor → 256 (3-step rule, no shimmer) → 16 → `NO_COLOR`. `NO_MOTION=1` / `REDUCE_MOTION=1` or non-TTY disables shimmer. Set `PI_NERD_FONT=1|0` to force the branch icon (auto on Ghostty/WezTerm/iTerm/kitty).

## Cost
No timers while idle. While the agent runs: one timer (~18 fps with shimmer, 120 ms without) and no pi loader timer (the built-in indicator is hidden). Rule strings are cached per width/color/background.

## Structure and performance
See `extensions/tabline/DESIGN.md` (modules, segment model, how to add a status segment). Dark terminals only. Tests: `npm test` (needs pi packages resolvable).

## Use
`pi install git:github.com/isjiajia01/pi-footer-lite`, or copy `extensions/tabline/` to `~/.pi/agent/extensions/tabline/` and `/reload`.
`/tabline off` restores pi's defaults; `/tabline on` re-enables. Remove the folder to uninstall.

Test: `npm test` (spec sample values).

License: MIT (shimmer part derived from pi-claude-shimmer by ouzhenkun).
