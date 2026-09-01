/* uneffect:refinement_from "./imported-runtime-refinement.uneffect.ts#default" */
import type { ImportedTelemetryRuntime } from "./imported-telemetry-runtime.js";

/* uneffect:state sent: int */ /* uneffect:state attempted: int */ /* uneffect:init sent = 0 */ /* uneffect:init attempted = 0 */ /* uneffect:action record: sent' = sent + 1, attempted' = attempted + 1 */ /* uneffect:always accounting: sent <= attempted */

export function createImportedTelemetry(initial: ImportedTelemetryRuntime): ImportedTelemetryRuntime {
  return initial;
}

export function observeImportedTelemetry(runtime: ImportedTelemetryRuntime): ImportedTelemetryRuntime {
  return runtime;
}

export function recordImportedTelemetry(runtime: ImportedTelemetryRuntime): void {
  const accounting = runtime;
  accounting.record();
}

export function importedTelemetryAccounting(runtime: ImportedTelemetryRuntime): boolean {
  return runtime.sent <= runtime.attempted;
}
