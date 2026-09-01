import { defineRefinement } from "@mizchi/uneffect/spec";
import { createRethrowBatchAccounting, observeRethrowBatchAccounting, recordRethrowBatch } from "./rethrow-batch-accounting.js";

export default defineRefinement({
  name: "rethrowBatchAccounting",
  version: "1",
  create: createRethrowBatchAccounting,
  observe: observeRethrowBatchAccounting,
  abstractions: {},
  actions: {
    "record": recordRethrowBatch,
  },
  invariants: {},
});
