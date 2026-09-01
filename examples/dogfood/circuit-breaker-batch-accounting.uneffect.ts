import { defineRefinement } from "@mizchi/uneffect/spec";
import { createBatchAccounting, observeBatchAccounting, recordConfiguredAttempt } from "./circuit-breaker-batch-accounting.js";

export default defineRefinement({
  name: "circuitBreakerBatchAccounting",
  version: "1",
  create: createBatchAccounting,
  observe: observeBatchAccounting,
  abstractions: {},
  actions: {
    "recordAttempt": recordConfiguredAttempt,
  },
  invariants: {},
});
