/* uneffect:refinement_from "./cfg-coupled-batch-flush.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state batch: int */ /* uneffect:state sent: int */ /* uneffect:init pending = 0 */ /* uneffect:init batch = 0 */ /* uneffect:init sent = 0 */ /* uneffect:action flush: pending' = pending > 0 ? 0 : pending, batch' = batch + (pending > 0 ? pending : 0), sent' = sent + (pending > 0 ? pending * batch + pending * (pending + 1) / 2 : 0) */

export interface TelemetryBatchState {
  pending: number;
  batch: number;
  sent: number;
}

export function create(initial: TelemetryBatchState): TelemetryBatchState {
  return initial;
}

export function observe(runtime: TelemetryBatchState): TelemetryBatchState {
  return runtime;
}

export function flush(runtime: TelemetryBatchState): void {
  while (runtime.pending > 0) {
    runtime.batch++;
    runtime.sent += runtime.batch;
    runtime.pending--;
  }
}
