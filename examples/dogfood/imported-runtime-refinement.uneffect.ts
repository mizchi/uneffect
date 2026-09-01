import { defineRefinement } from "@mizchi/uneffect/spec";
import { createImportedTelemetry, importedTelemetryAccounting, observeImportedTelemetry, recordImportedTelemetry } from "./imported-runtime-refinement.js";

export default defineRefinement({
  name: "importedTelemetry",
  version: "1",
  create: createImportedTelemetry,
  observe: observeImportedTelemetry,
  abstractions: {},
  actions: {
    "record": recordImportedTelemetry,
  },
  invariants: {
    "accounting": importedTelemetryAccounting,
  },
});
