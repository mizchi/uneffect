/* uneffect:refinement_from "./nested-telemetry-scan.uneffect.ts#default" */
/* uneffect:state attempted: int */ /* uneffect:state finalized: int */ /* uneffect:state audited: int */ /* uneffect:state throttledBatch: int */ /* uneffect:init attempted = 0 */ /* uneffect:init finalized = 0 */ /* uneffect:init audited = 0 */ /* uneffect:init throttledBatch = 0 */ /* uneffect:action flush: attempted' = throttledBatch === 1 || throttledBatch === 2 || throttledBatch === 3 ? attempted + 5 : attempted + 6, finalized' = finalized + 3, audited' = throttledBatch === 1 || throttledBatch === 2 || throttledBatch === 3 ? audited + 2 : audited + 3 */

export interface TelemetryScanState {
  attempted: number;
  finalized: number;
  audited: number;
  throttledBatch: number;
}

export function createTelemetryScan(initial: TelemetryScanState): TelemetryScanState {
  return initial;
}

export function observeTelemetryScan(runtime: TelemetryScanState): TelemetryScanState {
  return runtime;
}

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
