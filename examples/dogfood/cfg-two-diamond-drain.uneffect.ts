import { defineRefinement } from "@mizchi/uneffect/spec";
import { createCfgTwoDiamondDrain, drainCfgTwoDiamond, observeCfgTwoDiamondDrain } from "./cfg-two-diamond-drain.js";

export default defineRefinement({
  name: "cfgTwoDiamondDrain",
  version: "1",
  create: createCfgTwoDiamondDrain,
  observe: observeCfgTwoDiamondDrain,
  abstractions: {},
  actions: {
    "drain": drainCfgTwoDiamond,
  },
  invariants: {},
});
