import type { ParsedSpec, TemporalSpec } from "./spec-ir.js";
import type { TemporalExpression } from "./temporal-expressions.js";
import { parseSpec } from "./spec-ir.js";

export interface SpecLintDiagnostic {
  code: "tautological-invariant" | "contradictory-invariant" | "state-independent-invariant" | "no-op-action";
  name: string;
  message: string;
}

function same(left: TemporalExpression, right: TemporalExpression): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function constantBoolean(expression: TemporalExpression): boolean | undefined {
  if (expression.kind === "boolean") return expression.value;
  if (expression.kind === "unary" && expression.operator === "not") {
    const value = constantBoolean(expression.operand);
    return value === undefined ? undefined : !value;
  }
  if (expression.kind !== "binary") return undefined;
  if (expression.operator === "eq" && same(expression.left, expression.right)) return true;
  if (expression.operator === "neq" && same(expression.left, expression.right)) return false;
  if ((expression.operator === "lte" || expression.operator === "gte") && same(expression.left, expression.right)) return true;
  if ((expression.operator === "lt" || expression.operator === "gt") && same(expression.left, expression.right)) return false;
  const left = constantBoolean(expression.left), right = constantBoolean(expression.right);
  if (expression.operator === "and" && left !== undefined && right !== undefined) return left && right;
  if (expression.operator === "or" && left !== undefined && right !== undefined) return left || right;
  return undefined;
}

function referencedNames(expression: TemporalExpression, names = new Set<string>()): Set<string> {
  if (expression.kind === "name") names.add(expression.name);
  else if (expression.kind === "unary") referencedNames(expression.operand, names);
  else if (expression.kind === "binary") { referencedNames(expression.left, names); referencedNames(expression.right, names); }
  return names;
}

export function lintTemporalSpec(spec: TemporalSpec): SpecLintDiagnostic[] {
  const diagnostics: SpecLintDiagnostic[] = [];
  const stateNames = new Set(spec.states.map((state) => state.name));
  for (const property of [...spec.properties, ...spec.liveness]) {
    const constant = constantBoolean(property.expressionAst);
    if (constant !== undefined) diagnostics.push({
      code: constant ? "tautological-invariant" : "contradictory-invariant",
      name: property.name,
      message: `${property.name} is statically ${constant}; it does not constrain reachable states`,
    });
    else if (![...referencedNames(property.expressionAst)].some((name) => stateNames.has(name))) diagnostics.push({
      code: "state-independent-invariant", name: property.name,
      message: `${property.name} does not reference temporal state`,
    });
  }
  for (const action of spec.actions) if (action.assignments.length > 0
    && action.assignments.every((assignment) => assignment.expressionAst.kind === "name" && assignment.expressionAst.name === assignment.target)) {
    diagnostics.push({ code: "no-op-action", name: action.name, message: `${action.name} only assigns each state variable to itself` });
  }
  return diagnostics;
}

export function lintSpec(fileName: string, text: string): { spec: ParsedSpec; diagnostics: SpecLintDiagnostic[] } {
  const spec = parseSpec(fileName, text);
  return { spec, diagnostics: lintTemporalSpec(spec.temporal) };
}
