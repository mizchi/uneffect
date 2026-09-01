import { defineRefinement } from "@mizchi/uneffect/spec";
import { createLeaseRuntime, observeLeaseRuntime, renewLeaseEpoch, takeoverLease } from "./lease-projection.js";

export default defineRefinement({
  name: "leaseProjection",
  version: "1",
  create: createLeaseRuntime,
  observe: observeLeaseRuntime,
  abstractions: {},
  actions: {
    "renew": renewLeaseEpoch,
    "takeover": takeoverLease,
  },
  invariants: {},
});
