import { defineRefinement } from "@mizchi/uneffect/spec";
import { billConfiguredBatch, createBatchBilling, observeBatchBilling } from "./bounded-batch-billing.js";

export default defineRefinement({
  name: "boundedBatchBilling",
  version: "1",
  create: createBatchBilling,
  observe: observeBatchBilling,
  abstractions: {},
  actions: {
    "billBatch": billConfiguredBatch,
  },
  invariants: {},
});
