import { defineRefinement, setFromArrayProjection } from "@mizchi/uneffect/spec";
import {
  allSubscriberIdsPositive,
  clearSubscribers,
  createRoutingState,
  hasSubscribers,
  observeRoutingState,
  primarySubscribed,
  subscribeFallback,
  unsubscribePrimary,
} from "./renamed-routing-state.js";

export default defineRefinement({
  name: "routingState",
  version: "1",
  create: createRoutingState,
  observe: observeRoutingState,
  abstractions: {
    subscribers: setFromArrayProjection("routing.activeSubscriberIds"),
  },
  actions: { subscribeFallback, unsubscribePrimary, clearSubscribers },
  invariants: { primarySubscribed, hasSubscribers, allSubscriberIdsPositive },
});
