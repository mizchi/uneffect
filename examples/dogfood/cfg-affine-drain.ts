/* uneffect:state pending: int */ /* uneffect:state processed: int */ /* uneffect:init pending = 0 */ /* uneffect:init processed = 0 */ /* uneffect:action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? pending : 0) */
/* uneffect:refinement_from "./cfg-affine-drain.uneffect.ts#default" */

export interface DrainState {
  pending: number;
  processed: number;
}

export function create(initial: DrainState): DrainState {
  return initial;
}

export function observe(runtime: DrainState): DrainState {
  return runtime;
}

export function drain(runtime: DrainState): void {
  while (runtime.pending > 0) {
    runtime.processed++;
    runtime.pending--;
  }
}
