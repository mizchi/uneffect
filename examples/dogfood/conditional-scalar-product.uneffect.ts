import { defineRefinement } from "@mizchi/uneffect/spec";
import { composeRoutedAccounting, createRoutedAccountingState, observeRoutedAccountingState } from "./conditional-scalar-product.js";

export default defineRefinement({
  name: "conditionalScalarProduct",
  version: "1",
  create: createRoutedAccountingState,
  observe: observeRoutedAccountingState,
  abstractions: {},
  actions: {
    "compose": composeRoutedAccounting,
  },
  invariants: {},
});
