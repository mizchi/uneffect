/* uneffect:
 * state billedUnits: int
 * state auditedUnits: int
 * state priority: bool
 * state retried: bool
 * state suppressed: bool
 * state failed: bool
 * state cancelled: bool
 * init billedUnits = 0
 * init auditedUnits = 0
 * init priority = false
 * init retried = false
 * init suppressed = false
 * init failed = false
 * init cancelled = false
 * action record: billedUnits' = suppressed || cancelled ? billedUnits : billedUnits + (failed ? 4 : (retried ? (priority ? 5 : 4) : (priority ? 2 : 1))), auditedUnits' = suppressed ? auditedUnits : auditedUnits + (cancelled ? 1 : (failed ? 2 : (retried ? (priority ? 5 : 4) : (priority ? 2 : 1))))
 */

export interface AdaptiveBatchAccounting {
  billedUnits: number;
  auditedUnits: number;
  priority: boolean;
  retried: boolean;
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
    if (runtime.priority) units = 2;
    if (runtime.retried) units += 3;
  } catch (failedUnits) {
    runtime.billedUnits += units + failedUnits;
    return;
  } finally {
    runtime.auditedUnits += units;
  }
  runtime.billedUnits += units;
}
