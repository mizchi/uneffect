import { defineRefinement } from "@mizchi/uneffect/spec";
import { createRetryBatchAccounting, observeRetryBatchAccounting, recordConfiguredBatch } from "./retry-batch-accounting.js";

export default defineRefinement({
  name: "retryBatchAccounting",
  version: "1",
  create: createRetryBatchAccounting,
  observe: observeRetryBatchAccounting,
  abstractions: {},
  actions: {
    "recordBatch": recordConfiguredBatch,
  },
  invariants: {},
});
