import type { FlowJoinOptions } from "./contracts.js";

/**
 * Join two normal control-flow predecessors over bindings visible at their
 * common dominator. Branch-local bindings are intentionally absent from keys.
 */
export function joinFlowValues<Key, Value, Condition>(
  options: FlowJoinOptions<Key, Value, Condition>,
): ReadonlyMap<Key, Value> {
  const joined = new Map<Key, Value>();
  for (const key of options.keys) {
    const original = options.original(key);
    const whenTrue = options.whenTrue(key) ?? original;
    const whenFalse = options.whenFalse(key) ?? original;
    joined.set(key, options.equivalent(whenTrue, whenFalse)
      ? whenTrue
      : options.phi(options.condition, whenTrue, whenFalse));
  }
  return joined;
}
