/* uneffect:refinement_from "./cfg-entry-read-batch-flush.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state batchSize: int */ /* uneffect:state emitted: int */ /* uneffect:init pending = 0 */ /* uneffect:init batchSize = 0 */ /* uneffect:init emitted = 0 */ /* uneffect:action flush: pending' = pending > 0 ? 0 : pending, batchSize' = batchSize + (pending > 0 ? pending : 0), emitted' = emitted + (pending > 0 ? pending * batchSize + pending * (pending - 1) / 2 : 0) */

export interface EntryReadBatchFlushState {
  pending: number;
  batchSize: number;
  emitted: number;
}

export function create(initial: EntryReadBatchFlushState): EntryReadBatchFlushState {
  return initial;
}

export function observe(runtime: EntryReadBatchFlushState): EntryReadBatchFlushState {
  return runtime;
}

export function flush(runtime: EntryReadBatchFlushState): void {
  while (runtime.pending > 0) {
    // Account for the batch that is visible at iteration entry, then advance
    // it for the next emission. Reordering these statements changes the sum.
    runtime.emitted += runtime.batchSize;
    runtime.batchSize++;
    runtime.pending--;
  }
}
