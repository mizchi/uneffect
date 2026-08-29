/* uneffect:temporal state recoveredUnits: int */ /* uneffect:temporal state deliveryFailed: bool */ /* uneffect:temporal state escalateFinalization: bool */ /* uneffect:temporal init recoveredUnits = 0 */ /* uneffect:temporal init deliveryFailed = false */ /* uneffect:temporal init escalateFinalization = false */ /* uneffect:temporal action recoverDelivery: recoveredUnits' = recoveredUnits + (deliveryFailed ? (escalateFinalization ? 8 : 5) : (escalateFinalization ? 6 : 3)) */

export interface EscalationAccounting {
  recoveredUnits: number;
  deliveryFailed: boolean;
  escalateFinalization: boolean;
}

/* uneffect:refinement refinement finallyEscalationAccounting@1 create */
export function createEscalationAccounting(initial: EscalationAccounting): EscalationAccounting {
  return initial;
}

/* uneffect:refinement refinement finallyEscalationAccounting@1 observe */
export function observeEscalationAccounting(runtime: EscalationAccounting): EscalationAccounting {
  return runtime;
}

/* uneffect:refinement refinement finallyEscalationAccounting@1 action recoverDelivery */
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
