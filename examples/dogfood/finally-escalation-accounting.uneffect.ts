import { defineRefinement } from "@mizchi/uneffect/spec";
import { createEscalationAccounting, observeEscalationAccounting, recoverDelivery } from "./finally-escalation-accounting.js";

export default defineRefinement({
  name: "finallyEscalationAccounting",
  version: "1",
  create: createEscalationAccounting,
  observe: observeEscalationAccounting,
  abstractions: {},
  actions: {
    "recoverDelivery": recoverDelivery,
  },
  invariants: {},
});
