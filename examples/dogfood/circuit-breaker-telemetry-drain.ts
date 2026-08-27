/* uneffect:
 * state pending: int
 * state processed: int
 * state stoppedWeight: int
 * state fatal: bool
 * state circuitOpen: bool
 * init pending = 0
 * init processed = 0
 * init stoppedWeight = 0
 * init fatal = false
 * init circuitOpen = false
 * action drain: pending' = pending > 0 ? (fatal || circuitOpen ? pending : 0) : pending, processed' = processed + (pending > 0 ? (fatal || circuitOpen ? 0 : pending * (pending - 1) / 2) : 0), stoppedWeight' = stoppedWeight + (pending > 0 ? (fatal ? pending : (circuitOpen ? 2 * pending : 0)) : 0)
 */

export interface CircuitBreakerTelemetryBacklog {
  pending: number;
  processed: number;
  stoppedWeight: number;
  fatal: boolean;
  circuitOpen: boolean;
}

/* uneffect: refinement circuitBreakerTelemetry@1 create */
export function createCircuitBreakerTelemetryBacklog(
  initial: CircuitBreakerTelemetryBacklog,
): CircuitBreakerTelemetryBacklog {
  return initial;
}

/* uneffect: refinement circuitBreakerTelemetry@1 observe */
export function observeCircuitBreakerTelemetryBacklog(
  runtime: CircuitBreakerTelemetryBacklog,
): CircuitBreakerTelemetryBacklog {
  return runtime;
}

/* uneffect: refinement circuitBreakerTelemetry@1 action drain */
export function drainCircuitBreakerTelemetryBacklog(runtime: CircuitBreakerTelemetryBacklog): void {
  // A fatal process state records the untouched backlog once. An open external
  // circuit records twice that weight for capacity accounting. Otherwise the
  // queue drains and accumulates the remaining depth after each removal.
  while (runtime.pending > 0) {
    if (runtime.fatal) {
      runtime.stoppedWeight += runtime.pending;
      break;
    }
    if (runtime.circuitOpen) {
      runtime.stoppedWeight += 2 * runtime.pending;
      break;
    }
    runtime.pending--;
    runtime.processed += runtime.pending;
  }
}
