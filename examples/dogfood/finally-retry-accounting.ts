/* uneffect:refinement_from "./finally-retry-accounting.uneffect.ts#default" */
/* uneffect:state billedUnits: int */ /* uneffect:state auditedUnits: int */ /* uneffect:state deliveryFailed: bool */ /* uneffect:state retryImmediately: bool */ /* uneffect:init billedUnits = 0 */ /* uneffect:init auditedUnits = 0 */ /* uneffect:init deliveryFailed = false */ /* uneffect:init retryImmediately = false */ /* uneffect:action recordBatch: billedUnits' = deliveryFailed ? (retryImmediately ? billedUnits + 7 : billedUnits) : billedUnits + (retryImmediately ? 5 : 7), auditedUnits' = auditedUnits + (deliveryFailed ? (retryImmediately ? 11 : 4) : (retryImmediately ? 8 : 9)) */

export interface FinallyRetryAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  retryImmediately: boolean;
}

export function createFinallyRetryAccounting(initial: FinallyRetryAccounting): FinallyRetryAccounting {
  return initial;
}

export function observeFinallyRetryAccounting(runtime: FinallyRetryAccounting): FinallyRetryAccounting {
  return runtime;
}

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
