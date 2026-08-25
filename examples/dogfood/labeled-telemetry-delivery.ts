/* uneffect:
 * state delivered: int
 * state finalized: int
 * state audited: int
 * state skip: bool
 * init delivered = 0
 * init finalized = 0
 * init audited = 0
 * init skip = false
 * action deliver: delivered' = skip ? delivered : delivered + 1, finalized' = finalized + 1, audited' = audited + 1
 */

export interface DeliveryAccounting {
  delivered: number;
  finalized: number;
  audited: number;
  skip: boolean;
}

/* uneffect: refinement labeledDelivery@1 create */
export function createDelivery(initial: DeliveryAccounting): DeliveryAccounting {
  return initial;
}

/* uneffect: refinement labeledDelivery@1 observe */
export function observeDelivery(runtime: DeliveryAccounting): DeliveryAccounting {
  return runtime;
}

/* uneffect: refinement labeledDelivery@1 action deliver */
export function deliver(runtime: DeliveryAccounting): void {
  attempt: {
    try {
      if (runtime.skip) break attempt;
      runtime.delivered++;
    } finally {
      runtime.finalized++;
    }
  }
  runtime.audited++;
}
