import { defineRefinement } from "@mizchi/uneffect/spec";
import { createFinallyCircuitAccounting, observeFinallyCircuitAccounting, recordConfiguredAttempt } from "./finally-circuit-break-accounting.js";

export default defineRefinement({
  name: "finallyCircuitBreakAccounting",
  version: "1",
  create: createFinallyCircuitAccounting,
  observe: observeFinallyCircuitAccounting,
  abstractions: {},
  actions: {
    "recordAttempt": recordConfiguredAttempt,
  },
  invariants: {},
});
