/* uneffect:
 * state pending: int
 * state delivered: int
 * state failed: int
 * state audited: int
 * state reject: bool
 * init pending = 0
 * init delivered = 0
 * init failed = 0
 * init audited = 0
 * init reject = false
 * action drain: pending' = pending > 0 ? 0 : pending, delivered' = delivered + (pending > 0 ? (reject ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (reject ? pending * (pending + 1) / 2 : 0) : 0), audited' = audited + (pending > 0 ? pending : 0)
 */

export interface TelemetryDrainState {
  pending: number;
  delivered: number;
  failed: number;
  audited: number;
  reject: boolean;
}

/* uneffect: refinement telemetryFixedPoint@1 create */
export function createTelemetryDrain(initial: TelemetryDrainState): TelemetryDrainState {
  return initial;
}

/* uneffect: refinement telemetryFixedPoint@1 observe */
export function observeTelemetryDrain(runtime: TelemetryDrainState): TelemetryDrainState {
  return runtime;
}

/* uneffect: refinement telemetryFixedPoint@1 action drain */
export function drainTelemetry(runtime: TelemetryDrainState): void {
  while (runtime.pending > 0) {
    try {
      // This models the success/failure accounting around a send boundary. The
      // host I/O itself remains outside this scalar refinement proof.
      if (runtime.reject) throw runtime.pending;
      runtime.delivered += runtime.pending;
    } catch (amount) {
      runtime.failed += amount;
    } finally {
      runtime.pending--;
      runtime.audited++;
    }
  }
}
