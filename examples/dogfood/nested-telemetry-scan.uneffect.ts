import { defineRefinement } from "@mizchi/uneffect/spec";
import { createTelemetryScan, flushTelemetry, observeTelemetryScan } from "./nested-telemetry-scan.js";

export default defineRefinement({
  name: "nestedTelemetryScan",
  version: "1",
  create: createTelemetryScan,
  observe: observeTelemetryScan,
  abstractions: {},
  actions: {
    "flush": flushTelemetry,
  },
  invariants: {},
});
