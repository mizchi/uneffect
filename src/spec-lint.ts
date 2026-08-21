import type { ParsedSpec, TemporalSpec } from "./spec-ir.js";
import type { TemporalExpression } from "./temporal-expressions.js";
import { parseSpec } from "./spec-ir.js";
import { init as initZ3 } from "z3-solver";
import { createHash } from "node:crypto";
import { createModelCounterexample, type ModelCounterexample, type ModelState } from "./model-replay.js";

export interface SpecLintDiagnostic {
  code: "tautological-invariant" | "contradictory-invariant" | "state-independent-invariant" | "no-op-action"
    | "solver-tautology" | "solver-contradiction" | "inconsistent-init" | "unreachable-action" | "duplicate-property" | "subsumed-property"
    | "bounded-unreachable-action" | "deadlocked-initial-state" | "no-state-progress-from-init";
  name: string;
  message: string;
  relatedName?: string;
  backend?: "z3";
  depth?: number;
}

const smtBinary: Record<string, string> = {
  eq: "=", and: "and", or: "or", lt: "<", lte: "<=", gt: ">", gte: ">=",
  add: "+", subtract: "-", multiply: "*", divide: "div", modulo: "mod",
};

function temporalToSmt(expression: TemporalExpression, resolveName: (name: string) => string = (name) => name): string {
  if (expression.kind === "name") return resolveName(expression.name);
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") return expression.operator === "not" ? `(not ${temporalToSmt(expression.operand, resolveName)})` : `(- ${temporalToSmt(expression.operand, resolveName)})`;
  if (expression.operator === "neq") return `(not (= ${temporalToSmt(expression.left, resolveName)} ${temporalToSmt(expression.right, resolveName)}))`;
  return `(${smtBinary[expression.operator]} ${temporalToSmt(expression.left, resolveName)} ${temporalToSmt(expression.right, resolveName)})`;
}

