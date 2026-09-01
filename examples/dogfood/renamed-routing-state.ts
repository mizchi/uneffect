/* uneffect:state subscribers: Set<int> */ /* uneffect:init subscribers = Set(1) */ /* uneffect:action subscribeFallback: subscribers' = subscribers.union(Set(2)) */ /* uneffect:action unsubscribePrimary: subscribers' = subscribers.exclude(Set(1)) */ /* uneffect:action clearSubscribers: subscribers' = Set() */ /* uneffect:always primarySubscribed: subscribers.contains(1) */ /* uneffect:always hasSubscribers: subscribers.size() > 0 */ /* uneffect:always allSubscriberIdsPositive: subscribers.forall(id => id > 0) */
/* uneffect:refinement_from "./renamed-routing-state.uneffect.ts#default" */

export interface RoutingModelState {
  subscribers: Set<number>;
}

export interface RoutingRuntime {
  routing: { activeSubscriberIds: number[] };
}

export function createRoutingState(initial: RoutingModelState): RoutingRuntime {
  return { routing: { activeSubscriberIds: Array.from(initial.subscribers) } };
}

export function observeRoutingState(runtime: RoutingRuntime): RoutingModelState {
  return { subscribers: new Set(runtime.routing.activeSubscriberIds) };
}

export function subscribeFallback(runtime: RoutingRuntime): void {
  runtime.routing.activeSubscriberIds.push(2);
}

export function unsubscribePrimary(runtime: RoutingRuntime): void {
  const primaryId = 1;
  runtime.routing.activeSubscriberIds = runtime.routing.activeSubscriberIds.filter((id) => {
    return id !== primaryId;
  });
}

export function clearSubscribers(runtime: RoutingRuntime): void {
  runtime.routing.activeSubscriberIds.length = 0;
}

export function primarySubscribed(runtime: RoutingRuntime): boolean {
  return runtime.routing.activeSubscriberIds.some((id) => {
    return id === 1;
  });
}

export function hasSubscribers(runtime: RoutingRuntime): boolean {
  return runtime.routing.activeSubscriberIds.length > 0;
}

export function allSubscriberIdsPositive(runtime: RoutingRuntime): boolean {
  return runtime.routing.activeSubscriberIds.every((id) => {
    const minimum = 0;
    return id > minimum;
  });
}
