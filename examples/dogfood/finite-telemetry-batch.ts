/* uneffect:
 * state sentUnits: int
 * state finalized: int
 * state stopAfter: int
 * init sentUnits = 0
 * init finalized = 0
 * init stopAfter = 0
 * action sendBatch: sentUnits' = stopAfter === 1 ? sentUnits + 1 : stopAfter === 2 ? sentUnits + 1 + 2 : sentUnits + 1 + 2 + 4, finalized' = stopAfter === 1 ? finalized + 1 : stopAfter === 2 ? finalized + 1 + 1 : finalized + 1 + 1 + 1
 * temporal finalizationBounded: finalized <= 3
 */

export interface TelemetryBatchAccounting {
  sentUnits: number;
  finalized: number;
  stopAfter: number;
}

/* uneffect: refinement telemetryBatch@1 create */
export function createTelemetryBatch(initial: TelemetryBatchAccounting): TelemetryBatchAccounting {
  return initial;
}

/* uneffect: refinement telemetryBatch@1 observe */
export function observeTelemetryBatch(runtime: TelemetryBatchAccounting): TelemetryBatchAccounting {
  return runtime;
}

/* uneffect: refinement telemetryBatch@1 action sendBatch */
export function sendTelemetryBatch(runtime: TelemetryBatchAccounting): void {
  // A production sender would associate these finite weights with three
  // statically configured sinks. The accounting transition is runtime-free.
  for (const units of [1, 2, 4] as const) {
    try {
      runtime.sentUnits += units;
      if (runtime.stopAfter === units) return;
    } finally {
      runtime.finalized++;
    }
  }
}

/* uneffect: refinement telemetryBatch@1 invariant finalizationBounded */
export function finalizationBounded(runtime: TelemetryBatchAccounting): boolean {
  return runtime.finalized <= 3;
}
