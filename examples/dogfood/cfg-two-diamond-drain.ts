/* uneffect:refinement_from "./cfg-two-diamond-drain.uneffect.ts#default" */
/* uneffect:state pending: int */ /* uneffect:state processed: int */ /* uneffect:state sampled: bool */ /* uneffect:state audit: bool */ /* uneffect:init pending = 0 */ /* uneffect:init processed = 0 */ /* uneffect:init sampled = false */ /* uneffect:init audit = false */ /* uneffect:action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (audit ? (sampled ? 2 * pending : pending) : (sampled ? pending : 0)) : 0) */

export interface TwoDiamondDrainRuntime {
  pending: number;
  processed: number;
  sampled: boolean;
  audit: boolean;
}

export function createCfgTwoDiamondDrain(initial: TwoDiamondDrainRuntime): TwoDiamondDrainRuntime {
  return initial;
}

export function observeCfgTwoDiamondDrain(runtime: TwoDiamondDrainRuntime): TwoDiamondDrainRuntime {
  return runtime;
}

export function drainCfgTwoDiamond(runtime: TwoDiamondDrainRuntime): void {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++;
    if (runtime.audit) runtime.processed++;
    runtime.pending--;
  }
}
