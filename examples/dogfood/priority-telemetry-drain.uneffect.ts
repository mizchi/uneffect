import { defineRefinement } from "@mizchi/uneffect/spec";
import { createPriorityTelemetryBacklog, drainPriorityTelemetryBacklog, observePriorityTelemetryBacklog } from "./priority-telemetry-drain.js";

export default defineRefinement({
  name: "priorityTelemetry",
  version: "1",
  create: createPriorityTelemetryBacklog,
  observe: observePriorityTelemetryBacklog,
  abstractions: {},
  actions: {
    "drain": drainPriorityTelemetryBacklog,
  },
  invariants: {},
});
