/* uneffect:temporal state delivered: int */ /* uneffect:temporal state finalized: int */ /* uneffect:temporal state audited: int */ /* uneffect:temporal state charged: int */ /* uneffect:temporal state skip: bool */ /* uneffect:temporal init delivered = 0 */ /* uneffect:temporal init finalized = 0 */ /* uneffect:temporal init audited = 0 */ /* uneffect:temporal init charged = 0 */ /* uneffect:temporal init skip = false */ /* uneffect:temporal action deliver: delivered' = skip ? delivered : delivered + 1, finalized' = finalized + 1, audited' = audited + 1, charged' = skip ? charged + 3 : charged + 5 */

export interface DeliveryAccounting {
  delivered: number;
  finalized: number;
  audited: number;
  charged: number;
  skip: boolean;
}

/* uneffect:refinement refinement labeledDelivery@1 create */
export function createDelivery(initial: DeliveryAccounting): DeliveryAccounting {
  return initial;
}

/* uneffect:refinement refinement labeledDelivery@1 observe */
export function observeDelivery(runtime: DeliveryAccounting): DeliveryAccounting {
  return runtime;
}

/* uneffect:refinement refinement labeledDelivery@1 action deliver */
export function deliver(runtime: DeliveryAccounting): void {
  let units = 1;
  attempt: {
    try {
      {
        const delivery = runtime;
        units += 2;
        if (delivery.skip) {
          break attempt;
          delivery.delivered += 100; // unreachable after the local completion
        }
        units += 2;
        delivery.delivered++;
      }
    } finally {
      runtime.finalized++;
    }
  }
  runtime.audited++;
  runtime.charged += units;
}
