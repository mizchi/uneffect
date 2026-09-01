import { defineRefinement } from "@mizchi/uneffect/spec";
import { composeScalarHandlers, createScalarHandlerState, observeScalarHandlerState } from "./scalar-handler-join.js";

export default defineRefinement({
  name: "scalarHandlerJoin",
  version: "1",
  create: createScalarHandlerState,
  observe: observeScalarHandlerState,
  abstractions: {},
  actions: {
    "compose": composeScalarHandlers,
  },
  invariants: {},
});
