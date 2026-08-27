/* uneffect:
 * state recoveredUnits: int
 * state auditedUnits: int
 * state failed: bool
 * init recoveredUnits = 0
 * init auditedUnits = 0
 * init failed = false
 * action record: recoveredUnits' = recoveredUnits + (failed ? 8 : 2), auditedUnits' = auditedUnits + (failed ? 4 : 2)
 */

export interface RethrowBatchAccounting {
  recoveredUnits: number;
  auditedUnits: number;
  failed: boolean;
}

/* uneffect: refinement rethrowBatchAccounting@1 create */
export function createRethrowBatchAccounting(initial: RethrowBatchAccounting): RethrowBatchAccounting {
  return initial;
}

/* uneffect: refinement rethrowBatchAccounting@1 observe */
export function observeRethrowBatchAccounting(runtime: RethrowBatchAccounting): RethrowBatchAccounting {
  return runtime;
}

/* uneffect: refinement rethrowBatchAccounting@1 action record */
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
      throw units;
    } finally {
      runtime.auditedUnits += units;
    }
  } catch (recoveryUnits) {
    runtime.recoveredUnits += units + recoveryUnits;
    return;
  }
  runtime.recoveredUnits += units;
}
