/* uneffect:refinement_from "./telemetry-fixed-point-drain.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state delivered: int */ /* uneffect:state failed: int */ /* uneffect:state audited: int */ /* uneffect:state reject: bool */ /* uneffect:init pending = 0 */ /* uneffect:init delivered = 0 */ /* uneffect:init failed = 0 */ /* uneffect:init audited = 0 */ /* uneffect:init reject = false */ /* uneffect:action drain: pending' = pending > 0 ? 0 : pending, delivered' = delivered + (pending > 0 ? (reject ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (reject ? pending * (pending + 1) / 2 : 0) : 0), audited' = audited + (pending > 0 ? pending : 0) */

export interface TelemetryDrainState {
  pending: number;
  delivered: number;
  failed: number;
  audited: number;
  reject: boolean;
}

export function createTelemetryDrain(initial: TelemetryDrainState): TelemetryDrainState {
  return initial;
}

export function observeTelemetryDrain(runtime: TelemetryDrainState): TelemetryDrainState {
  return runtime;
}

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
