import type { LogicExpression } from "./logic-contracts.js";

/** A constant or one occurrence of a variable with coefficient +1/-1. */
export interface NativeAffineTerm {
  readonly name?: string;
  readonly sign: 1 | -1;
  readonly offset: bigint;
}
const negate = (sign: 1 | -1): 1 | -1 => sign === 1 ? -1 : 1;

/** Only for already checked expressions: normalization does not establish JS arithmetic safety. */
export function nativeAffineTerm(expression: LogicExpression): NativeAffineTerm | undefined {
  if (expression.kind === "variable") return { name: expression.name, sign: 1, offset: 0n };
  if (expression.kind === "integer" && /^-?\d+$/u.test(expression.value)) return { sign: 1, offset: BigInt(expression.value) };
  if (expression.kind === "unary" && expression.operator === "negate") {
    const operand = nativeAffineTerm(expression.operand);
    return operand && { ...operand, sign: negate(operand.sign), offset: -operand.offset };
  }
  if (expression.kind !== "binary" || (expression.operator !== "add" && expression.operator !== "sub")) return undefined;
  const left = nativeAffineTerm(expression.left), right = nativeAffineTerm(expression.right);
  if (!left || !right || (left.name !== undefined && right.name !== undefined)) return undefined;
  const subtract = expression.operator === "sub";
  return {
    ...(left.name !== undefined ? { name: left.name } : right.name !== undefined ? { name: right.name } : {}),
    sign: left.name !== undefined ? left.sign : subtract ? negate(right.sign) : right.sign,
    offset: left.offset + (subtract ? -right.offset : right.offset),
  };
}
