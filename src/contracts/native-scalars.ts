import type { Expression } from "oxc-parser";
import type { LogicExpression } from "./logic-contracts.js";
import { narrowNativeRanges } from "./native-ranges.js";

export type NativeScalar =
  | { readonly expression: LogicExpression; readonly kind: "boolean" }
  | { readonly expression: LogicExpression; readonly kind: "number"; readonly minimum: bigint; readonly maximum: bigint; readonly values?: readonly bigint[] };
const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
const bodyOperators = new Map([
  ["===", "eq"], ["!==", "neq"], ["&&", "and"], ["||", "or"],
  ["+", "add"], ["-", "sub"], ["*", "mul"], ["/", "div"], ["%", "mod"], ["<", "lt"], ["<=", "lte"], [">", "gt"], [">=", "gte"],
]);

/** Bounds use BigInt so the check itself cannot round an overflowing intermediate. */
export function nativeInteger(expression: LogicExpression, minimum: bigint, maximum = minimum): NativeScalar {
  if (minimum < -maximumSafe || maximum > maximumSafe || minimum > maximum) {
    throw new Error("native numeric expression may exceed the safe integer range");
  }
  return { kind: "number", expression, minimum, maximum };
}

/** The same sort and intermediate-range checks apply to source bodies and clauses. */
export function checkNativeScalar(expression: LogicExpression, variables: ReadonlyMap<string, NativeScalar>, phase: "structure" | "proof" = "proof"): NativeScalar {
  // CFG construction checks every expression's syntax and sort, including dead code.
  // Arithmetic bounds are checked separately with the conditions at each execution point.
  const integer = (minimum: bigint, maximum: bigint): NativeScalar => phase === "proof"
    ? nativeInteger(expression, minimum, maximum) : { kind: "number", expression, minimum, maximum };
  if (expression.kind === "variable") {
    const value = variables.get(expression.name);
    if (!value) throw new Error(`unknown native contract variable ${expression.name}`);
    return { ...value, expression };
  }
  if (expression.kind === "boolean") return { kind: "boolean", expression };
  if (expression.kind === "integer" && /^-?\d+$/u.test(expression.value)) return nativeInteger(expression, BigInt(expression.value));
  if (expression.kind === "unary") {
    const value = checkNativeScalar(expression.operand, variables, phase);
    if (expression.operator === "not" && value.kind === "boolean") return { kind: "boolean", expression };
    if (expression.operator === "negate" && value.kind === "number") return integer(-value.maximum, -value.minimum);
  }
  if (expression.kind === "binary") {
    const left = checkNativeScalar(expression.left, variables, phase);
    if (left.kind === "boolean" && (expression.operator === "and" || expression.operator === "or")) {
      // Only the already checked left operand can justify the right operand's bounds.
      const evaluatesWhen = expression.operator === "and";
      const condition: LogicExpression = evaluatesWhen ? expression.left : { kind: "unary", operator: "not", operand: expression.left };
      const skipped = expression.left.kind === "boolean" && expression.left.value !== evaluatesWhen;
      const right = checkNativeScalar(expression.right,
        phase === "proof" ? narrowNativeRanges(variables, [condition]) : variables,
        skipped ? "structure" : phase);
      if (right.kind !== "boolean") throw new Error("native logical operands must be Boolean");
      return { kind: "boolean", expression };
    }
    const right = checkNativeScalar(expression.right, variables, phase);
    if (left.kind === right.kind && ["eq", "neq"].includes(expression.operator)) return { kind: "boolean", expression };
    if (left.kind === "number" && right.kind === "number") {
      if (["lt", "lte", "gt", "gte"].includes(expression.operator)) return { kind: "boolean", expression };
      if (expression.operator === "add") return integer(left.minimum + right.minimum, left.maximum + right.maximum);
      if (expression.operator === "sub") return integer(left.minimum - right.maximum, left.maximum - right.minimum);
      if (expression.operator === "mul") {
        const products = [left.minimum * right.minimum, left.minimum * right.maximum, left.maximum * right.minimum, left.maximum * right.maximum];
        return integer(products.reduce((a, b) => a < b ? a : b), products.reduce((a, b) => a > b ? a : b));
      }
      if ((expression.operator === "div" || expression.operator === "mod")
        && right.minimum === right.maximum && right.minimum !== 0n) {
        const values = left.values ?? (left.minimum === left.maximum ? [left.minimum] : undefined);
        const divisors = right.values ?? (right.minimum === right.maximum ? [right.minimum] : undefined);
        if (!values || !divisors) throw new Error("native division requires finite domains");
        if (expression.operator === "mod" && values.length !== 1) throw new Error("native remainder requires a singleton numerator");
        if (divisors.some(value => value === 0n)) throw new Error("native division by zero");
        if (expression.operator === "div" && values.some(value => divisors.some(divisor => value % divisor !== 0n))) {
          throw new Error("native division requires an exact integer result");
        }
        const results = values.flatMap(value => divisors.map(divisor => expression.operator === "div" ? value / divisor : value % divisor));
        return integer(results.reduce((a, b) => a < b ? a : b), results.reduce((a, b) => a > b ? a : b));
      }
    }
  }
  throw new Error("unsupported native scalar expression or mismatched sorts");
}

/** No coercion, assertions, properties, or general division/remainder in this fragment. */
export function nativeBodyExpression(node: Expression, resolveCall?: (node: Extract<Expression, { type: "CallExpression" }>) => LogicExpression | undefined): LogicExpression {
  if (node.type === "ParenthesizedExpression") return nativeBodyExpression(node.expression, resolveCall);
  if (node.type === "Identifier") return { kind: "variable", name: node.name };
  if (node.type === "Literal") {
    if (typeof node.value === "boolean") return { kind: "boolean", value: node.value };
    if (typeof node.value === "number" && Number.isSafeInteger(node.value)) return { kind: "integer", value: String(node.value) };
  }
  if (node.type === "CallExpression" && resolveCall) {
    const resolved = resolveCall(node);
    if (resolved) return resolved;
  }
  if (node.type === "UnaryExpression" && (node.operator === "!" || node.operator === "-" || node.operator === "+")) {
    const operand = nativeBodyExpression(node.argument, resolveCall);
    return node.operator === "+" ? operand : { kind: "unary", operator: node.operator === "!" ? "not" : "negate", operand };
  }
  if ((node.type === "BinaryExpression" || node.type === "LogicalExpression") && node.left.type !== "PrivateIdentifier") {
    const operator = bodyOperators.get(node.operator);
    if (operator) return { kind: "binary", operator, left: nativeBodyExpression(node.left, resolveCall), right: nativeBodyExpression(node.right, resolveCall) };
  }
  throw new Error(`native contract body does not support ${node.type}`);
}

export function hasNumericExpression(expression: LogicExpression): boolean {
  return expression.kind === "integer" || expression.kind === "real"
    || expression.kind === "unary" && hasNumericExpression(expression.operand)
    || expression.kind === "binary" && (hasNumericExpression(expression.left) || hasNumericExpression(expression.right));
}
