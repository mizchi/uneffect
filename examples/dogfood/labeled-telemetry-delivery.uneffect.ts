import { defineRefinement } from "@mizchi/uneffect/spec";
import { createDelivery, deliver, observeDelivery } from "./labeled-telemetry-delivery.js";

export default defineRefinement({
  name: "labeledDelivery",
  version: "1",
  create: createDelivery,
  observe: observeDelivery,
  abstractions: {},
  actions: {
    "deliver": deliver,
  },
  invariants: {},
});
