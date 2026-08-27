/* uneffect:
 * state billedUnits: int
 * state auditRecords: int
 * state priority: bool
 * state retried: bool
 * init billedUnits = 0
 * init auditRecords = 0
 * init priority = false
 * init retried = false
 * action record: billedUnits' = billedUnits + (retried ? (priority ? 5 : 4) : (priority ? 2 : 1)), auditRecords' = auditRecords + 1
 */

export interface AdaptiveBatchAccounting {
  billedUnits: number;
  auditRecords: number;
  priority: boolean;
  retried: boolean;
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
  // while the model records its exact path-sensitive result.
  let units = 1;
  if (runtime.priority) units = 2;
  if (runtime.retried) units += 3;
  runtime.billedUnits += units;
  runtime.auditRecords++;
}
