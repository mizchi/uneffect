/* uneffect:refinement_from "./finally-escalation-accounting.uneffect.ts#default" */
/* uneffect:state recoveredUnits: int */ /* uneffect:state deliveryFailed: bool */ /* uneffect:state escalateFinalization: bool */ /* uneffect:init recoveredUnits = 0 */ /* uneffect:init deliveryFailed = false */ /* uneffect:init escalateFinalization = false */ /* uneffect:action recoverDelivery: recoveredUnits' = recoveredUnits + (deliveryFailed ? (escalateFinalization ? 8 : 5) : (escalateFinalization ? 6 : 3)) */

export interface EscalationAccounting {
  recoveredUnits: number;
  deliveryFailed: boolean;
  escalateFinalization: boolean;
}

export function createEscalationAccounting(initial: EscalationAccounting): EscalationAccounting {
  return initial;
}

export function observeEscalationAccounting(runtime: EscalationAccounting): EscalationAccounting {
  return runtime;
}

export function recoverDelivery(runtime: EscalationAccounting): void {
  let units = 1;
  try {
    try {
      if (runtime.deliveryFailed) {
        units += 2;
        throw 1;
      }
      units += 1;
    } finally {
      units += 1;
      // The normalized scalar represents reviewed finalization failure data.
      // Opaque host errors remain outside this proof fragment.
      if (runtime.escalateFinalization) throw units;
    }
  } catch (failedUnits) {
    runtime.recoveredUnits += units + failedUnits;
    return;
  }
  runtime.recoveredUnits += units;
}
