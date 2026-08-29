/* uneffect:temporal state billedUnits: int */ /* uneffect:temporal state auditedUnits: int */ /* uneffect:temporal state deliveryFailed: bool */ /* uneffect:temporal state retryImmediately: bool */ /* uneffect:temporal init billedUnits = 0 */ /* uneffect:temporal init auditedUnits = 0 */ /* uneffect:temporal init deliveryFailed = false */ /* uneffect:temporal init retryImmediately = false */ /* uneffect:temporal action recordBatch: billedUnits' = billedUnits + (deliveryFailed ? (retryImmediately ? 7 : 13) : 5), auditedUnits' = auditedUnits + (deliveryFailed ? (retryImmediately ? 11 : 18) : 6) */

export interface RetryBatchAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  retryImmediately: boolean;
}

/* uneffect:refinement refinement retryBatchAccounting@1 create */
export function createRetryBatchAccounting(initial: RetryBatchAccounting): RetryBatchAccounting {
  return initial;
}

/* uneffect:refinement refinement retryBatchAccounting@1 observe */
export function observeRetryBatchAccounting(runtime: RetryBatchAccounting): RetryBatchAccounting {
  return runtime;
}

/* uneffect:refinement refinement retryBatchAccounting@1 action recordBatch */
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
