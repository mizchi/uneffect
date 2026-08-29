/* uneffect:temporal state pending: int */ /* uneffect:temporal state processed: int */ /* uneffect:temporal state sampled: bool */ /* uneffect:temporal init pending = 0 */ /* uneffect:temporal init processed = 0 */ /* uneffect:temporal init sampled = false */ /* uneffect:temporal action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (sampled ? pending : 0) : 0) */

export interface SampledDrainState {
  pending: number;
  processed: number;
  sampled: boolean;
}

/* uneffect:refinement refinement cfgPiecewiseDrain@1 create */
export function create(initial: SampledDrainState): SampledDrainState {
  return initial;
}

/* uneffect:refinement refinement cfgPiecewiseDrain@1 observe */
export function observe(runtime: SampledDrainState): SampledDrainState {
  return runtime;
}

/* uneffect:refinement refinement cfgPiecewiseDrain@1 action drain */
export function drain(runtime: SampledDrainState): void {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++;
    runtime.pending--;
  }
}
