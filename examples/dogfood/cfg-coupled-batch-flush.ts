/* uneffect:
  state pending: int
  state batch: int
  state sent: int
  init pending = 0
  init batch = 0
  init sent = 0
  action flush: pending' = pending > 0 ? 0 : pending, batch' = batch + (pending > 0 ? pending : 0), sent' = sent + (pending > 0 ? pending * batch + pending * (pending + 1) / 2 : 0)
*/

export interface TelemetryBatchState {
  pending: number;
  batch: number;
  sent: number;
}

/* uneffect: refinement cfgCoupledBatchFlush@1 create */
export function create(initial: TelemetryBatchState): TelemetryBatchState {
  return initial;
}

/* uneffect: refinement cfgCoupledBatchFlush@1 observe */
export function observe(runtime: TelemetryBatchState): TelemetryBatchState {
  return runtime;
}

/* uneffect: refinement cfgCoupledBatchFlush@1 action flush */
export function flush(runtime: TelemetryBatchState): void {
  while (runtime.pending > 0) {
    runtime.batch++;
    runtime.sent += runtime.batch;
    runtime.pending--;
  }
}
