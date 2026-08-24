/* uneffect: effect Timer */
function afterCacheHit(): void {
  queueMicrotask(() => undefined);
}

/* uneffect: effect Timer */
function afterOriginFetch(): void {
  process.nextTick(() => undefined);
}

/** Choose one completion policy; the two nested queues must not be merged. */
/* uneffect: effect Timer */
export function scheduleCompletion(cacheHit: boolean): void {
  setTimeout(cacheHit ? afterCacheHit : afterOriginFetch, 0);
}
