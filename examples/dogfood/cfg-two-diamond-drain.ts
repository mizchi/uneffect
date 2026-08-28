/* uneffect:
  state pending: int
  state processed: int
  state sampled: bool
  state audit: bool
  init pending = 0
  init processed = 0
  init sampled = false
  init audit = false
  action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (audit ? (sampled ? 2 * pending : pending) : (sampled ? pending : 0)) : 0)
*/

export interface TwoDiamondDrainRuntime {
  pending: number;
  processed: number;
  sampled: boolean;
  audit: boolean;
}

/* uneffect: refinement cfgTwoDiamondDrain@1 create */
export function createCfgTwoDiamondDrain(initial: TwoDiamondDrainRuntime): TwoDiamondDrainRuntime {
  return initial;
}

/* uneffect: refinement cfgTwoDiamondDrain@1 observe */
export function observeCfgTwoDiamondDrain(runtime: TwoDiamondDrainRuntime): TwoDiamondDrainRuntime {
  return runtime;
}

/* uneffect: refinement cfgTwoDiamondDrain@1 action drain */
export function drainCfgTwoDiamond(runtime: TwoDiamondDrainRuntime): void {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++;
    if (runtime.audit) runtime.processed++;
    runtime.pending--;
  }
}
