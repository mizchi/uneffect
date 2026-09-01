import { defineRefinement } from "@mizchi/uneffect/spec";
import { composeScalarProductHandlers, createScalarProductHandlerState, observeScalarProductHandlerState } from "./scalar-product-handler-join.js";

export default defineRefinement({
  name: "scalarProductJoin",
  version: "1",
  create: createScalarProductHandlerState,
  observe: observeScalarProductHandlerState,
  abstractions: {},
  actions: {
    "compose": composeScalarProductHandlers,
  },
  invariants: {},
});
