/* uneffect:temporal state billedUnits: int */ /* uneffect:temporal state auditedUnits: int */ /* uneffect:temporal state deliveryFailed: bool */ /* uneffect:temporal state retryImmediately: bool */ /* uneffect:temporal init billedUnits = 0 */ /* uneffect:temporal init auditedUnits = 0 */ /* uneffect:temporal init deliveryFailed = false */ /* uneffect:temporal init retryImmediately = false */ /* uneffect:temporal action recordBatch: billedUnits' = deliveryFailed ? (retryImmediately ? billedUnits + 7 : billedUnits) : billedUnits + (retryImmediately ? 5 : 7), auditedUnits' = auditedUnits + (deliveryFailed ? (retryImmediately ? 11 : 4) : (retryImmediately ? 8 : 9)) */

export interface FinallyRetryAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  retryImmediately: boolean;
}

/* uneffect:refinement refinement finallyRetryAccounting@1 create */
export function createFinallyRetryAccounting(initial: FinallyRetryAccounting): FinallyRetryAccounting {
  return initial;
}

/* uneffect:refinement refinement finallyRetryAccounting@1 observe */
export function observeFinallyRetryAccounting(runtime: FinallyRetryAccounting): FinallyRetryAccounting {
  return runtime;
}

/* uneffect:refinement refinement finallyRetryAccounting@1 action recordBatch */
export function recordConfiguredRetries(runtime: FinallyRetryAccounting): void {
  let units = 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (runtime.deliveryFailed) {
        units += 2;
        throw 1;
      }
      units += 1;
    } finally {
      units += 1;
      runtime.auditedUnits += units;
      // This is an explicit bounded retry policy. Continue suppresses a pending
      // attempt failure only when the reviewed policy selects another attempt.
      if (runtime.retryImmediately) continue;
    }
    units += 1;
  }
  runtime.billedUnits += units;
}
