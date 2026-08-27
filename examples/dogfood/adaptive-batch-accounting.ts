/* uneffect:
 * state billedUnits: int
 * state auditedUnits: int
 * state billingMode: int
 * state suppressed: bool
 * state failed: bool
 * state cancelled: bool
 * init billedUnits = 0
 * init auditedUnits = 0
 * init billingMode = 0
 * init suppressed = false
 * init failed = false
 * init cancelled = false
 * action record: billedUnits' = suppressed || cancelled || failed ? billedUnits : billedUnits + (billingMode === 0 ? 2 : (billingMode === 1 ? 3 : (billingMode === 2 ? 6 : 5))), auditedUnits' = suppressed ? auditedUnits : auditedUnits + (cancelled ? 2 : (failed ? 5 : (billingMode === 0 ? 2 : (billingMode === 1 ? 3 : (billingMode === 2 ? 6 : 5)))))
 */

export interface AdaptiveBatchAccounting {
  billedUnits: number;
  auditedUnits: number;
  billingMode: number;
  suppressed: boolean;
  failed: boolean;
  cancelled: boolean;
}

/* uneffect: refinement adaptiveBatchAccounting@1 create */
export function createAdaptiveBatchAccounting(initial: AdaptiveBatchAccounting): AdaptiveBatchAccounting {
  return initial;
}

/* uneffect: refinement adaptiveBatchAccounting@1 observe */
export function observeAdaptiveBatchAccounting(runtime: AdaptiveBatchAccounting): AdaptiveBatchAccounting {
  return runtime;
}

/* uneffect: refinement adaptiveBatchAccounting@1 action record */
export function recordAdaptiveBatch(runtime: AdaptiveBatchAccounting): void {
  // Billing starts at one unit, priority doubles the base charge, and a retry
  // adds three units. The mutable local mirrors common instrumentation code
  // while the model records its exact path-sensitive result. Suppressed
  // batches exit before either billing or audit state is changed.
  let units = 1;
  if (runtime.suppressed) {
    units = 0;
    return;
  }
  try {
    if (runtime.cancelled) {
      units = 1;
      return;
    }
    if (runtime.failed) {
      units = 2;
      throw units;
    }
    switch (runtime.billingMode) {
      case 0:
        units = 1;
        break;
      case 1:
        units = 2;
        break;
      case 2:
        units = 2;
      default:
        units += 3;
        break;
    }
  } catch (failedUnits) {
    units += failedUnits;
    return; // failed batches are audited in finally but never billed
  } finally {
    units += 1; // common per-attempt overhead on normal, return, and recovered throw paths
    runtime.auditedUnits += units;
  }
  runtime.billedUnits += units;
}
