import type { Expression } from "oxc-parser";
import type { LogicExpression } from "./logic-contracts.js";

export type NativeScalar =
  | { readonly expression: LogicExpression; readonly kind: "boolean" }
  | { readonly expression: LogicExpression; readonly kind: "number"; readonly minimum: bigint; readonly maximum: bigint };
const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
const bodyOperators = new Map([
  ["===", "eq"], ["!==", "neq"], ["&&", "and"], ["||", "or"],
  ["+", "add"], ["-", "sub"], ["*", "mul"], ["<", "lt"], ["<=", "lte"], [">", "gt"], [">=", "gte"],
]);

/** Bounds use BigInt so the check itself cannot round an overflowing intermediate. */
export function nativeInteger(expression: LogicExpression, minimum: bigint, maximum = minimum): NativeScalar {
  if (minimum < -maximumSafe || maximum > maximumSafe || minimum > maximum) {
    throw new Error("native numeric expression may exceed the safe integer range");
  }
  return { kind: "number", expression, minimum, maximum };
}

/** The same sort and intermediate-range checks apply to source bodies and clauses. */
export function checkNativeScalar(expression: LogicExpression, variables: ReadonlyMap<string, NativeScalar>): NativeScalar {
  if (expression.kind === "variable") {
    const value = variables.get(expression.name);
    if (!value) throw new Error(`unknown native contract variable ${expression.name}`);
    return { ...value, expression };
  }
  if (expression.kind === "boolean") return { kind: "boolean", expression };
  if (expression.kind === "integer" && /^-?\d+$/u.test(expression.value)) return nativeInteger(expression, BigInt(expression.value));
  if (expression.kind === "unary") {
    const value = checkNativeScalar(expression.operand, variables);
    if (expression.operator === "not" && value.kind === "boolean") return { kind: "boolean", expression };
    if (expression.operator === "negate" && value.kind === "number") return nativeInteger(expression, -value.maximum, -value.minimum);
  }
  if (expression.kind === "binary") {
    const left = checkNativeScalar(expression.left, variables), right = checkNativeScalar(expression.right, variables);
    if (left.kind === right.kind && ["eq", "neq"].includes(expression.operator)) return { kind: "boolean", expression };
    if (left.kind === "boolean" && right.kind === "boolean" && ["and", "or"].includes(expression.operator)) return { kind: "boolean", expression };
    if (left.kind === "number" && right.kind === "number") {
      if (["lt", "lte", "gt", "gte"].includes(expression.operator)) return { kind: "boolean", expression };
      if (expression.operator === "add") return nativeInteger(expression, left.minimum + right.minimum, left.maximum + right.maximum);
      if (expression.operator === "sub") return nativeInteger(expression, left.minimum - right.maximum, left.maximum - right.minimum);
      if (expression.operator === "mul") {
        const products = [left.minimum * right.minimum, left.minimum * right.maximum, left.maximum * right.minimum, left.maximum * right.maximum];
        return nativeInteger(expression, products.reduce((a, b) => a < b ? a : b), products.reduce((a, b) => a > b ? a : b));
      }
    }
  }
  throw new Error("unsupported native scalar expression or mismatched sorts");
}

/** No coercion, calls, assertions, properties, division, or remainder in this fragment. */
export function nativeBodyExpression(node: Expression): LogicExpression {
  if (node.type === "ParenthesizedExpression") return nativeBodyExpression(node.expression);
  if (node.type === "Identifier") return { kind: "variable", name: node.name };
  if (node.type === "Literal") {
    if (typeof node.value === "boolean") return { kind: "boolean", value: node.value };
    if (typeof node.value === "number" && Number.isSafeInteger(node.value)) return { kind: "integer", value: String(node.value) };
  }
  if (node.type === "UnaryExpression" && (node.operator === "!" || node.operator === "-")) {
    return { kind: "unary", operator: node.operator === "!" ? "not" : "negate", operand: nativeBodyExpression(node.argument) };
  }
  if ((node.type === "BinaryExpression" || node.type === "LogicalExpression") && node.left.type !== "PrivateIdentifier") {
    const operator = bodyOperators.get(node.operator);
    if (operator) return { kind: "binary", operator, left: nativeBodyExpression(node.left), right: nativeBodyExpression(node.right) };
  }
  throw new Error(`native contract body does not support ${node.type}`);
}

export function hasNumericExpression(expression: LogicExpression): boolean {
  return expression.kind === "integer" || expression.kind === "real"
    || expression.kind === "unary" && hasNumericExpression(expression.operand)
    || expression.kind === "binary" && (hasNumericExpression(expression.left) || hasNumericExpression(expression.right));
}
