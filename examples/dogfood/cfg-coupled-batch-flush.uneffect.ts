import { defineRefinement } from "@mizchi/uneffect/spec";
import { create, flush, observe } from "./cfg-coupled-batch-flush.js";

export default defineRefinement({
  name: "cfgCoupledBatchFlush",
  version: "1",
  create: create,
  observe: observe,
  abstractions: {},
  actions: {
    "flush": flush,
  },
  invariants: {},
});
