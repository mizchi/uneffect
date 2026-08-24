import type { DiagnosticNote } from "./diagnostics.js";
import { parseLogicExpression, type InvariantObligation, type LogicExpression } from "./invariant-ir.js";

/** Exact value domain of the contract IR: rationals cover Int and Real models without rounding. */
export type LogicValue = { kind: "number"; numerator: bigint; denominator: bigint } | { kind: "boolean"; value: boolean };
export type LogicModel = ReadonlyMap<string, LogicValue>;

const operatorText: Readonly<Record<string, string>> = {
  add: "+", sub: "-", mul: "*", div: "/", mod: "%", lt: "<", lte: "<=", gt: ">", gte: ">=",
  eq: "==", neq: "!=", and: "&&", or: "||",
};
const precedence: Readonly<Record<string, number>> = {
  or: 1, and: 2, eq: 3, neq: 3, lt: 4, lte: 4, gt: 4, gte: 4, add: 5, sub: 5, mul: 6, div: 6, mod: 6,
};
const comparisons = new Set(["lt", "lte", "gt", "gte", "eq", "neq"]);

function gcd(left: bigint, right: bigint): bigint {
  let [a, b] = [left < 0n ? -left : left, right < 0n ? -right : right];
  while (b) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function rational(numerator: bigint, denominator: bigint): LogicValue {
  const sign = denominator < 0n ? -1n : 1n, divisor = gcd(numerator, denominator);
  return { kind: "number", numerator: (sign * numerator) / divisor, denominator: (sign * denominator) / divisor };
}

export function formatValue(value: LogicValue): string {
  if (value.kind === "boolean") return String(value.value);
  return value.denominator === 1n ? String(value.numerator) : `${value.numerator}/${value.denominator}`;
}

/** Parse one Z3 model term: `3`, `(- 3)`, `(/ 1 2)`, `(- (/ 1 2))`, `true`. */
export function parseModelValue(text: string): LogicValue | undefined {
  const source = text.trim();
  if (source === "true" || source === "false") return { kind: "boolean", value: source === "true" };
  if (/^-?\d+$/u.test(source)) return rational(BigInt(source), 1n);
  if (/^-?\d+\.\d+$/u.test(source)) {
    const [whole, fraction] = source.split(".") as [string, string];
    const scale = 10n ** BigInt(fraction.length), digits = BigInt(`${whole.replace("-", "")}${fraction}`);
    return rational(source.startsWith("-") ? -digits : digits, scale);
  }
  const negated = /^\(-\s+(.+)\)$/u.exec(source);
  if (negated) {
    const inner = parseModelValue(negated[1]!);
    return inner?.kind === "number" ? rational(-inner.numerator, inner.denominator) : undefined;
  }
  const fraction = /^\(\/\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/u.exec(source);
  if (fraction) {
    const left = parseModelValue(fraction[1]!), right = parseModelValue(fraction[2]!);
    return left?.kind === "number" && right?.kind === "number" && right.numerator !== 0n
      ? rational(left.numerator * right.denominator, left.denominator * right.numerator) : undefined;
  }
  return undefined;
}

export function parseModel(assignments: Readonly<Record<string, string>>): LogicModel {
  const model = new Map<string, LogicValue>();
  for (const [name, text] of Object.entries(assignments)) {
    const value = parseModelValue(text);
    if (value) model.set(name, value);
  }
  return model;
}

/** Evaluate an IR expression under a model; `undefined` means the value is outside the exact domain. */
export function evaluateLogic(expression: LogicExpression, model: LogicModel): LogicValue | undefined {
  if (expression.kind === "variable") return model.get(expression.name);
  if (expression.kind === "integer") return rational(BigInt(expression.value), 1n);
  if (expression.kind === "real") return parseModelValue(expression.value);
  if (expression.kind === "boolean") return { kind: "boolean", value: expression.value };
  if (expression.kind === "unary") {
    const operand = evaluateLogic(expression.operand, model);
    if (!operand) return undefined;
    if (expression.operator === "not") return operand.kind === "boolean" ? { kind: "boolean", value: !operand.value } : undefined;
    return operand.kind === "number" ? rational(-operand.numerator, operand.denominator) : undefined;
  }
  const left = evaluateLogic(expression.left, model);
  if (!left) return undefined;
  if (expression.operator === "and" || expression.operator === "or") {
    const right = evaluateLogic(expression.right, model);
    if (left.kind !== "boolean" || right?.kind !== "boolean") return undefined;
    return { kind: "boolean", value: expression.operator === "and" ? left.value && right.value : left.value || right.value };
  }
  const right = evaluateLogic(expression.right, model);
  if (!right) return undefined;
  if (left.kind === "boolean" || right.kind === "boolean") {
    if (left.kind !== "boolean" || right.kind !== "boolean") return undefined;
    if (expression.operator === "eq") return { kind: "boolean", value: left.value === right.value };
    if (expression.operator === "neq") return { kind: "boolean", value: left.value !== right.value };
    return undefined;
  }
  const cross = { left: left.numerator * right.denominator, right: right.numerator * left.denominator };
  switch (expression.operator) {
    case "add": return rational(cross.left + cross.right, left.denominator * right.denominator);
    case "sub": return rational(cross.left - cross.right, left.denominator * right.denominator);
    case "mul": return rational(left.numerator * right.numerator, left.denominator * right.denominator);
    case "div": return right.numerator === 0n ? undefined : rational(left.numerator * right.denominator, left.denominator * right.numerator);
    case "mod": return left.denominator === 1n && right.denominator === 1n && right.numerator !== 0n
      ? rational(((left.numerator % right.numerator) + (right.numerator < 0n ? -right.numerator : right.numerator)) % (right.numerator < 0n ? -right.numerator : right.numerator), 1n) : undefined;
    case "lt": return { kind: "boolean", value: cross.left < cross.right };
    case "lte": return { kind: "boolean", value: cross.left <= cross.right };
    case "gt": return { kind: "boolean", value: cross.left > cross.right };
    case "gte": return { kind: "boolean", value: cross.left >= cross.right };
    case "eq": return { kind: "boolean", value: cross.left === cross.right };
    case "neq": return { kind: "boolean", value: cross.left !== cross.right };
    default: return undefined;
  }
}

/** Render the IR back as TypeScript-like source so a report never shows SMT-LIB. */
export function formatLogic(expression: LogicExpression, displayNames: Readonly<Record<string, string>> = {}, outer = 0): string {
  if (expression.kind === "variable") return displayNames[expression.name] ?? expression.name;
  if (expression.kind === "integer" || expression.kind === "real") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") {
    const operand = formatLogic(expression.operand, displayNames, 7);
    return `${expression.operator === "not" ? "!" : "-"}${operand}`;
  }
  const level = precedence[expression.operator] ?? 0;
  const text = `${formatLogic(expression.left, displayNames, level)} ${operatorText[expression.operator] ?? expression.operator} ${formatLogic(expression.right, displayNames, level + 1)}`;
  return level < outer ? `(${text})` : text;
}

/** Render a proposition with its arithmetic already evaluated, e.g. `x - 1 > x` as `-1 > 0`. */
export function formatEvaluated(expression: LogicExpression, model: LogicModel, displayNames: Readonly<Record<string, string>> = {}, outer = 0): string {
  if (expression.kind === "binary" && (comparisons.has(expression.operator) || expression.operator === "and" || expression.operator === "or")) {
    const level = precedence[expression.operator] ?? 0;
    const text = `${formatEvaluated(expression.left, model, displayNames, level)} ${operatorText[expression.operator]} ${formatEvaluated(expression.right, model, displayNames, level + 1)}`;
    return level < outer ? `(${text})` : text;
  }
  if (expression.kind === "unary" && expression.operator === "not") return `!${formatEvaluated(expression.operand, model, displayNames, 7)}`;
  const value = evaluateLogic(expression, model);
  return value ? formatValue(value) : formatLogic(expression, displayNames, outer);
}

/** First conjunct that the model falsifies, so a compound clause names the half that broke. */
export function failingConjunct(expression: LogicExpression, model: LogicModel): LogicExpression | undefined {
  if (expression.kind === "binary" && expression.operator === "and") {
    return failingConjunct(expression.left, model) ?? failingConjunct(expression.right, model);
  }
  const value = evaluateLogic(expression, model);
  return value?.kind === "boolean" && !value.value ? expression : undefined;
}

function referencedNames(expression: LogicExpression, into: Set<string>): Set<string> {
  if (expression.kind === "variable") into.add(expression.name);
  else if (expression.kind === "unary") referencedNames(expression.operand, into);
  else if (expression.kind === "binary") { referencedNames(expression.left, into); referencedNames(expression.right, into); }
  return into;
}

function clauseLabel(obligation: InvariantObligation): string {
  return obligation.kind === "postcondition" ? "ensures" : "invariant";
}

/** Restate an obligation as the property the reader must believe, not as a solver verdict. */
export function describeObligation(obligation: InvariantObligation): string {
  const clause = `\`${clauseLabel(obligation)} ${obligation.source}\``;
  if (obligation.kind === "postcondition") return `${clause} can fail on this return`;
  if (obligation.kind === "loop-init") return `${clause} is not established before the loop runs`;
  return `${clause} is not preserved by one iteration of the loop body`;
}

/** The proof rule the failed obligation comes from, stated in words. */
export function obligationRule(obligation: InvariantObligation): string {
  if (obligation.kind === "postcondition") return "every input allowed by requires must leave this return with ensures true";
  if (obligation.kind === "loop-init") return "the invariant must already hold the first time the loop is reached";
  return "an iteration that starts with the invariant and the loop guard true must end with the invariant true";
}

/** Pair the failing conjunct of the lowered goal with the same position in the written clause. */
function clauseView(obligation: InvariantObligation, failing: LogicExpression): LogicExpression | undefined {
  let written: LogicExpression;
  try {
    written = parseLogicExpression(obligation.source);
  } catch {
    return undefined;
  }
  const find = (goal: LogicExpression, clause: LogicExpression): LogicExpression | undefined => {
    if (goal === failing) return clause;
    if (goal.kind === "binary" && clause.kind === "binary" && goal.operator === clause.operator) {
      return find(goal.left, clause.left) ?? find(goal.right, clause.right);
    }
    if (goal.kind === "unary" && clause.kind === "unary" && goal.operator === clause.operator) return find(goal.operand, clause.operand);
    return undefined;
  };
  return find(obligation.goal, written);
}

/**
 * Turn a raw Z3 counterexample into notes a reader can follow: concrete inputs, the values
 * every source-level name takes, the assumptions that still hold, and the check that fails.
 */
export function explainCounterexample(obligation: InvariantObligation, assignments: Readonly<Record<string, string>>): DiagnosticNote[] {
  const model = parseModel(assignments), notes: DiagnosticNote[] = [];
  const display = obligation.displayNames;
  const used = referencedNames(obligation.goal, new Set<string>());
  for (const assumption of obligation.assumptions) referencedNames(assumption, used);
  for (const binding of obligation.bindings) referencedNames(binding.expression, used);
  const inputs = obligation.variables
    .filter((item) => used.has(item.name))
    .map((item) => `${display[item.name] ?? item.name} = ${model.has(item.name) ? formatValue(model.get(item.name)!) : "any value"}`);
  if (inputs.length > 0) notes.push({ label: "counterexample", detail: inputs.join(", ") });

  const bindings = obligation.bindings.map((binding) => {
    const value = evaluateLogic(binding.expression, model), expression = formatLogic(binding.expression, display);
    if (!value) return `${binding.name} = ${expression}`;
    const evaluated = formatValue(value);
    return expression === evaluated ? `${binding.name} = ${evaluated}` : `${binding.name} = ${expression} = ${evaluated}`;
  });
  if (bindings.length > 0) notes.push({ label: "state", detail: bindings.join(", ") });

  const assumed = obligation.assumptions
    .map((assumption) => `${formatLogic(assumption, display)} (${formatEvaluated(assumption, model, display)})`)
    .filter((text, index, all) => all.indexOf(text) === index);
  if (assumed.length > 0) notes.push({ label: "still holds", detail: assumed.join(", ") });

  const failing = failingConjunct(obligation.goal, model) ?? obligation.goal;
  const evaluated = formatEvaluated(failing, model, display);
  const written = clauseView(obligation, failing) ?? failing;
  const detail = failing === obligation.goal
    ? `${clauseLabel(obligation)} ${obligation.source} evaluates to ${evaluated}, which is false`
    : `${clauseLabel(obligation)} ${obligation.source} breaks at ${formatLogic(written, display)}, which evaluates to ${evaluated}`;
  notes.push({ label: "fails", detail });
  return notes;
}
