/* uneffect:refinement_from "./cfg-piecewise-drain.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state processed: int */ /* uneffect:state sampled: bool */ /* uneffect:init pending = 0 */ /* uneffect:init processed = 0 */ /* uneffect:init sampled = false */ /* uneffect:action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (sampled ? pending : 0) : 0) */

export interface SampledDrainState {
  pending: number;
  processed: number;
  sampled: boolean;
}

export function create(initial: SampledDrainState): SampledDrainState {
  return initial;
}

export function observe(runtime: SampledDrainState): SampledDrainState {
  return runtime;
}

export function drain(runtime: SampledDrainState): void {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++;
    runtime.pending--;
  }
}
