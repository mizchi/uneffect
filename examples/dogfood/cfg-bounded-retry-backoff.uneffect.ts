import { defineRefinement } from "@mizchi/uneffect/spec";
import { backoff, create, observe } from "./cfg-bounded-retry-backoff.js";

export default defineRefinement({
  name: "boundedRetryBackoff",
  version: "1",
  create: create,
  observe: observe,
  abstractions: {},
  actions: {
    "backoff": backoff,
  },
  invariants: {},
});
