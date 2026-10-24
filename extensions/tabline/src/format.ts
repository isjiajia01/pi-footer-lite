/** Pure text formatters (no color, no state). */

/** 950 → `950`, 9_100 → `9.1k`, 54_000 → `54k`, 1_200_000 → `1.2M`. */
export const kfmt = (n: number) =>
	n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : n < 1e6 ? `${Math.round(n / 1e3)}k` : `${(n / 1e6).toFixed(1)}M`;

/** 18_400 → `18s`, 74_000 → `1m 14s`. */
export const fmtDur = (ms: number) => {
	const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
	return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
};

/** `claude/claude-sonnet-5-5` → `Sonnet 5.5`; drops `20250101`-style date stamps. */
export function prettyModel(id: string): string {
	const p = id.slice(id.lastIndexOf("/") + 1).replace(/^claude-/, "").split("-").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < p.length; i++) {
		if (/^\d+$/.test(p[i]) && /^\d+$/.test(p[i + 1] ?? "")) out.push(`${p[i]}.${p[++i]}`);
		else if (!/^20\d{6}$/.test(p[i])) out.push(p[i][0].toUpperCase() + p[i].slice(1));
	}
	return out.join(" ") || id;
}

/** Tokens/s: one decimal below 100, integer above. */
export const fmtRate = (r: number) => (r < 100 ? r.toFixed(1) : `${Math.round(r)}`);
