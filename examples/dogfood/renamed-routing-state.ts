/* uneffect:
  state subscribers: Set<int>
  init subscribers = Set(1)
  action subscribeFallback: subscribers' = subscribers.union(Set(2))
  temporal primarySubscribed: subscribers.contains(1)
  abstraction routingState@1 subscribers = activeSubscriberIds
*/

export interface RoutingModelState {
  subscribers: Set<number>;
}

export interface RoutingRuntime {
  activeSubscriberIds: Set<number>;
}

/* uneffect: refinement routingState@1 create */
export function createRoutingState(initial: RoutingModelState): RoutingRuntime {
  return { activeSubscriberIds: initial.subscribers };
}

/* uneffect: refinement routingState@1 observe */
export function observeRoutingState(runtime: RoutingRuntime): RoutingModelState {
  return { subscribers: runtime.activeSubscriberIds };
}

/* uneffect: refinement routingState@1 action subscribeFallback */
export function subscribeFallback(runtime: RoutingRuntime): void {
  runtime.activeSubscriberIds.add(2);
}

/* uneffect: refinement routingState@1 invariant primarySubscribed */
export function primarySubscribed(runtime: RoutingRuntime): boolean {
  return runtime.activeSubscriberIds.has(1);
}
