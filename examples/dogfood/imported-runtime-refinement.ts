import type { ImportedTelemetryRuntime } from "./imported-telemetry-runtime.js";

/* uneffect:
 * state sent: int
 * state attempted: int
 * init sent = 0
 * init attempted = 0
 * action record: sent' = sent + 1, attempted' = attempted + 1
 * temporal accounting: sent <= attempted
 */

/* uneffect: refinement importedTelemetry@1 create */
export function createImportedTelemetry(initial: ImportedTelemetryRuntime): ImportedTelemetryRuntime {
  return initial;
}

/* uneffect: refinement importedTelemetry@1 observe */
export function observeImportedTelemetry(runtime: ImportedTelemetryRuntime): ImportedTelemetryRuntime {
  return runtime;
}

/* uneffect: refinement importedTelemetry@1 action record */
export function recordImportedTelemetry(runtime: ImportedTelemetryRuntime): void {
  const accounting = runtime;
  accounting.record();
}

/* uneffect: refinement importedTelemetry@1 invariant accounting */
export function importedTelemetryAccounting(runtime: ImportedTelemetryRuntime): boolean {
  return runtime.sent <= runtime.attempted;
}
