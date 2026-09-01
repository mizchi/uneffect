import { defineRefinement } from "@mizchi/uneffect/spec";
import { createFailingTelemetryBacklog, drainFailingTelemetryBacklog, observeFailingTelemetryBacklog } from "./failing-telemetry-drain.js";

export default defineRefinement({
  name: "failingTelemetry",
  version: "1",
  create: createFailingTelemetryBacklog,
  observe: observeFailingTelemetryBacklog,
  abstractions: {},
  actions: {
    "drain": drainFailingTelemetryBacklog,
  },
  invariants: {},
});
