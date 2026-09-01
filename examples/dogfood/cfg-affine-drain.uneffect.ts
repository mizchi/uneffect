import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
import { create, drain, observe } from "./cfg-affine-drain.js";

export default defineRefinement({
  name: "cfgAffineDrain",
  version: "1",
  create,
  observe,
  abstractions: {
    pending: identityProjection("pending"),
    processed: identityProjection("processed"),
  },
  actions: { drain },
  invariants: {},
});
