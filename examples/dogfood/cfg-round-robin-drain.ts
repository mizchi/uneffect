/* uneffect:state pending: int */ /* uneffect:state primary: bool */ /* uneffect:init pending = 0 */ /* uneffect:init primary = true */ /* uneffect:action drain: pending' = pending > 0 ? 0 : pending, primary' = pending > 0 ? (pending % 2 === 0 ? primary : !primary) : primary */

export interface RoundRobinDrainState {
  pending: number;
  primary: boolean;
}

/* uneffect:refinement refinement cfgRoundRobinDrain@1 create */
export function create(initial: RoundRobinDrainState): RoundRobinDrainState {
  return initial;
}

/* uneffect:refinement refinement cfgRoundRobinDrain@1 observe */
export function observe(runtime: RoundRobinDrainState): RoundRobinDrainState {
  return runtime;
}

/* uneffect:refinement refinement cfgRoundRobinDrain@1 action drain */
export function drain(runtime: RoundRobinDrainState): void {
  while (runtime.pending > 0) {
    runtime.primary = !runtime.primary;
    runtime.pending--;
  }
}
