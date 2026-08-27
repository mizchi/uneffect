/* uneffect:
 * state billedUnits: int
 * state auditedUnits: int
 * state outcome: int
 * init billedUnits = 0
 * init auditedUnits = 0
 * init outcome = 0
 * action billBatch: billedUnits' = outcome === 3 ? billedUnits : billedUnits + (outcome === 4 ? 8 : (outcome === 2 ? 4 : (outcome === 1 ? 13 : 14))), auditedUnits' = auditedUnits + ((outcome === 2 || outcome === 3 || outcome === 4) ? 6 : (outcome === 1 ? 27 : 30))
 */

export interface BatchBilling {
  billedUnits: number;
  auditedUnits: number;
  outcome: number;
}

/* uneffect: refinement boundedBatchBilling@1 create */
export function createBatchBilling(initial: BatchBilling): BatchBilling {
  return initial;
}

/* uneffect: refinement boundedBatchBilling@1 observe */
export function observeBatchBilling(runtime: BatchBilling): BatchBilling {
  return runtime;
}

/* uneffect: refinement boundedBatchBilling@1 action billBatch */
export function billConfiguredBatch(runtime: BatchBilling): void {
  let units = 0;
  try {
    // These weights stand for four statically configured telemetry sinks.
    for (const sinkWeight of [1, 2, 3, 4] as const) {
      try {
        units += sinkWeight;
        if (runtime.outcome === 1 && sinkWeight === 2) continue;
        if (runtime.outcome === 2 && sinkWeight === 2) break;
        if (runtime.outcome === 3 && sinkWeight === 2) return;
        if (runtime.outcome === 4 && sinkWeight === 2) throw units;
        {
          const perSinkOverhead = 1;
          units += perSinkOverhead;
        }
      } finally {
        runtime.auditedUnits += units;
      }
    }
  } catch (failedUnits) {
    runtime.billedUnits += units + failedUnits;
    return;
  }
  runtime.billedUnits += units;
}
