/* uneffect:temporal state attempted: int */ /* uneffect:temporal state finalized: int */ /* uneffect:temporal state audited: int */ /* uneffect:temporal state throttledBatch: int */ /* uneffect:temporal init attempted = 0 */ /* uneffect:temporal init finalized = 0 */ /* uneffect:temporal init audited = 0 */ /* uneffect:temporal init throttledBatch = 0 */ /* uneffect:temporal action flush: attempted' = throttledBatch === 1 || throttledBatch === 2 || throttledBatch === 3 ? attempted + 5 : attempted + 6, finalized' = finalized + 3, audited' = throttledBatch === 1 || throttledBatch === 2 || throttledBatch === 3 ? audited + 2 : audited + 3 */

export interface TelemetryScanState {
  attempted: number;
  finalized: number;
  audited: number;
  throttledBatch: number;
}

/* uneffect:refinement refinement nestedTelemetryScan@1 create */
export function createTelemetryScan(initial: TelemetryScanState): TelemetryScanState {
  return initial;
}

/* uneffect:refinement refinement nestedTelemetryScan@1 observe */
export function observeTelemetryScan(runtime: TelemetryScanState): TelemetryScanState {
  return runtime;
}

/* uneffect:refinement refinement nestedTelemetryScan@1 action flush */
export function flushTelemetry(runtime: TelemetryScanState): void {
  batch: for (let batchIndex = 0; batchIndex < 3; batchIndex++) {
    try {
      for (let endpointIndex = 0; endpointIndex < 2; endpointIndex++) {
        runtime.attempted++;
        if (runtime.throttledBatch === batchIndex + 1) continue batch;
      }
    } finally {
      runtime.finalized++;
    }
    runtime.audited++;
  }
}
