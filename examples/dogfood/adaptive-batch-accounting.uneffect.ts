import { defineRefinement } from "@mizchi/uneffect/spec";
import { createAdaptiveBatchAccounting, observeAdaptiveBatchAccounting, recordAdaptiveBatch } from "./adaptive-batch-accounting.js";

export default defineRefinement({
  name: "adaptiveBatchAccounting",
  version: "1",
  create: createAdaptiveBatchAccounting,
  observe: observeAdaptiveBatchAccounting,
  abstractions: {},
  actions: {
    "record": recordAdaptiveBatch,
  },
  invariants: {},
});
