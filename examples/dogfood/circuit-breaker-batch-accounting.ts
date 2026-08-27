/* uneffect:
 * state billedUnits: int
 * state auditedUnits: int
 * state deliveryFailed: bool
 * state circuitOpen: bool
 * init billedUnits = 0
 * init auditedUnits = 0
 * init deliveryFailed = false
 * init circuitOpen = false
 * action recordAttempt: billedUnits' = billedUnits + (deliveryFailed ? (circuitOpen ? 4 : 7) : 3), auditedUnits' = auditedUnits + (deliveryFailed ? (circuitOpen ? 4 : 6) : 2)
 */

export interface BatchAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  circuitOpen: boolean;
}

/* uneffect: refinement circuitBreakerBatchAccounting@1 create */
export function createBatchAccounting(initial: BatchAccounting): BatchAccounting {
  return initial;
}

/* uneffect: refinement circuitBreakerBatchAccounting@1 observe */
export function observeBatchAccounting(runtime: BatchAccounting): BatchAccounting {
  return runtime;
}

/* uneffect: refinement circuitBreakerBatchAccounting@1 action recordAttempt */
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
