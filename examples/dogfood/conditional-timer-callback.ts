/* uneffect:capability effect Timer */
function afterCacheHit(): void {
  queueMicrotask(() => undefined);
}

/* uneffect:capability effect Timer */
function afterOriginFetch(): void {
  process.nextTick(() => undefined);
}

/** Choose one completion policy; the two nested queues must not be merged. */
/* uneffect:capability effect Timer */
export function scheduleCompletion(cacheHit: boolean): void {
  setTimeout(cacheHit ? afterCacheHit : afterOriginFetch, 0);
}
