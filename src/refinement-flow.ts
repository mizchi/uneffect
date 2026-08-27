export interface FlowJoinOptions<Key, Value, Condition> {
  readonly keys: Iterable<Key>;
  readonly condition: Condition;
  readonly original: (key: Key) => Value;
  readonly whenTrue: (key: Key) => Value | undefined;
  readonly whenFalse: (key: Key) => Value | undefined;
  readonly equivalent: (left: Value, right: Value) => boolean;
  readonly phi: (condition: Condition, whenTrue: Value, whenFalse: Value) => Value;
}

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
