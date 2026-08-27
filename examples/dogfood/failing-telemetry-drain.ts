/* uneffect:
 * state pending: int
 * state deliveredWeight: int
 * state failedWeight: int
 * state attempts: int
 * state fatal: bool
 * init pending = 0
 * init deliveredWeight = 0
 * init failedWeight = 0
 * init attempts = 0
 * init fatal = false
 * action drain: pending' = pending > 0 ? (fatal ? pending - 1 : 0) : pending, deliveredWeight' = deliveredWeight + (pending > 0 ? (fatal ? 0 : pending * (pending + 1) / 2) : 0), failedWeight' = failedWeight + (pending > 0 ? (fatal ? pending : 0) : 0), attempts' = attempts + (pending > 0 ? (fatal ? 1 : pending) : 0)
 */

export interface FailingTelemetryBacklog {
  pending: number;
  deliveredWeight: number;
  failedWeight: number;
  attempts: number;
  fatal: boolean;
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
      break;
    } finally {
      // Every attempted batch owns exactly one queue advancement and audit,
      // including the fatal attempt consumed by the catch-side break.
      runtime.pending--;
      runtime.attempts++;
    }
  }
}
