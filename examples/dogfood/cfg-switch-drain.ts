/* uneffect:state pending: int */ /* uneffect:state processed: int */ /* uneffect:state mode: int */ /* uneffect:init pending = 0 */ /* uneffect:init processed = 0 */ /* uneffect:init mode = 0 */ /* uneffect:action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (mode === 0 ? pending : (mode === 1 ? 2 * pending : 3 * pending)) : 0) */
/* uneffect:refinement_from "./cfg-switch-drain.uneffect.ts#default" */

export interface SwitchDrainRuntime {
  pending: number;
  processed: number;
  mode: number;
}

export function createCfgSwitchDrain(initial: SwitchDrainRuntime): SwitchDrainRuntime {
  return initial;
}

export function observeCfgSwitchDrain(runtime: SwitchDrainRuntime): SwitchDrainRuntime {
  return runtime;
}

export function drainCfgSwitch(runtime: SwitchDrainRuntime): void {
  while (runtime.pending > 0) {
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
