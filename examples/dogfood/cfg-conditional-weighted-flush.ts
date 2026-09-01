/* uneffect:refinement_from "./cfg-conditional-weighted-flush.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state urgent: bool */ /* uneffect:state sent: int */ /* uneffect:init pending = 0 */ /* uneffect:init urgent = false */ /* uneffect:init sent = 0 */ /* uneffect:action flush: pending' = pending > 0 ? 0 : pending, urgent' = urgent, sent' = sent + (pending > 0 ? urgent ? 2 * pending : pending : 0) */

export interface WeightedTelemetryState {
  pending: number;
  urgent: boolean;
  sent: number;
}

export function create(initial: WeightedTelemetryState): WeightedTelemetryState {
  return initial;
}

export function observe(runtime: WeightedTelemetryState): WeightedTelemetryState {
  return runtime;
}

export function flush(runtime: WeightedTelemetryState): void {
  while (runtime.pending > 0) {
    const weight = runtime.urgent ? 2 : 1;
    runtime.sent += weight;
    runtime.pending--;
  }
}
