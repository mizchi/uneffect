/**
 * Standalone JavaScript for finite, acyclic temporal values. Embedded as a named
 * function expression so recursion and local names cannot capture caller bindings.
 * Set equality is extensional, including duplicate structurally equal JS objects.
 * Map keys are the scalar keys admitted by the temporal type checker.
 */
export const temporalRuntimeEquality = `function equal(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set && right instanceof Set)) return false;
    const a = [...left], b = [...right];
    return a.every(value => b.some(other => equal(value, other))) && b.every(value => a.some(other => equal(value, other)));
  }
  if (left instanceof Map || right instanceof Map) {
    return left instanceof Map && right instanceof Map && left.size === right.size
      && [...left].every(([key, value]) => right.has(key) && equal(value, right.get(key)));
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equal(value, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}`;
