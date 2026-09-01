/* uneffect:refinement_from "./failing-telemetry-drain.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state deliveredWeight: int */ /* uneffect:state failedWeight: int */ /* uneffect:state retriedWeight: int */ /* uneffect:state attempts: int */ /* uneffect:state fatal: bool */ /* uneffect:state stopOnFailure: bool */ /* uneffect:init pending = 0 */ /* uneffect:init deliveredWeight = 0 */ /* uneffect:init failedWeight = 0 */ /* uneffect:init retriedWeight = 0 */ /* uneffect:init attempts = 0 */ /* uneffect:init fatal = false */ /* uneffect:init stopOnFailure = false */ /* uneffect:action drain: pending' = pending > 0 ? (fatal && stopOnFailure ? pending - 1 : 0) : pending, deliveredWeight' = deliveredWeight + (pending > 0 ? (fatal ? 0 : pending * (pending + 1) / 2) : 0), failedWeight' = failedWeight + (pending > 0 ? (fatal ? (stopOnFailure ? pending : pending * (pending + 1) / 2) : 0) : 0), retriedWeight' = retriedWeight + (pending > 0 ? (fatal && !stopOnFailure ? pending * (pending + 1) / 2 : 0) : 0), attempts' = attempts + (pending > 0 ? (fatal && stopOnFailure ? 1 : pending) : 0) */

export interface FailingTelemetryBacklog {
  pending: number;
  deliveredWeight: number;
  failedWeight: number;
  retriedWeight: number;
  attempts: number;
  fatal: boolean;
  stopOnFailure: boolean;
}

export function createFailingTelemetryBacklog(initial: FailingTelemetryBacklog): FailingTelemetryBacklog {
  return initial;
}

export function observeFailingTelemetryBacklog(runtime: FailingTelemetryBacklog): FailingTelemetryBacklog {
  return runtime;
}

export function drainFailingTelemetryBacklog(runtime: FailingTelemetryBacklog): void {
  while (runtime.pending > 0) {
    try {
      if (runtime.fatal) throw runtime.pending;
      runtime.deliveredWeight += runtime.pending;
    } catch (failedWeight) {
      runtime.failedWeight += failedWeight;
      if (runtime.stopOnFailure) break;
      runtime.retriedWeight += failedWeight;
      continue;
    } finally {
      // Every attempted batch owns exactly one queue advancement and audit,
      // including the fatal attempt consumed by the catch-side break.
      runtime.pending--;
      runtime.attempts++;
    }
  }
}
