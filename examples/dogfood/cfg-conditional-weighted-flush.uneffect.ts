import { defineRefinement } from "@mizchi/uneffect/spec";
import { create, flush, observe } from "./cfg-conditional-weighted-flush.js";

export default defineRefinement({
  name: "cfgConditionalWeightedFlush",
  version: "1",
  create: create,
  observe: observe,
  abstractions: {},
  actions: {
    "flush": flush,
  },
  invariants: {},
});
