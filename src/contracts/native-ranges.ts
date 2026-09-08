import type { LogicExpression } from "./logic-contracts.js";
import type { NativeScalar } from "./native-scalars.js";
import { nativeAffineTerm, type NativeAffineTerm } from "./native-affine.js";

const opposite: Readonly<Record<string, string>> = { eq: "neq", neq: "eq", lt: "gte", lte: "gt", gt: "lte", gte: "lt" };
const reversed: Readonly<Record<string, string>> = { eq: "eq", neq: "neq", lt: "gt", lte: "gte", gt: "lt", gte: "lte" };
interface Interval { readonly minimum: bigint; readonly maximum: bigint }
const min = (left: bigint, right: bigint): bigint => left < right ? left : right;
const max = (left: bigint, right: bigint): bigint => left > right ? left : right;

/** Project a comparison onto one operand, keeping all satisfying pairs. */
function restrictInterval(value: Interval, other: Interval, operator: string): Interval {
  switch (operator) {
    case "eq": return { minimum: max(value.minimum, other.minimum), maximum: min(value.maximum, other.maximum) };
    case "lt": return { ...value, maximum: min(value.maximum, other.maximum - 1n) };
    case "lte": return { ...value, maximum: min(value.maximum, other.maximum) };
    case "gt": return { ...value, minimum: max(value.minimum, other.minimum + 1n) };
    case "gte": return { ...value, minimum: max(value.minimum, other.minimum) };
    case "neq":
      // A non-singleton right operand does not exclude any particular left value.
      if (other.minimum !== other.maximum) return value;
      return { minimum: value.minimum + (value.minimum === other.minimum ? 1n : 0n),
        maximum: value.maximum - (value.maximum === other.minimum ? 1n : 0n) };
    default: return value;
  }
}

function satisfies(left: bigint, right: bigint, operator: string): boolean {
  switch (operator) {
    case "eq": return left === right; case "neq": return left !== right;
    case "lt": return left < right; case "lte": return left <= right;
    case "gt": return left > right; case "gte": return left >= right;
    default: return true;
  }
}

/** Overapproximate ranges under already checked assumptions; never validates a condition using itself.
 * Revisit at most 16 times to propagate chains. Partial results remain conservative, even for cycles.
 * Disjunctions and contradictory intervals stay conservative. Exact finite membership remains in SMT.
 */
export function narrowNativeRanges(variables: ReadonlyMap<string, NativeScalar>, conditions: readonly LogicExpression[]): ReadonlyMap<string, NativeScalar> {
  const narrowed = new Map(variables);
  let changed = false;
  const range = (term: NativeAffineTerm): Interval | undefined => {
    if (term.name === undefined) return { minimum: term.offset, maximum: term.offset };
    const value = narrowed.get(term.name);
    if (value?.kind !== "number") return undefined;
    return term.sign === 1
      ? { minimum: value.minimum + term.offset, maximum: value.maximum + term.offset }
      : { minimum: term.offset - value.maximum, maximum: term.offset - value.minimum };
  };
  const update = (term: NativeAffineTerm, candidate: Interval, operator?: string, otherTerm?: NativeAffineTerm): void => {
    if (term.name === undefined) return;
    const value = narrowed.get(term.name);
    if (value?.kind !== "number") return;
    const inverse = term.sign === 1
      ? { minimum: candidate.minimum - term.offset, maximum: candidate.maximum - term.offset }
      : { minimum: term.offset - candidate.maximum, maximum: term.offset - candidate.minimum };
    // Intersect with current state too: both operands may name the same variable.
    const minimum = max(value.minimum, inverse.minimum), maximum = min(value.maximum, inverse.maximum);
    if (minimum > maximum || (minimum === value.minimum && maximum === value.maximum)) return;
    const otherValue = otherTerm?.name === undefined ? undefined : narrowed.get(otherTerm.name);
    const values = value.values && operator && otherTerm && (otherTerm.name === undefined || otherValue?.kind === "number")
      ? value.values.filter((item) => {
        const other: readonly bigint[] = otherTerm.name === undefined ? [otherTerm.offset]
          : otherValue?.kind === "number" ? otherValue.values ?? [otherValue.minimum, otherValue.maximum] : [];
        return other.some((candidate) => satisfies(term.sign === 1 ? item + term.offset : term.offset - item,
          otherTerm.sign === 1 ? candidate + otherTerm.offset : otherTerm.offset - candidate, operator));
      }) : undefined;
    narrowed.set(term.name, { ...value, minimum, maximum, ...(values ? { values: Object.freeze(values) } : {}) });
    changed = true;
  };
  const apply = (condition: LogicExpression, truth = true): void => {
    if (condition.kind === "unary" && condition.operator === "not") { apply(condition.operand, !truth); return; }
    if (condition.kind !== "binary") return;
    if ((condition.operator === "and" && truth) || (condition.operator === "or" && !truth)) {
      apply(condition.left, truth); apply(condition.right, truth); return;
    }
    const operator = truth ? condition.operator : opposite[condition.operator];
    if (!operator || !Object.hasOwn(reversed, operator)) return;
    const leftTerm = nativeAffineTerm(condition.left), rightTerm = nativeAffineTerm(condition.right);
    if (!leftTerm || !rightTerm) return;
    const left = range(leftTerm), right = range(rightTerm);
    if (!left || !right) return;
    update(leftTerm, restrictInterval(left, right, operator), operator, rightTerm);
    update(rightTerm, restrictInterval(right, left, reversed[operator]!), reversed[operator], leftTerm);
  };
  for (let pass = 0; pass < 16; pass++) {
    changed = false;
    for (const condition of conditions) apply(condition);
    if (!changed) break;
  }
  return narrowed;
}
