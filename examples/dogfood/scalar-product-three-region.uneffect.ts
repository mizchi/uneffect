import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
import {
  composeThreeRegionAccounting,
  createThreeRegionAccountingState,
  observeThreeRegionAccountingState,
} from "./scalar-product-three-region.js";

export default defineRefinement({
  name: "scalarProductThreeRegion",
  version: "1",
  create: createThreeRegionAccountingState,
  observe: observeThreeRegionAccountingState,
  abstractions: {
    total: identityProjection("total"),
    audited: identityProjection("audited"),
    first: identityProjection("first"),
    second: identityProjection("second"),
    third: identityProjection("third"),
  },
  actions: { compose: composeThreeRegionAccounting },
  invariants: {},
});
