import { defineRefinement } from "@mizchi/uneffect/spec";
import { createPausedTelemetryBacklog, drainPausedTelemetryBacklog, observePausedTelemetryBacklog } from "./paused-telemetry-drain.js";

export default defineRefinement({
  name: "pausedTelemetry",
  version: "1",
  create: createPausedTelemetryBacklog,
  observe: observePausedTelemetryBacklog,
  abstractions: {},
  actions: {
    "drain": drainPausedTelemetryBacklog,
  },
  invariants: {},
});
