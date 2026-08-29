/* uneffect:temporal state billedUnits: int */ /* uneffect:temporal state auditedUnits: int */ /* uneffect:temporal state deliveryFailed: bool */ /* uneffect:temporal state circuitOpen: bool */ /* uneffect:temporal init billedUnits = 0 */ /* uneffect:temporal init auditedUnits = 0 */ /* uneffect:temporal init deliveryFailed = false */ /* uneffect:temporal init circuitOpen = false */ /* uneffect:temporal action recordAttempt: billedUnits' = deliveryFailed ? (circuitOpen ? billedUnits + 4 : billedUnits) : billedUnits + (circuitOpen ? 3 : 4), auditedUnits' = auditedUnits + (deliveryFailed ? 4 : 3) */

export interface FinallyCircuitAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  circuitOpen: boolean;
}

/* uneffect:refinement refinement finallyCircuitBreakAccounting@1 create */
export function createFinallyCircuitAccounting(initial: FinallyCircuitAccounting): FinallyCircuitAccounting {
  return initial;
}

/* uneffect:refinement refinement finallyCircuitBreakAccounting@1 observe */
export function observeFinallyCircuitAccounting(runtime: FinallyCircuitAccounting): FinallyCircuitAccounting {
  return runtime;
}

/* uneffect:refinement refinement finallyCircuitBreakAccounting@1 action recordAttempt */
export function recordConfiguredAttempt(runtime: FinallyCircuitAccounting): void {
  let units = 1;
  for (let attempt = 0; attempt < 1; attempt++) {
    try {
      if (runtime.deliveryFailed) {
        units += 2;
        throw 1;
      }
      units += 1;
    } finally {
      units += 1;
      runtime.auditedUnits += units;
      // Opening the circuit suppresses a pending attempt failure and exits the
      // statically bounded policy. Dynamic retry loops remain unsupported.
      if (runtime.circuitOpen) break;
    }
    units += 1;
  }
  runtime.billedUnits += units;
}
