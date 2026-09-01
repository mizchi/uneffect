import { defineRefinement } from "@mizchi/uneffect/spec";
import { createTelemetryBatch, finalizationBounded, observeTelemetryBatch, sendTelemetryBatch } from "./finite-telemetry-batch.js";

export default defineRefinement({
  name: "telemetryBatch",
  version: "1",
  create: createTelemetryBatch,
  observe: observeTelemetryBatch,
  abstractions: {},
  actions: {
    "sendBatch": sendTelemetryBatch,
  },
  invariants: {
    "finalizationBounded": finalizationBounded,
  },
});
