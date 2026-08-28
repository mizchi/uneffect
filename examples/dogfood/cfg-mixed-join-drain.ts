/* uneffect:
  state pending: int
  state processed: int
  state sampled: bool
  state mode: int
  init pending = 0
  init processed = 0
  init sampled = false
  init mode = 0
  action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (mode === 0 ? (sampled ? 2 * pending : pending) : (mode === 1 ? (sampled ? 3 * pending : 2 * pending) : (sampled ? 4 * pending : 3 * pending))) : 0)
*/

export interface MixedJoinDrainRuntime {
  pending: number;
  processed: number;
  sampled: boolean;
  mode: number;
}

/* uneffect: refinement cfgMixedJoinDrain@1 create */
export function createCfgMixedJoinDrain(initial: MixedJoinDrainRuntime): MixedJoinDrainRuntime {
  return initial;
}

/* uneffect: refinement cfgMixedJoinDrain@1 observe */
export function observeCfgMixedJoinDrain(runtime: MixedJoinDrainRuntime): MixedJoinDrainRuntime {
  return runtime;
}

/* uneffect: refinement cfgMixedJoinDrain@1 action drain */
export function drainCfgMixedJoin(runtime: MixedJoinDrainRuntime): void {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++;
    switch (runtime.mode) {
      case 0:
        runtime.processed += 1;
        break;
      case 1:
        runtime.processed += 2;
        break;
      default:
        runtime.processed += 3;
        break;
    }
    runtime.pending--;
  }
}
