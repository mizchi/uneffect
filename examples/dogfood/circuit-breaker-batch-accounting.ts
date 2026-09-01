/* uneffect:refinement_from "./circuit-breaker-batch-accounting.uneffect.ts#default" */
/* uneffect:state billedUnits: int */ /* uneffect:state auditedUnits: int */ /* uneffect:state deliveryFailed: bool */ /* uneffect:state circuitOpen: bool */ /* uneffect:init billedUnits = 0 */ /* uneffect:init auditedUnits = 0 */ /* uneffect:init deliveryFailed = false */ /* uneffect:init circuitOpen = false */ /* uneffect:action recordAttempt: billedUnits' = billedUnits + (deliveryFailed ? (circuitOpen ? 4 : 7) : 3), auditedUnits' = auditedUnits + (deliveryFailed ? (circuitOpen ? 4 : 6) : 2) */

export interface BatchAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  circuitOpen: boolean;
}

export function createBatchAccounting(initial: BatchAccounting): BatchAccounting {
  return initial;
}

export function observeBatchAccounting(runtime: BatchAccounting): BatchAccounting {
  return runtime;
}

export function recordConfiguredAttempt(runtime: BatchAccounting): void {
  let units = 1;
  // The singleton tuple represents one statically configured Datadog intake.
  // The bounded form is deliberate: Uneffect does not claim a dynamic retry
  // fixed point here.
  for (const intakeCost of [1] as const) {
    try {
      if (runtime.deliveryFailed) {
        units += 2;
        throw intakeCost;
      }
      units += intakeCost;
    } catch (failedIntakeCost) {
      units += failedIntakeCost;
      if (runtime.circuitOpen) break;
      units += 2;
    } finally {
      runtime.auditedUnits += units;
    }
    units += 1;
  }
  runtime.billedUnits += units;
}
