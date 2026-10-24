/** One in-flight focus probe plus one trailing refresh; no timer or preference cache TTL.
 * A second focus during a read requests one fresh result, never applies stale work.
 * Cancellation on detach also prevents late callbacks from repainting a new session.
 */
export function appearanceProbe(read: () => Promise<string>, apply: (text: string) => void) {
	let epoch = 0;
	let pending = false;
	let queued = false;
	const request = () => {
		if (pending) { queued = true; return; }
		pending = true;
		const started = epoch;
		void read().then(text => {
			if (started === epoch && !queued) apply(text);
		}, () => { /* keep the last valid palette on failure */ }).finally(() => {
			pending = false;
			if (queued) { queued = false; request(); }
		});
	};
	return { request, cancel() { epoch++; queued = false; } };
}
