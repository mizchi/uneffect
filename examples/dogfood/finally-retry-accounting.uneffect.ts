import { defineRefinement } from "@mizchi/uneffect/spec";
import { createFinallyRetryAccounting, observeFinallyRetryAccounting, recordConfiguredRetries } from "./finally-retry-accounting.js";

export default defineRefinement({
  name: "finallyRetryAccounting",
  version: "1",
  create: createFinallyRetryAccounting,
  observe: observeFinallyRetryAccounting,
  abstractions: {},
  actions: {
    "recordBatch": recordConfiguredRetries,
  },
  invariants: {},
});
