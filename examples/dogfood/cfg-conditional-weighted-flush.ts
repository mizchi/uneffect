/* uneffect:
  state pending: int
  state urgent: bool
  state sent: int
  init pending = 0
  init urgent = false
  init sent = 0
  action flush: pending' = pending > 0 ? 0 : pending, urgent' = urgent, sent' = sent + (pending > 0 ? urgent ? 2 * pending : pending : 0)
*/

export interface WeightedTelemetryState {
  pending: number;
  urgent: boolean;
  sent: number;
}

/* uneffect: refinement cfgConditionalWeightedFlush@1 create */
export function create(initial: WeightedTelemetryState): WeightedTelemetryState {
  return initial;
}

/* uneffect: refinement cfgConditionalWeightedFlush@1 observe */
export function observe(runtime: WeightedTelemetryState): WeightedTelemetryState {
  return runtime;
}

/* uneffect: refinement cfgConditionalWeightedFlush@1 action flush */
export function flush(runtime: WeightedTelemetryState): void {
  while (runtime.pending > 0) {
    const weight = runtime.urgent ? 2 : 1;
    runtime.sent += weight;
    runtime.pending--;
  }
}
