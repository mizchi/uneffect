import { defineRefinement } from "@mizchi/uneffect/spec";
import { create, flush, observe } from "./cfg-entry-read-batch-flush.js";

export default defineRefinement({
  name: "cfgEntryReadBatchFlush",
  version: "1",
  create: create,
  observe: observe,
  abstractions: {},
  actions: {
    "flush": flush,
  },
  invariants: {},
});
