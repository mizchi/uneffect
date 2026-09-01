/* uneffect:refinement_from "./finally-override-accounting.uneffect.ts#default" */
/* uneffect:state billedUnits: int */ /* uneffect:state auditedUnits: int */ /* uneffect:state deliveryFailed: bool */ /* uneffect:state shutdownRequested: bool */ /* uneffect:init billedUnits = 0 */ /* uneffect:init auditedUnits = 0 */ /* uneffect:init deliveryFailed = false */ /* uneffect:init shutdownRequested = false */ /* uneffect:action recordDelivery: billedUnits' = deliveryFailed || shutdownRequested ? billedUnits : billedUnits + 3, auditedUnits' = auditedUnits + (deliveryFailed ? 4 : 3) */

export interface DeliveryAccounting {
  billedUnits: number;
  auditedUnits: number;
  deliveryFailed: boolean;
  shutdownRequested: boolean;
}

export function createDeliveryAccounting(initial: DeliveryAccounting): DeliveryAccounting {
  return initial;
}

export function observeDeliveryAccounting(runtime: DeliveryAccounting): DeliveryAccounting {
  return runtime;
}

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