let solverSequence = 0;
async function check(spec: TemporalSpec, assertions: readonly string[]): Promise<"sat" | "unsat" | "unknown"> {
  const { Context } = await initZ3();
  const context: any = new Context(`uneffect_spec_lint_${solverSequence++}`);
  const solver = new context.Solver();
  const declarations = spec.states.map((state) => `(declare-const ${state.name} ${state.type === "int" ? "Int" : "Bool"})`);
  solver.fromString(["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`)].join("\n"));
  return String(await solver.check()) as "sat" | "unsat" | "unknown";
}

async function checkSmt(declarations: readonly string[], assertions: readonly string[]): Promise<"sat" | "unsat" | "unknown"> {
  const { Context } = await initZ3();
  const context: any = new Context(`uneffect_spec_lint_${solverSequence++}`);
  const solver = new context.Solver();
  solver.fromString(["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`)].join("\n"));
  return String(await solver.check()) as "sat" | "unsat" | "unknown";
}

export type TemporalCounterexampleResult =
  | { status: "counterexample"; depth: number; trace: ModelCounterexample }
  | { status: "safe-within-bound"; depth: number }
  | { status: "unknown"; depth: number };

function parseZ3TemporalValue(value: string, type: "int" | "bool"): number | boolean {
  if (type === "bool") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Z3 returned a non-boolean temporal value: ${value}`);
  }
  if (/^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`Z3 temporal integer exceeds JavaScript's safe range: ${value}`);
    return parsed;
  }
  const negative = /^\(-\s+(\d+)\)$/.exec(value);
  if (negative) {
    const parsed = -Number(negative[1]);
    if (!Number.isSafeInteger(parsed)) throw new Error(`Z3 temporal integer exceeds JavaScript's safe range: ${value}`);
    return parsed;
  }
  throw new Error(`Z3 returned a non-integer temporal value: ${value}`);
}

/** Finds the shortest bounded safety violation and extracts its chosen actions and states. */
export async function findTemporalCounterexampleWithZ3(
  spec: TemporalSpec,
  propertyName: string,
  options: { maxSteps?: number } = {},
): Promise<TemporalCounterexampleResult> {
  const property = spec.properties.find((candidate) => candidate.name === propertyName);
  if (!property) throw new Error(`unknown temporal property: ${propertyName}`);
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new Error(`maxSteps must be a non-negative safe integer, got ${maxSteps}`);
  const at = (name: string, step: number) => `${name}__${step}`;
  const actionAt = (step: number) => `uneffect_action__${step}`;
  const stateDeclarations = Array.from({ length: maxSteps + 1 }, (_, step) => spec.states.map((state) => `(declare-const ${at(state.name, step)} ${state.type === "int" ? "Int" : "Bool"})`)).flat();
  const actionDeclarations = Array.from({ length: maxSteps }, (_, step) => `(declare-const ${actionAt(step)} Int)`);
  const declarations = [...stateDeclarations, ...actionDeclarations];
  const init = spec.init.map((assignment) => `(= ${at(assignment.target, 0)} ${temporalToSmt(assignment.expressionAst, (name) => at(name, 0))})`);
  const transition = (step: number): string => `(or ${spec.actions.map((action, actionIndex) => {
    const assignments = new Map(action.assignments.map((assignment) => [assignment.target, assignment]));
    const guard = action.guard ? temporalToSmt(action.guard.expressionAst, (name) => at(name, step)) : "true";
    const updates = spec.states.map((state) => {
      const assignment = assignments.get(state.name);
      const value = assignment ? temporalToSmt(assignment.expressionAst, (name) => at(name, step)) : at(state.name, step);
      return `(= ${at(state.name, step + 1)} ${value})`;
    });
    return `(and (= ${actionAt(step)} ${actionIndex}) ${guard} ${updates.join(" ")})`;
  }).join(" ")})`;
  const { Context } = await initZ3();
  const context: any = new Context(`uneffect_temporal_counterexample_${solverSequence++}`);
  for (let depth = 0; depth <= maxSteps; depth++) {
    if (depth > 0 && spec.actions.length === 0) break;
    const assertions = [
      ...init,
      ...Array.from({ length: depth }, (_, step) => transition(step)),
      `(not ${temporalToSmt(property.expressionAst, (name) => at(name, depth))})`,
    ];
    const solver = new context.Solver();
    const program = ["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`)].join("\n");
    solver.fromString(program);
    const status = String(await solver.check());
    if (status === "unknown") return { status: "unknown", depth };
    if (status !== "sat") continue;
    const model = solver.model();
    const states: ModelState[] = Array.from({ length: depth + 1 }, (_, step) => Object.fromEntries(spec.states.map((state) => {
      const expression = state.type === "int" ? context.Int.const(at(state.name, step)) : context.Bool.const(at(state.name, step));
      return [state.name, parseZ3TemporalValue(model.eval(expression, true).toString(), state.type)];
    })));
    const actions = Array.from({ length: depth }, (_, step) => {
      const selected = Number(model.eval(context.Int.const(actionAt(step)), true).toString());
      const action = spec.actions[selected];
      if (!action) throw new Error(`Z3 selected invalid temporal action ${selected} at step ${step}`);
      return action.name;
    });
    const modelHash = createHash("sha256").update(program).digest("hex");
    const trace = createModelCounterexample({
      backend: "z3", modelHash, initialState: states[0]!,
      steps: actions.map((action, index) => ({ action, before: states[index]!, after: states[index + 1]! })),
    });
    return { status: "counterexample", depth, trace };
  }
  return { status: "safe-within-bound", depth: maxSteps };
}

/** Bounded transition reachability. An unreachable result is only a depth-bounded finding. */
export async function lintTemporalReachabilityWithZ3(spec: TemporalSpec, options: { maxSteps?: number } = {}): Promise<SpecLintDiagnostic[]> {
  if (spec.states.length === 0 && spec.actions.length === 0) return [];
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new Error(`maxSteps must be a non-negative safe integer, got ${maxSteps}`);
  const at = (name: string, step: number) => `${name}__${step}`;
  const declarations = Array.from({ length: maxSteps + 1 }, (_, step) => spec.states.map((state) => `(declare-const ${at(state.name, step)} ${state.type === "int" ? "Int" : "Bool"})`)).flat();
  const init = spec.init.map((assignment) => `(= ${at(assignment.target, 0)} ${temporalToSmt(assignment.expressionAst, (name) => at(name, 0))})`);
  const guard = (action: TemporalSpec["actions"][number], step: number) => action.guard ? temporalToSmt(action.guard.expressionAst, (name) => at(name, step)) : "true";
  const actionTransition = (action: TemporalSpec["actions"][number], step: number): string => {
    const assignments = new Map(action.assignments.map((assignment) => [assignment.target, assignment]));
    const updates = spec.states.map((state) => {
      const assignment = assignments.get(state.name);
      const value = assignment ? temporalToSmt(assignment.expressionAst, (name) => at(name, step)) : at(state.name, step);
      return `(= ${at(state.name, step + 1)} ${value})`;
    });
    return `(and ${guard(action, step)} ${updates.join(" ")})`;
  };
  const disjoin = (values: readonly string[]) => values.length === 0 ? "false" : values.length === 1 ? values[0]! : `(or ${values.join(" ")})`;
  const step = (index: number) => disjoin(spec.actions.map((action) => actionTransition(action, index)));
  const diagnostics: SpecLintDiagnostic[] = [];
  const initStatus = await checkSmt(declarations, init);
  const enabledStatus = await checkSmt(declarations, [...init, disjoin(spec.actions.map((action) => guard(action, 0)))]);
  if (enabledStatus === "unsat" && initStatus === "sat") diagnostics.push({
    code: "deadlocked-initial-state", name: "<init>", backend: "z3", depth: 0, message: "no action is enabled in any state satisfying init",
  });
  if (maxSteps >= 1 && enabledStatus === "sat") {
    const changes = disjoin(spec.states.map((state) => `(not (= ${at(state.name, 1)} ${at(state.name, 0)}))`));
    if (await checkSmt(declarations, [...init, step(0), changes]) === "unsat") diagnostics.push({
      code: "no-state-progress-from-init", name: "<init>", backend: "z3", depth: 1,
      message: "actions are enabled at init, but no enabled initial transition can change temporal state",
    });
  }
  for (const action of spec.actions) {
    const prefixes: string[] = [];
    for (let depth = 0; depth <= maxSteps; depth++) {
      const transitions = Array.from({ length: depth }, (_, index) => step(index));
      prefixes.push(`(and ${[...transitions, guard(action, depth)].join(" ")})`);
    }
    const result = await checkSmt(declarations, [...init, disjoin(prefixes)]);
    if (result === "unsat") diagnostics.push({
      code: "bounded-unreachable-action", name: action.name, backend: "z3", depth: maxSteps,
      message: `${action.name} is unreachable from init within ${maxSteps} transition steps; this is not an unbounded proof`,
    });
  }
  return diagnostics;
}

/** Semantic lint over all typed states. It does not claim reachable-state or progress analysis. */
export async function lintTemporalSpecWithZ3(spec: TemporalSpec): Promise<SpecLintDiagnostic[]> {
  const diagnostics: SpecLintDiagnostic[] = [];
  const initConstraints = spec.init.map((item) => `(= ${item.target} ${temporalToSmt(item.expressionAst)})`);
  if (await check(spec, initConstraints) === "unsat") diagnostics.push({
    code: "inconsistent-init", name: "<init>", backend: "z3", message: "temporal init constraints are jointly unsatisfiable",
  });

  const classified = new Set<string>();
  for (const property of spec.properties) {
    const expression = temporalToSmt(property.expressionAst);
    if (await check(spec, [`(not ${expression})`]) === "unsat") {
      classified.add(property.name);
      diagnostics.push({ code: "solver-tautology", name: property.name, backend: "z3", message: `${property.name} is valid for every typed state` });
    } else if (await check(spec, [expression]) === "unsat") {
      classified.add(property.name);
      diagnostics.push({ code: "solver-contradiction", name: property.name, backend: "z3", message: `${property.name} is false for every typed state` });
    }
  }
  for (const action of spec.actions) if (action.guard && await check(spec, [temporalToSmt(action.guard.expressionAst)]) === "unsat") diagnostics.push({
    code: "unreachable-action", name: action.name, backend: "z3", message: `${action.name} has an unsatisfiable guard for every typed state`,
  });

  for (let index = 0; index < spec.properties.length; index++) {
    const current = spec.properties[index]!;
    if (classified.has(current.name)) continue;
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex++) {
      const earlier = spec.properties[earlierIndex]!;
      if (classified.has(earlier.name)) continue;
      if (same(current.expressionAst, earlier.expressionAst)) {
        diagnostics.push({ code: "duplicate-property", name: current.name, relatedName: earlier.name, backend: "z3", message: `${current.name} duplicates ${earlier.name}` });
        break;
      }
      const implicationCounterexample = [temporalToSmt(earlier.expressionAst), `(not ${temporalToSmt(current.expressionAst)})`];
      if (await check(spec, implicationCounterexample) === "unsat") {
        diagnostics.push({ code: "subsumed-property", name: current.name, relatedName: earlier.name, backend: "z3", message: `${current.name} is implied by earlier property ${earlier.name}` });
        break;
      }
    }
  }
  return diagnostics;
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

/** Parse source and combine cheap syntactic lint with solver-backed semantic lint. */
export async function lintSpecWithZ3(fileName: string, text: string, options: { reachabilitySteps?: number | false } = {}): Promise<{ spec: ParsedSpec; diagnostics: SpecLintDiagnostic[] }> {
  const result = lintSpec(fileName, text);
  const reachability = options.reachabilitySteps === false ? [] : await lintTemporalReachabilityWithZ3(result.spec.temporal, { maxSteps: options.reachabilitySteps ?? 8 });
  return {
    spec: result.spec,
    diagnostics: [...result.diagnostics, ...await lintTemporalSpecWithZ3(result.spec.temporal), ...reachability],
  };
}
