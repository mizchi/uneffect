/* uneffect:refinement_from "./cfg-round-robin-drain.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state primary: bool */ /* uneffect:init pending = 0 */ /* uneffect:init primary = true */ /* uneffect:action drain: pending' = pending > 0 ? 0 : pending, primary' = pending > 0 ? (pending % 2 === 0 ? primary : !primary) : primary */

export interface RoundRobinDrainState {
  pending: number;
  primary: boolean;
}

export function create(initial: RoundRobinDrainState): RoundRobinDrainState {
  return initial;
}

export function observe(runtime: RoundRobinDrainState): RoundRobinDrainState {
  return runtime;
}

export function drain(runtime: RoundRobinDrainState): void {
  while (runtime.pending > 0) {
    runtime.primary = !runtime.primary;
    runtime.pending--;
  }
}
