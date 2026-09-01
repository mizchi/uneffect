import { defineRefinement } from "@mizchi/uneffect/spec";
import { create, drain, observe } from "./cfg-piecewise-drain.js";

export default defineRefinement({
  name: "cfgPiecewiseDrain",
  version: "1",
  create: create,
  observe: observe,
  abstractions: {},
  actions: {
    "drain": drain,
  },
  invariants: {},
});
