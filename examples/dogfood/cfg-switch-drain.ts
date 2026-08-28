/* uneffect:
  state pending: int
  state processed: int
  state mode: int
  init pending = 0
  init processed = 0
  init mode = 0
  action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (mode === 0 ? pending : (mode === 1 ? 2 * pending : 3 * pending)) : 0)
*/

export interface SwitchDrainRuntime {
  pending: number;
  processed: number;
  mode: number;
}

/* uneffect: refinement cfgSwitchDrain@1 create */
export function createCfgSwitchDrain(initial: SwitchDrainRuntime): SwitchDrainRuntime {
  return initial;
}

/* uneffect: refinement cfgSwitchDrain@1 observe */
export function observeCfgSwitchDrain(runtime: SwitchDrainRuntime): SwitchDrainRuntime {
  return runtime;
}

/* uneffect: refinement cfgSwitchDrain@1 action drain */
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
