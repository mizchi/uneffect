import { defineRefinement } from "@mizchi/uneffect/spec";
import { createCircuitBreakerTelemetryBacklog, drainCircuitBreakerTelemetryBacklog, observeCircuitBreakerTelemetryBacklog } from "./circuit-breaker-telemetry-drain.js";

export default defineRefinement({
  name: "circuitBreakerTelemetry",
  version: "1",
  create: createCircuitBreakerTelemetryBacklog,
  observe: observeCircuitBreakerTelemetryBacklog,
  abstractions: {},
  actions: {
    "drain": drainCircuitBreakerTelemetryBacklog,
  },
  invariants: {},
});
