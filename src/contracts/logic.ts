import { parseOxcExpression } from "../frontends/oxc/expression.js";
import type { Expression } from "oxc-parser";
import type { LogicExpression } from "./logic-contracts.js";

const operators = new Map<string, string>([
  ["+", "add"], ["-", "sub"], ["*", "mul"], ["<", "lt"], ["<=", "lte"], [">", "gt"], [">=", "gte"],
  ["==", "eq"], ["===", "eq"], ["!=", "neq"], ["!==", "neq"], ["&&", "and"], ["||", "or"],
]);

function parse(text: string, allowJavaScriptRemainder: boolean): LogicExpression {
  const { expression, source } = parseOxcExpression(text, "invariant");
  const convert = (node: Expression): LogicExpression => {
    if (node.type === "ParenthesizedExpression" || node.type === "TSAsExpression" || node.type === "TSTypeAssertion" || node.type === "TSNonNullExpression") return convert(node.expression);
    if (node.type === "Identifier") return { kind: "variable", name: node.name };
    if (node.type === "Literal") {
      if (typeof node.value === "number" && Number.isFinite(node.value)) {
        const value = String(node.value);
        return { kind: value.includes(".") ? "real" : "integer", value };
      }
      if (typeof node.value === "boolean") return { kind: "boolean", value: node.value };
    }
    if (node.type === "UnaryExpression") {
      if (node.operator === "!") return { kind: "unary", operator: "not", operand: convert(node.argument) };
      if (node.operator === "-") return { kind: "unary", operator: "negate", operand: convert(node.argument) };
    }
    if ((node.type === "BinaryExpression" || node.type === "LogicalExpression") && node.left.type !== "PrivateIdentifier") {
      const operator = allowJavaScriptRemainder && node.operator === "%" ? "js-rem" : operators.get(node.operator);
      if (operator) return { kind: "binary", operator, left: convert(node.left), right: convert(node.right) };
    }
    throw new Error(`unsupported invariant expression: ${source.slice(node.start, node.end)}`);
  };
  return convert(expression);
}

export function parseLogicExpression(text: string): LogicExpression { return parse(text, false); }

/** Parses scalar refinements for test-data hints without treating JavaScript `%` as SMT modulo. */
export function parseLogicExpressionForHints(text: string): LogicExpression { return parse(text, true); }
/** Decides small, purely-boolean implications over the same IR emitted to Z3. */
export function proveBooleanImplication(assumptionSources: string[], goalSource: string): boolean {
  try {
    const assumptions = assumptionSources.map(parseLogicExpression), goal = parseLogicExpression(goalSource);
    const names = new Set<string>();
    const collect = (expression: LogicExpression): void => {
      if (expression.kind === "variable") names.add(expression.name);
      else if (expression.kind === "unary") collect(expression.operand);
      else if (expression.kind === "binary") { collect(expression.left); collect(expression.right); }
    };
    [...assumptions, goal].forEach(collect);
    if (names.size > 12) return false;
    const variables = [...names];
    const evaluate = (expression: LogicExpression, values: Map<string, boolean>): boolean => {
      if (expression.kind === "boolean") return expression.value;
      if (expression.kind === "variable") return values.get(expression.name)!;
      if (expression.kind === "unary" && expression.operator === "not") return !evaluate(expression.operand, values);
      if (expression.kind === "binary" && expression.operator === "and") return evaluate(expression.left, values) && evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "or") return evaluate(expression.left, values) || evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "eq") return evaluate(expression.left, values) === evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "neq") return evaluate(expression.left, values) !== evaluate(expression.right, values);
      throw new Error("non-boolean ownership guard");
    };
    for (let bits = 0; bits < 2 ** variables.length; bits++) {
      const values = new Map(variables.map((name, index) => [name, Boolean(bits & (1 << index))]));
      if (assumptions.every((item) => evaluate(item, values)) && !evaluate(goal, values)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
