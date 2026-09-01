import type { ImportedTelemetryRuntime } from "./imported-telemetry-runtime.js";

/* uneffect:state sent: int */ /* uneffect:state attempted: int */ /* uneffect:init sent = 0 */ /* uneffect:init attempted = 0 */ /* uneffect:action record: sent' = sent + 1, attempted' = attempted + 1 */ /* uneffect:always accounting: sent <= attempted */

/* uneffect:refinement refinement importedTelemetry@1 create */
export function createImportedTelemetry(initial: ImportedTelemetryRuntime): ImportedTelemetryRuntime {
  return initial;
}

/* uneffect:refinement refinement importedTelemetry@1 observe */
export function observeImportedTelemetry(runtime: ImportedTelemetryRuntime): ImportedTelemetryRuntime {
  return runtime;
}

/* uneffect:refinement refinement importedTelemetry@1 action record */
export function recordImportedTelemetry(runtime: ImportedTelemetryRuntime): void {
  const accounting = runtime;
  accounting.record();
}

/* uneffect:refinement refinement importedTelemetry@1 invariant accounting */
export function importedTelemetryAccounting(runtime: ImportedTelemetryRuntime): boolean {
  return runtime.sent <= runtime.attempted;
}
