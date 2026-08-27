/* uneffect:
 * state pending: int
 * state deliveredWeight: int
 * state failedWeight: int
 * state retriedWeight: int
 * state attempts: int
 * state fatal: bool
 * state stopOnFailure: bool
 * init pending = 0
 * init deliveredWeight = 0
 * init failedWeight = 0
 * init retriedWeight = 0
 * init attempts = 0
 * init fatal = false
 * init stopOnFailure = false
 * action drain: pending' = pending > 0 ? (fatal && stopOnFailure ? pending - 1 : 0) : pending, deliveredWeight' = deliveredWeight + (pending > 0 ? (fatal ? 0 : pending * (pending + 1) / 2) : 0), failedWeight' = failedWeight + (pending > 0 ? (fatal ? (stopOnFailure ? pending : pending * (pending + 1) / 2) : 0) : 0), retriedWeight' = retriedWeight + (pending > 0 ? (fatal && !stopOnFailure ? pending * (pending + 1) / 2 : 0) : 0), attempts' = attempts + (pending > 0 ? (fatal && stopOnFailure ? 1 : pending) : 0)
 */

export interface FailingTelemetryBacklog {
  pending: number;
  deliveredWeight: number;
  failedWeight: number;
  retriedWeight: number;
  attempts: number;
  fatal: boolean;
  stopOnFailure: boolean;
}

/* uneffect: refinement failingTelemetry@1 create */
export function createFailingTelemetryBacklog(initial: FailingTelemetryBacklog): FailingTelemetryBacklog {
  return initial;
}

/* uneffect: refinement failingTelemetry@1 observe */
export function observeFailingTelemetryBacklog(runtime: FailingTelemetryBacklog): FailingTelemetryBacklog {
  return runtime;
}

/* uneffect: refinement failingTelemetry@1 action drain */
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
