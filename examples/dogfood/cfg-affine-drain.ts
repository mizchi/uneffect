/* uneffect:temporal state pending: int */ /* uneffect:temporal state processed: int */ /* uneffect:temporal init pending = 0 */ /* uneffect:temporal init processed = 0 */ /* uneffect:temporal action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? pending : 0) */

export interface DrainState {
  pending: number;
  processed: number;
}

/* uneffect:refinement refinement cfgAffineDrain@1 create */
export function create(initial: DrainState): DrainState {
  return initial;
}

/* uneffect:refinement refinement cfgAffineDrain@1 observe */
export function observe(runtime: DrainState): DrainState {
  return runtime;
}

/* uneffect:refinement refinement cfgAffineDrain@1 action drain */
export function drain(runtime: DrainState): void {
  while (runtime.pending > 0) {
    runtime.processed++;
    runtime.pending--;
  }
}
