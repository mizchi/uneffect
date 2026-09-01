/* uneffect:state billedUnits: int */ /* uneffect:state auditedUnits: int */ /* uneffect:state billingMode: int */ /* uneffect:state suppressed: bool */ /* uneffect:state failed: bool */ /* uneffect:state cancelled: bool */ /* uneffect:state deferFailedBilling: bool */ /* uneffect:init billedUnits = 0 */ /* uneffect:init auditedUnits = 0 */ /* uneffect:init billingMode = 0 */ /* uneffect:init suppressed = false */ /* uneffect:init failed = false */ /* uneffect:init cancelled = false */ /* uneffect:init deferFailedBilling = false */ /* uneffect:action record: billedUnits' = suppressed || cancelled || (failed && deferFailedBilling) ? billedUnits : billedUnits + (failed ? 5 : (billingMode === 0 ? 2 : (billingMode === 1 ? 3 : (billingMode === 2 ? 6 : 5)))), auditedUnits' = suppressed ? auditedUnits : auditedUnits + (cancelled ? 2 : (failed ? 5 : (billingMode === 0 ? 2 : (billingMode === 1 ? 3 : (billingMode === 2 ? 6 : 5))))) */

export interface AdaptiveBatchAccounting {
  billedUnits: number;
  auditedUnits: number;
  billingMode: number;
  suppressed: boolean;
  failed: boolean;
  cancelled: boolean;
  deferFailedBilling: boolean;
}

/* uneffect:refinement refinement adaptiveBatchAccounting@1 create */
export function createAdaptiveBatchAccounting(initial: AdaptiveBatchAccounting): AdaptiveBatchAccounting {
  return initial;
}

/* uneffect:refinement refinement adaptiveBatchAccounting@1 observe */
export function observeAdaptiveBatchAccounting(runtime: AdaptiveBatchAccounting): AdaptiveBatchAccounting {
  return runtime;
}

/* uneffect:refinement refinement adaptiveBatchAccounting@1 action record */
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
    if (runtime.deferFailedBilling) return; // audit now, bill only recovered failures
  } finally {
    units += 1; // common per-attempt overhead on normal, return, and recovered throw paths
    runtime.auditedUnits += units;
  }
  runtime.billedUnits += units;
}
