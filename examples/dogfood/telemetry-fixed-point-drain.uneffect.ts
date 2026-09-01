import { defineRefinement } from "@mizchi/uneffect/spec";
import { createTelemetryDrain, drainTelemetry, observeTelemetryDrain } from "./telemetry-fixed-point-drain.js";

export default defineRefinement({
  name: "telemetryFixedPoint",
  version: "1",
  create: createTelemetryDrain,
  observe: observeTelemetryDrain,
  abstractions: {},
  actions: {
    "drain": drainTelemetry,
  },
  invariants: {},
});
