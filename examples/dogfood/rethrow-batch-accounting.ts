/* uneffect:refinement_from "./rethrow-batch-accounting.uneffect.ts#default" */
/* uneffect:state recoveredUnits: int */ /* uneffect:state auditedUnits: int */ /* uneffect:state failed: bool */ /* uneffect:state escalate: bool */ /* uneffect:init recoveredUnits = 0 */ /* uneffect:init auditedUnits = 0 */ /* uneffect:init failed = false */ /* uneffect:init escalate = false */ /* uneffect:action record: recoveredUnits' = recoveredUnits + (failed ? (escalate ? 8 : 6) : 2), auditedUnits' = auditedUnits + (failed ? (escalate ? 4 : 6) : 2) */

export interface RethrowBatchAccounting {
  recoveredUnits: number;
  auditedUnits: number;
  failed: boolean;
  escalate: boolean;
}

export function createRethrowBatchAccounting(initial: RethrowBatchAccounting): RethrowBatchAccounting {
  return initial;
}

export function observeRethrowBatchAccounting(runtime: RethrowBatchAccounting): RethrowBatchAccounting {
  return runtime;
}

export function recordRethrowBatch(runtime: RethrowBatchAccounting): void {
  let units = 1;
  try {
    try {
      if (runtime.failed) {
        units += 2;
        throw 1;
      }
      units += 1;
    } catch (validationUnits) {
      // Normalize the low-level validation charge before propagating it to the
      // batch recovery boundary. The rethrow carries both this payload and the
      // mutated local snapshot through the audit finally block.
      units += validationUnits;
      if (runtime.escalate) throw units;
      units += 2;
    } finally {
      runtime.auditedUnits += units;
    }
  } catch (recoveryUnits) {
    runtime.recoveredUnits += units + recoveryUnits;
    return;
  }
  runtime.recoveredUnits += units;
}
