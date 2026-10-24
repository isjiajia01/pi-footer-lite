/**
 * Segment registry: the only list to edit when adding/removing a footer item.
 * Position comes from each segment's line/side/order, not from this array's order.
 */

import * as B from "./builtin.ts";
import { pushSegment } from "./push.ts";
import type { Segment } from "./types.ts";

export function buildSegments(extra: Segment[] = []): Segment[] {
	const own: Segment[] = [
		B.project, B.branch,
		B.peerActive, B.peers, pushSegment(), B.relay,
		B.route,
		B.ctx, B.cache, B.out, B.speed,
		...extra,
	];
	const claimed = new Set(own.flatMap((s) => s.claims ?? []));
	return [...own, B.otherStatuses(claimed)];
}

export const SEGMENTS: readonly Segment[] = buildSegments();
export type { FooterInput, Segment, Source } from "./types.ts";
export { PINNED } from "./types.ts";
