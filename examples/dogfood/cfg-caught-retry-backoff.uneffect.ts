import { defineRefinement } from "@mizchi/uneffect/spec";
import { createRetryRuntime, observeRetryRuntime, retryWithCaughtBackoff } from "./cfg-caught-retry-backoff.js";

export default defineRefinement({
  name: "caughtRetryBackoff",
  version: "1",
  create: createRetryRuntime,
  observe: observeRetryRuntime,
  abstractions: {},
  actions: {
    "retry": retryWithCaughtBackoff,
  },
  invariants: {},
});
