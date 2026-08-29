/* uneffect:temporal state subscribers: Set<int> */ /* uneffect:temporal init subscribers = Set(1) */ /* uneffect:temporal action subscribeFallback: subscribers' = subscribers.union(Set(2)) */ /* uneffect:temporal action unsubscribePrimary: subscribers' = subscribers.exclude(Set(1)) */ /* uneffect:temporal action clearSubscribers: subscribers' = Set() */ /* uneffect:temporal invariant primarySubscribed: subscribers.contains(1) */ /* uneffect:temporal invariant hasSubscribers: subscribers.size() > 0 */ /* uneffect:temporal invariant allSubscriberIdsPositive: subscribers.forall(id => id > 0) */ /* uneffect:refinement abstraction routingState@1 subscribers = Set(routing.activeSubscriberIds) */

export interface RoutingModelState {
  subscribers: Set<number>;
}

export interface RoutingRuntime {
  routing: { activeSubscriberIds: number[] };
}

/* uneffect:refinement refinement routingState@1 create */
export function createRoutingState(initial: RoutingModelState): RoutingRuntime {
  return { routing: { activeSubscriberIds: Array.from(initial.subscribers) } };
}

/* uneffect:refinement refinement routingState@1 observe */
export function observeRoutingState(runtime: RoutingRuntime): RoutingModelState {
  return { subscribers: new Set(runtime.routing.activeSubscriberIds) };
}

/* uneffect:refinement refinement routingState@1 action subscribeFallback */
export function subscribeFallback(runtime: RoutingRuntime): void {
  runtime.routing.activeSubscriberIds.push(2);
}

/* uneffect:refinement refinement routingState@1 action unsubscribePrimary */
export function unsubscribePrimary(runtime: RoutingRuntime): void {
  const primaryId = 1;
  runtime.routing.activeSubscriberIds = runtime.routing.activeSubscriberIds.filter((id) => {
    return id !== primaryId;
  });
}

/* uneffect:refinement refinement routingState@1 action clearSubscribers */
export function clearSubscribers(runtime: RoutingRuntime): void {
  runtime.routing.activeSubscriberIds.length = 0;
}

/* uneffect:refinement refinement routingState@1 invariant primarySubscribed */
export function primarySubscribed(runtime: RoutingRuntime): boolean {
  return runtime.routing.activeSubscriberIds.some((id) => {
    return id === 1;
  });
}

/* uneffect:refinement refinement routingState@1 invariant hasSubscribers */
export function hasSubscribers(runtime: RoutingRuntime): boolean {
  return runtime.routing.activeSubscriberIds.length > 0;
}

/* uneffect:refinement refinement routingState@1 invariant allSubscriberIdsPositive */
export function allSubscriberIdsPositive(runtime: RoutingRuntime): boolean {
  return runtime.routing.activeSubscriberIds.every((id) => {
    const minimum = 0;
    return id > minimum;
  });
}
