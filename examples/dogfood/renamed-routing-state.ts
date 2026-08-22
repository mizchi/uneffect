/* uneffect:
  state subscribers: Set<int>
  init subscribers = Set(1)
  action subscribeFallback: subscribers' = subscribers.union(Set(2))
  temporal primarySubscribed: subscribers.contains(1)
  abstraction routingState@1 subscribers = routing.activeSubscriberIds
*/

export interface RoutingModelState {
  subscribers: Set<number>;
}

export interface RoutingRuntime {
  routing: { activeSubscriberIds: Set<number> };
}

/* uneffect: refinement routingState@1 create */
export function createRoutingState(initial: RoutingModelState): RoutingRuntime {
  return { routing: { activeSubscriberIds: initial.subscribers } };
}

/* uneffect: refinement routingState@1 observe */
export function observeRoutingState(runtime: RoutingRuntime): RoutingModelState {
  return { subscribers: runtime.routing.activeSubscriberIds };
}

/* uneffect: refinement routingState@1 action subscribeFallback */
export function subscribeFallback(runtime: RoutingRuntime): void {
  runtime.routing.activeSubscriberIds.add(2);
}

/* uneffect: refinement routingState@1 invariant primarySubscribed */
export function primarySubscribed(runtime: RoutingRuntime): boolean {
  return runtime.routing.activeSubscriberIds.has(1);
}
