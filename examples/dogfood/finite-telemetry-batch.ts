/* uneffect:refinement_from "./finite-telemetry-batch.uneffect.ts#default" */
/* uneffect:state sentUnits: int */ /* uneffect:state finalized: int */ /* uneffect:state stopAfter: int */ /* uneffect:init sentUnits = 0 */ /* uneffect:init finalized = 0 */ /* uneffect:init stopAfter = 0 */ /* uneffect:action sendBatch: sentUnits' = stopAfter === 1 ? sentUnits + 1 : stopAfter === 2 ? sentUnits + 1 + 2 : sentUnits + 1 + 2 + 4, finalized' = stopAfter === 1 ? finalized + 1 : stopAfter === 2 ? finalized + 1 + 1 : finalized + 1 + 1 + 1 */ /* uneffect:always finalizationBounded: finalized <= 3 */

export interface TelemetryBatchAccounting {
  sentUnits: number;
  finalized: number;
  stopAfter: number;
}

export function createTelemetryBatch(initial: TelemetryBatchAccounting): TelemetryBatchAccounting {
  return initial;
}

export function observeTelemetryBatch(runtime: TelemetryBatchAccounting): TelemetryBatchAccounting {
  return runtime;
}

export function sendTelemetryBatch(runtime: TelemetryBatchAccounting): void {
  // A production sender would associate these finite weights with three
  // statically configured sinks. The accounting transition is runtime-free.
  const accounting = runtime;
  for (const units of [1, 2, 4] as const) {
    try {
      accounting.sentUnits += units;
      if (accounting.stopAfter === units) return;
    } finally {
      accounting.finalized++;
    }
  }
}

export function finalizationBounded(runtime: TelemetryBatchAccounting): boolean {
  return runtime.finalized <= 3;
}
