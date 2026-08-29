/* uneffect:temporal state pending: int */ /* uneffect:temporal state batchSize: int */ /* uneffect:temporal state emitted: int */ /* uneffect:temporal init pending = 0 */ /* uneffect:temporal init batchSize = 0 */ /* uneffect:temporal init emitted = 0 */ /* uneffect:temporal action flush: pending' = pending > 0 ? 0 : pending, batchSize' = batchSize + (pending > 0 ? pending : 0), emitted' = emitted + (pending > 0 ? pending * batchSize + pending * (pending - 1) / 2 : 0) */

export interface EntryReadBatchFlushState {
  pending: number;
  batchSize: number;
  emitted: number;
}

/* uneffect:refinement refinement cfgEntryReadBatchFlush@1 create */
export function create(initial: EntryReadBatchFlushState): EntryReadBatchFlushState {
  return initial;
}

/* uneffect:refinement refinement cfgEntryReadBatchFlush@1 observe */
export function observe(runtime: EntryReadBatchFlushState): EntryReadBatchFlushState {
  return runtime;
}

/* uneffect:refinement refinement cfgEntryReadBatchFlush@1 action flush */
export function flush(runtime: EntryReadBatchFlushState): void {
  while (runtime.pending > 0) {
    // Account for the batch that is visible at iteration entry, then advance
    // it for the next emission. Reordering these statements changes the sum.
    runtime.emitted += runtime.batchSize;
    runtime.batchSize++;
    runtime.pending--;
  }
}
