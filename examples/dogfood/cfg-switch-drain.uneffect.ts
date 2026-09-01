import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
import { createCfgSwitchDrain, drainCfgSwitch, observeCfgSwitchDrain } from "./cfg-switch-drain.js";

export default defineRefinement({
  name: "cfgSwitchDrain",
  version: "1",
  create: createCfgSwitchDrain,
  observe: observeCfgSwitchDrain,
  abstractions: {
    pending: identityProjection("pending"),
    processed: identityProjection("processed"),
    mode: identityProjection("mode"),
  },
  actions: { drain: drainCfgSwitch },
  invariants: {},
});
