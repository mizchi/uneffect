/* uneffect:
 * state billedUnits: int
 * state auditedUnits: int
 * state deliveryFailed: bool
 * state shutdownRequested: bool
 * init billedUnits = 0
 * init auditedUnits = 0
 * init deliveryFailed = false
 * init shutdownRequested = false
 * action recordDelivery: billedUnits' = deliveryFailed || shutdownRequested ? billedUnits : billedUnits + 3, auditedUnits' = auditedUnits + (deliveryFailed ? 4 : 3)
 */

export interface DeliveryAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  shutdownRequested: boolean;
}

/* uneffect: refinement finallyOverrideAccounting@1 create */
export function createDeliveryAccounting(initial: DeliveryAccounting): DeliveryAccounting {
  return initial;
}

/* uneffect: refinement finallyOverrideAccounting@1 observe */
export function observeDeliveryAccounting(runtime: DeliveryAccounting): DeliveryAccounting {
  return runtime;
}

/* uneffect: refinement finallyOverrideAccounting@1 action recordDelivery */
export function recordDelivery(runtime: DeliveryAccounting): void {
  let units = 1;
  try {
    try {
      if (runtime.deliveryFailed) {
        units += 2;
        throw 1;
      }
      units += 1;
    } finally {
      units += 1;
      // This explicitly models a shutdown policy that suppresses a pending
      // failure. Returning from finally is not presented as a recommended API.
      if (runtime.shutdownRequested) return;
    }
  } finally {
    runtime.auditedUnits += units;
  }
  runtime.billedUnits += units;
}
