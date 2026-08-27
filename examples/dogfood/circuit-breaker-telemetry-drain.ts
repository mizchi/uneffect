/* uneffect:
 * state pending: int
 * state processed: int
 * state stoppedWeight: int
 * state urgent: bool
 * state sampled: bool
 * state circuitOpen: bool
 * init pending = 0
 * init processed = 0
 * init stoppedWeight = 0
 * init urgent = false
 * init sampled = false
 * init circuitOpen = false
 * action drain: pending' = pending > 0 ? ((urgent && sampled) || circuitOpen ? pending : 0) : pending, processed' = processed + (pending > 0 ? ((urgent && sampled) || circuitOpen ? 0 : pending * (pending - 1) / 2) : 0), stoppedWeight' = stoppedWeight + (pending > 0 ? (urgent ? (sampled ? pending : (circuitOpen ? 2 * pending : 0)) : (circuitOpen ? 2 * pending : 0)) : 0)
 */

export interface CircuitBreakerTelemetryBacklog {
  pending: number;
  processed: number;
  stoppedWeight: number;
  urgent: boolean;
  sampled: boolean;
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
  // Urgent telemetry stops the drain only when this batch is sampled. An open
  // external circuit independently stops it with twice the weight for capacity
  // accounting. Otherwise the queue drains and accumulates remaining depth.
  while (runtime.pending > 0) {
    if (runtime.urgent) {
      if (runtime.sampled) {
        runtime.stoppedWeight += runtime.pending;
        break;
      }
    }
    if (runtime.circuitOpen) {
      runtime.stoppedWeight += 2 * runtime.pending;
      break;
    }
    runtime.pending--;
    runtime.processed += runtime.pending;
  }
}
