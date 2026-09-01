import { defineRefinement } from "@mizchi/uneffect/spec";
import { createLocalAlias, observeLocalAlias, sendThroughLocalAlias } from "./local-alias-refinement.js";

export default defineRefinement({
  name: "localAlias",
  version: "1",
  create: createLocalAlias,
  observe: observeLocalAlias,
  abstractions: {},
  actions: {
    "send": sendThroughLocalAlias,
  },
  invariants: {},
});
