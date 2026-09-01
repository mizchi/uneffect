import { defineRefinement } from "@mizchi/uneffect/spec";
import { create, drain, observe } from "./cfg-round-robin-drain.js";

export default defineRefinement({
  name: "cfgRoundRobinDrain",
  version: "1",
  create: create,
  observe: observe,
  abstractions: {},
  actions: {
    "drain": drain,
  },
  invariants: {},
});
