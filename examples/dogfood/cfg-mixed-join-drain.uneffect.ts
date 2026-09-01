import { defineRefinement } from "@mizchi/uneffect/spec";
import { createCfgMixedJoinDrain, drainCfgMixedJoin, observeCfgMixedJoinDrain } from "./cfg-mixed-join-drain.js";

export default defineRefinement({
  name: "cfgMixedJoinDrain",
  version: "1",
  create: createCfgMixedJoinDrain,
  observe: observeCfgMixedJoinDrain,
  abstractions: {},
  actions: {
    "drain": drainCfgMixedJoin,
  },
  invariants: {},
});
