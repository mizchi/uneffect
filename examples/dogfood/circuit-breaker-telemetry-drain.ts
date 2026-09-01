/* uneffect:state pending: int */ /* uneffect:state processed: int */ /* uneffect:state stoppedWeight: int */ /* uneffect:state urgent: bool */ /* uneffect:state sampled: bool */ /* uneffect:state circuitOpen: bool */ /* uneffect:init pending = 0 */ /* uneffect:init processed = 0 */ /* uneffect:init stoppedWeight = 0 */ /* uneffect:init urgent = false */ /* uneffect:init sampled = false */ /* uneffect:init circuitOpen = false */ /* uneffect:action drain: pending' = pending > 0 ? ((urgent && sampled) || circuitOpen ? pending : 0) : pending, processed' = processed + (pending > 0 ? ((urgent && sampled) || circuitOpen ? 0 : pending * (pending - 1) / 2) : 0), stoppedWeight' = stoppedWeight + (pending > 0 ? (urgent ? (sampled ? pending : (circuitOpen ? 2 * pending : 0)) : (circuitOpen ? 2 * pending : 0)) : 0) */

export interface CircuitBreakerTelemetryBacklog {
  pending: number;
  processed: number;
  stoppedWeight: number;
  urgent: boolean;
  sampled: boolean;
  circuitOpen: boolean;
}

/* uneffect:refinement refinement circuitBreakerTelemetry@1 create */
export function createCircuitBreakerTelemetryBacklog(
  initial: CircuitBreakerTelemetryBacklog,
): CircuitBreakerTelemetryBacklog {
  return initial;
}

/* uneffect:refinement refinement circuitBreakerTelemetry@1 observe */
export function observeCircuitBreakerTelemetryBacklog(
  runtime: CircuitBreakerTelemetryBacklog,
): CircuitBreakerTelemetryBacklog {
  return runtime;
}

/* uneffect:refinement refinement circuitBreakerTelemetry@1 action drain */
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
