/* uneffect:refinement_from "./finally-circuit-break-accounting.uneffect.ts#default" */
/* uneffect:state billedUnits: int */ /* uneffect:state auditedUnits: int */ /* uneffect:state deliveryFailed: bool */ /* uneffect:state circuitOpen: bool */ /* uneffect:init billedUnits = 0 */ /* uneffect:init auditedUnits = 0 */ /* uneffect:init deliveryFailed = false */ /* uneffect:init circuitOpen = false */ /* uneffect:action recordAttempt: billedUnits' = deliveryFailed ? (circuitOpen ? billedUnits + 4 : billedUnits) : billedUnits + (circuitOpen ? 3 : 4), auditedUnits' = auditedUnits + (deliveryFailed ? 4 : 3) */

export interface FinallyCircuitAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  circuitOpen: boolean;
}

export function createFinallyCircuitAccounting(initial: FinallyCircuitAccounting): FinallyCircuitAccounting {
  return initial;
}

export function observeFinallyCircuitAccounting(runtime: FinallyCircuitAccounting): FinallyCircuitAccounting {
  return runtime;
}

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
