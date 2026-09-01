import { defineRefinement } from "@mizchi/uneffect/spec";
import { createTelemetryBacklog, drainTelemetryBacklog, observeTelemetryBacklog } from "./telemetry-backlog-drain.js";

export default defineRefinement({
  name: "telemetryBacklog",
  version: "1",
  create: createTelemetryBacklog,
  observe: observeTelemetryBacklog,
  abstractions: {},
  actions: {
    "drain": drainTelemetryBacklog,
  },
  invariants: {},
});
