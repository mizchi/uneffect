/* uneffect:refinement_from "./retry-batch-accounting.uneffect.ts#default" */
/* uneffect:state billedUnits: int */ /* uneffect:state auditedUnits: int */ /* uneffect:state deliveryFailed: bool */ /* uneffect:state retryImmediately: bool */ /* uneffect:init billedUnits = 0 */ /* uneffect:init auditedUnits = 0 */ /* uneffect:init deliveryFailed = false */ /* uneffect:init retryImmediately = false */ /* uneffect:action recordBatch: billedUnits' = billedUnits + (deliveryFailed ? (retryImmediately ? 7 : 13) : 5), auditedUnits' = auditedUnits + (deliveryFailed ? (retryImmediately ? 11 : 18) : 6) */

export interface RetryBatchAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  retryImmediately: boolean;
}

export function createRetryBatchAccounting(initial: RetryBatchAccounting): RetryBatchAccounting {
  return initial;
}

export function observeRetryBatchAccounting(runtime: RetryBatchAccounting): RetryBatchAccounting {
  return runtime;
}

export function recordConfiguredBatch(runtime: RetryBatchAccounting): void {
  let units = 1;
  // This is a bounded two-attempt delivery policy, not a claim about an
  // unbounded retry loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (runtime.deliveryFailed) {
        units += 2;
        throw 1;
      }
      units += 1;
    } catch (failedAttemptUnits) {
      units += failedAttemptUnits;
      if (runtime.retryImmediately) continue;
      units += 2;
    } finally {
      runtime.auditedUnits += units;
    }
    units += 1;
  }
  runtime.billedUnits += units;
}
