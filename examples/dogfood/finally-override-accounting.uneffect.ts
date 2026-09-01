import { defineRefinement } from "@mizchi/uneffect/spec";
import { createDeliveryAccounting, observeDeliveryAccounting, recordDelivery } from "./finally-override-accounting.js";

export default defineRefinement({
  name: "finallyOverrideAccounting",
  version: "1",
  create: createDeliveryAccounting,
  observe: observeDeliveryAccounting,
  abstractions: {},
  actions: {
    "recordDelivery": recordDelivery,
  },
  invariants: {},
});
