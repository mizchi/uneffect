import type { ParsedSpec, TemporalSpec } from "./spec-ir.js";
import type { TemporalExpression, TemporalValueType } from "./temporal-expressions.js";
import { parseSpec } from "./spec-ir.js";
import { init as initZ3 } from "z3-solver";
import { createHash } from "node:crypto";
import { createModelCounterexample, type ModelCounterexample, type ModelState } from "./model-replay.js";

export interface SpecLintDiagnostic {
  code: "tautological-invariant" | "contradictory-invariant" | "state-independent-invariant" | "no-op-action"
    | "solver-tautology" | "solver-contradiction" | "inconsistent-init" | "unreachable-action" | "duplicate-property" | "subsumed-property"
    | "bounded-unreachable-action" | "deadlocked-initial-state" | "bounded-reachable-deadlock"
    | "no-state-progress-from-init" | "bounded-no-state-progress" | "bounded-vacuous-property" | "unsupported-backend-domain";
  name: string;
  message: string;
  relatedName?: string;
  backend?: "z3";
  depth?: number;
}

function smtBinaryOperator(operator: Exclude<Extract<TemporalExpression, { kind: "binary" }>["operator"], "neq">): string {
  switch (operator) {
    case "eq": return "=";
    case "and": return "and";
    case "or": return "or";
    case "lt": return "<";
    case "lte": return "<=";
    case "gt": return ">";
    case "gte": return ">=";
    case "add": return "+";
    case "subtract": return "-";
    case "multiply": return "*";
    case "divide": return "div";
    case "modulo": return "mod";
  }
}

function smtSort(type: TemporalValueType | "never"): string {
  if (type === "int") return "Int";
  if (type === "bool") return "Bool";
  if (type === "never") return "Int";
  if (type.kind === "set" && (type.element === "int" || type.element === "bool" || type.element === "never")) return `(Array ${smtSort(type.element)} Bool)`;
  const mapType = scalarMapType(type);
  if (mapType) return mapNames(mapType).sort;
  const recordType = scalarRecordType(type);
  if (recordType) return recordNames(recordType).sort;
  throw new Error("this temporal value type is not supported by the Z3 lint backend");
}

function supportsZ3SemanticType(type: TemporalValueType): boolean {
  return typeof type === "string"
    || (type.kind === "set" && (type.element === "int" || type.element === "bool" || type.element === "never"))
    || (type.kind === "map" && type.key !== "never" && (type.value === "int" || type.value === "bool"))
    || scalarRecordType(type) !== undefined;
}

function supportsZ3FiniteCollectionState(type: TemporalValueType): boolean { return supportsZ3SemanticType(type); }

type ScalarMapType = Extract<TemporalValueType, { kind: "map" }> & { key: "int" | "bool"; value: "int" | "bool" };
type ScalarRecordType = Extract<TemporalValueType, { kind: "record" }> & { fields: Readonly<Record<string, "int" | "bool">> };

function mapNames(type: ScalarMapType) {
  const suffix = `${type.key}_${type.value}`;
  return {
    sort: `UneffectMap_${suffix}`,
    constructor: `uneffect_map_${suffix}`,
    domain: `uneffect_map_domain_${suffix}`,
    values: `uneffect_map_values_${suffix}`,
  };
}

function scalarMapType(type: TemporalValueType | undefined): ScalarMapType | undefined {
  return type && typeof type !== "string" && type.kind === "map" && type.key !== "never"
    && (type.value === "int" || type.value === "bool") ? type as ScalarMapType : undefined;
}

function scalarRecordType(type: TemporalValueType | undefined): ScalarRecordType | undefined {
  if (!type || typeof type === "string" || type.kind !== "record") return undefined;
  for (const field of Object.values(type.fields)) if (field !== "int" && field !== "bool") return undefined;
  return type as ScalarRecordType;
}

function recordNames(type: ScalarRecordType) {
  const fields = Object.keys(type.fields).sort();
  const shape = fields.map((name) => `${name}:${type.fields[name]}`).join(";");
  const suffix = createHash("sha256").update(shape).digest("hex").slice(0, 12);
  return {
    sort: `UneffectRecord_${suffix}`,
    constructor: `uneffect_record_${suffix}`,
    fields,
    selector: (name: string) => `uneffect_record_${suffix}_field_${fields.indexOf(name)}`,
  };
}

function z3TypeDeclarations(types: readonly TemporalValueType[]): string[] {
  const declarations = new Map<string, string>();
  for (const candidate of types) {
    const type = scalarMapType(candidate);
    if (!type) continue;
    const names = mapNames(type);
    declarations.set(names.sort, `(declare-datatypes ((${names.sort} 0)) (((${names.constructor} (${names.domain} (Array ${smtSort(type.key)} Bool)) (${names.values} (Array ${smtSort(type.key)} ${smtSort(type.value)}))))))`);
  }
  for (const candidate of types) {
    const type = scalarRecordType(candidate);
    if (!type) continue;
    const names = recordNames(type);
    const fields = names.fields.map((name) => `(${names.selector(name)} ${smtSort(type.fields[name]!)})`).join(" ");
    declarations.set(names.sort, `(declare-datatypes ((${names.sort} 0)) (((${names.constructor} ${fields}))))`);
  }
  return [...declarations.values()];
}

function z3TemporalType(expression: TemporalExpression, symbols: ReadonlyMap<string, TemporalValueType>): TemporalValueType {
  if (expression.kind === "name") {
    const type = symbols.get(expression.name);
    if (!type) throw new Error(`unknown temporal symbol \`${expression.name}\``);
    return type;
  }
  if (expression.kind === "integer") return "int";
  if (expression.kind === "boolean") return "bool";
  if (expression.kind === "record") {
    const base = expression.base ? z3TemporalType(expression.base, symbols) : undefined;
    if (base && (typeof base === "string" || base.kind !== "record")) throw new Error("Z3 record spread requires a record");
    const fields: Record<string, TemporalValueType> = base && typeof base !== "string" ? { ...base.fields } : {};
    for (const name of Object.keys(expression.fields)) fields[name] = z3TemporalType(expression.fields[name]!, symbols);
    return { kind: "record", fields };
  }
  if (expression.kind === "field") {
    const receiver = z3TemporalType(expression.receiver, symbols);
    if (typeof receiver === "string" || receiver.kind !== "record" || !receiver.fields[expression.name]) throw new Error(`unknown Z3 record field \`${expression.name}\``);
    return receiver.fields[expression.name]!;
  }
  if (expression.kind === "unary") return expression.operator === "not" ? "bool" : "int";
  if (expression.kind === "binary") return ["add", "subtract", "multiply", "divide", "modulo"].includes(expression.operator) ? "int" : "bool";
  if (expression.kind === "call" && expression.name === "Set") {
    if (expression.arguments.length === 0) return { kind: "set", element: "never" };
    return { kind: "set", element: z3TemporalType(expression.arguments[0]!, symbols) };
  }
  if (expression.kind === "call" && expression.name === "Map") {
    const entries = expression.arguments[0];
    if (!entries || entries.kind !== "array" || entries.elements.length === 0) return { kind: "map", key: "never", value: "never" };
    const pair = entries.elements[0];
    if (!pair || pair.kind !== "array" || pair.elements.length !== 2) throw new Error("Z3 Map entries must be key/value pairs");
    const key = z3TemporalType(pair.elements[0]!, symbols), value = z3TemporalType(pair.elements[1]!, symbols);
    if (key !== "int" && key !== "bool") throw new Error("Z3 Map keys must be scalar");
    return { kind: "map", key, value };
  }
  if (expression.kind === "method") {
    const receiver = z3TemporalType(expression.receiver, symbols);
    if (typeof receiver !== "string" && receiver.kind === "map") {
      if (expression.name === "put") return receiver;
      if (expression.name === "keys") return { kind: "set", element: receiver.key };
      if (expression.name === "values") return { kind: "set", element: receiver.value };
    }
    if (expression.name === "union") return receiver;
    if (expression.name === "contains" || expression.name === "forall") return "bool";
    if (expression.name === "size") return "int";
  }
  throw new Error("this temporal value type is not supported by the Z3 lint backend");
}

function finiteCollectionUniverse(spec: TemporalSpec): { int: number[]; bool: boolean[]; complete: boolean } {
  const integers = new Set<number>(), booleans = new Set<boolean>();
  let complete = true;
  const literal = (expression: TemporalExpression): number | boolean | undefined => {
    if (expression.kind === "integer") return Number(expression.value);
    if (expression.kind === "boolean") return expression.value;
    if (expression.kind === "unary" && expression.operator === "negate" && expression.operand.kind === "integer") return -Number(expression.operand.value);
    return undefined;
  };
  const visit = (expression: TemporalExpression): void => {
    if (expression.kind === "call" && expression.name === "Set") for (const item of expression.arguments) {
      const value = literal(item);
      if (typeof value === "number") integers.add(value);
      else if (typeof value === "boolean") booleans.add(value);
      else complete = false;
    }
    if (expression.kind === "call" && expression.name === "Map") {
      const entries = expression.arguments[0];
      if (!entries || entries.kind !== "array") complete = false;
      else for (const pair of entries.elements) {
        if (pair.kind !== "array" || pair.elements.length !== 2) { complete = false; continue; }
        for (const item of pair.elements) {
          const value = literal(item);
          if (typeof value === "number") integers.add(value);
          else if (typeof value === "boolean") booleans.add(value);
          else complete = false;
        }
      }
    }
    if (expression.kind === "method" && expression.name === "put") for (const item of expression.arguments) {
      const value = literal(item);
      if (typeof value === "number") integers.add(value);
      else if (typeof value === "boolean") booleans.add(value);
      else complete = false;
    }
    if (expression.kind === "unary") visit(expression.operand);
    else if (expression.kind === "binary") { visit(expression.left); visit(expression.right); }
    else if (expression.kind === "array") expression.elements.forEach(visit);
    else if (expression.kind === "record") { if (expression.base) visit(expression.base); Object.values(expression.fields).forEach(visit); }
    else if (expression.kind === "field") visit(expression.receiver);
    else if (expression.kind === "lambda") visit(expression.body);
    else if (expression.kind === "call") expression.arguments.forEach(visit);
    else if (expression.kind === "method") { visit(expression.receiver); expression.arguments.forEach(visit); }
  };
  for (const assignment of [...spec.init, ...spec.actions.flatMap((action) => action.assignments)]) visit(assignment.expressionAst);
  for (const action of spec.actions) if (action.guard) visit(action.guard.expressionAst);
  for (const property of spec.properties) visit(property.expressionAst);
  return { int: [...integers].sort((a, b) => a - b), bool: [...booleans].sort((a, b) => Number(a) - Number(b)), complete };
}

function temporalToSmt(
  expression: TemporalExpression,
  resolveName: (name: string) => string = (name) => name,
  symbols: ReadonlyMap<string, TemporalValueType> = new Map(),
  expected?: TemporalValueType,
  boundName?: string,
): string {
  if (expression.kind === "name") return expression.name === boundName ? expression.name : resolveName(expression.name);
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") return expression.operator === "not" ? `(not ${temporalToSmt(expression.operand, resolveName, symbols, undefined, boundName)})` : `(- ${temporalToSmt(expression.operand, resolveName, symbols, undefined, boundName)})`;
  if (expression.kind === "call" && expression.name === "Set") {
    const type = expression.arguments.length === 0 ? expected : z3TemporalType(expression, symbols);
    if (!type || typeof type === "string" || type.kind !== "set" || !supportsZ3SemanticType(type)) throw new Error("Z3 Set literals require a scalar Set type");
    let set = `((as const ${smtSort(type)}) false)`;
    for (const item of expression.arguments) set = `(store ${set} ${temporalToSmt(item, resolveName, symbols, undefined, boundName)} true)`;
    return set;
  }
  if (expression.kind === "call" && expression.name === "Map") {
    const type = scalarMapType(expression.arguments[0]?.kind === "array" && expression.arguments[0].elements.length === 0 ? expected : z3TemporalType(expression, symbols));
    const entries = expression.arguments[0];
    if (!type || !entries || entries.kind !== "array") throw new Error("Z3 Map literals require a scalar Map type");
    const names = mapNames(type);
    let domain = `((as const (Array ${smtSort(type.key)} Bool)) false)`;
    const defaultValue = type.value === "int" ? "0" : "false";
    let values = `((as const (Array ${smtSort(type.key)} ${smtSort(type.value)})) ${defaultValue})`;
    for (const entry of entries.elements) {
      if (entry.kind !== "array" || entry.elements.length !== 2) throw new Error("Z3 Map entries must be key/value pairs");
      const key = temporalToSmt(entry.elements[0]!, resolveName, symbols, undefined, boundName);
      const value = temporalToSmt(entry.elements[1]!, resolveName, symbols, undefined, boundName);
      domain = `(store ${domain} ${key} true)`;
      values = `(store ${values} ${key} ${value})`;
    }
    return `(${names.constructor} ${domain} ${values})`;
  }
  if (expression.kind === "record") {
    const type = scalarRecordType(expected ?? z3TemporalType(expression, symbols));
    if (!type) throw new Error("Z3 record literals require scalar fields");
    const names = recordNames(type);
    const base = expression.base ? temporalToSmt(expression.base, resolveName, symbols, type, boundName) : undefined;
    const fields = names.fields.map((name) => {
      const value = expression.fields[name];
      if (value) return temporalToSmt(value, resolveName, symbols, type.fields[name], boundName);
      if (!base) throw new Error(`missing Z3 record field \`${name}\``);
      return `(${names.selector(name)} ${base})`;
    });
    return `(${names.constructor} ${fields.join(" ")})`;
  }
  if (expression.kind === "field") {
    const type = scalarRecordType(z3TemporalType(expression.receiver, symbols));
    if (!type || !type.fields[expression.name]) throw new Error(`unknown Z3 record field \`${expression.name}\``);
    const names = recordNames(type);
    return `(${names.selector(expression.name)} ${temporalToSmt(expression.receiver, resolveName, symbols, type, boundName)})`;
  }
  if (expression.kind === "method") {
    const receiverType = z3TemporalType(expression.receiver, symbols);
    const mapType = scalarMapType(receiverType);
    if (mapType) {
      const names = mapNames(mapType);
      const receiver = temporalToSmt(expression.receiver, resolveName, symbols, mapType, boundName);
      if (expression.name === "put") {
        const key = temporalToSmt(expression.arguments[0]!, resolveName, symbols, undefined, boundName);
        const value = temporalToSmt(expression.arguments[1]!, resolveName, symbols, undefined, boundName);
        return `(${names.constructor} (store (${names.domain} ${receiver}) ${key} true) (store (${names.values} ${receiver}) ${key} ${value}))`;
      }
      if (expression.name === "keys") return `(${names.domain} ${receiver})`;
      if (expression.name === "values") {
        const keySort = smtSort(mapType.key), valueSort = smtSort(mapType.value);
        return `(lambda ((uneffect_value ${valueSort})) (exists ((uneffect_key ${keySort})) (and (select (${names.domain} ${receiver}) uneffect_key) (= (select (${names.values} ${receiver}) uneffect_key) uneffect_value))))`;
      }
      throw new Error(`Z3 Map method \`${expression.name}\` is not supported`);
    }
    if (typeof receiverType === "string" || receiverType.kind !== "set" || !supportsZ3SemanticType(receiverType)) throw new Error("Z3 collection methods currently require a scalar Set or Map receiver");
    const receiver = temporalToSmt(expression.receiver, resolveName, symbols, receiverType, boundName);
    if (expression.name === "contains") return `(select ${receiver} ${temporalToSmt(expression.arguments[0]!, resolveName, symbols, undefined, boundName)})`;
    if (expression.name === "union") return `((_ map or) ${receiver} ${temporalToSmt(expression.arguments[0]!, resolveName, symbols, receiverType, boundName)})`;
    if (expression.name === "forall") {
      const predicate = expression.arguments[0];
      if (!predicate || predicate.kind !== "lambda") throw new Error("Z3 Set forall requires a lambda");
      const scoped = new Map(symbols);
      scoped.set(predicate.parameter, receiverType.element === "never" ? "int" : receiverType.element);
      return `(forall ((${predicate.parameter} ${smtSort(receiverType.element)})) (=> (select ${receiver} ${predicate.parameter}) ${temporalToSmt(predicate.body, resolveName, scoped, undefined, predicate.parameter)}))`;
    }
    throw new Error(`Z3 Set method \`${expression.name}\` is not supported`);
  }
  if (expression.kind === "array" || expression.kind === "lambda" || expression.kind === "call") throw new Error("this collection temporal expression is not supported by the Z3 lint backend");
  if (expression.operator === "neq") return `(not (= ${temporalToSmt(expression.left, resolveName, symbols, undefined, boundName)} ${temporalToSmt(expression.right, resolveName, symbols, undefined, boundName)}))`;
  return `(${smtBinaryOperator(expression.operator)} ${temporalToSmt(expression.left, resolveName, symbols, undefined, boundName)} ${temporalToSmt(expression.right, resolveName, symbols, undefined, boundName)})`;
}

let solverSequence = 0;
async function check(spec: TemporalSpec, assertions: readonly string[]): Promise<"sat" | "unsat" | "unknown"> {
  const { Context } = await initZ3();
  const context: any = new Context(`uneffect_spec_lint_${solverSequence++}`);
  const solver = new context.Solver();
  const declarations = [...z3TypeDeclarations(spec.states.map((state) => state.type)), ...spec.states.map((state) => `(declare-const ${state.name} ${smtSort(state.type)})`)];
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
  if (spec.states.some((state) => !supportsZ3FiniteCollectionState(state.type))) return { status: "unknown", depth: 0 };
  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  const universe = finiteCollectionUniverse(spec);
  if (!universe.complete) return { status: "unknown", depth: 0 };
  const at = (name: string, step: number) => `${name}__${step}`;
  const actionAt = (step: number) => `uneffect_action__${step}`;
  const stateDeclarations = Array.from({ length: maxSteps + 1 }, (_, step) => spec.states.map((state) => `(declare-const ${at(state.name, step)} ${smtSort(state.type)})`)).flat();
  const actionDeclarations = Array.from({ length: maxSteps }, (_, step) => `(declare-const ${actionAt(step)} Int)`);
  const memberName = (name: string, step: number, index: number) => `${name}__${step}__member__${index}`;
  const mapValueName = (name: string, step: number, index: number) => `${name}__${step}__value__${index}`;
  const recordFieldName = (name: string, step: number, index: number) => `${name}__${step}__field__${index}`;
  const memberViews = Array.from({ length: maxSteps + 1 }, (_, step) => spec.states.flatMap((state) => {
    if (typeof state.type === "string") return [];
    if (state.type.kind === "set") {
      const values = state.type.element === "bool" ? universe.bool.map(String) : universe.int.map(String);
      return values.flatMap((value, index) => [`(declare-const ${memberName(state.name, step, index)} Bool)`, `(assert (= ${memberName(state.name, step, index)} (select ${at(state.name, step)} ${value})))`]);
    }
    const recordType = scalarRecordType(state.type);
    if (recordType) {
      const names = recordNames(recordType);
      return names.fields.flatMap((field, index) => [
        `(declare-const ${recordFieldName(state.name, step, index)} ${smtSort(recordType.fields[field]!)})`,
        `(assert (= ${recordFieldName(state.name, step, index)} (${names.selector(field)} ${at(state.name, step)})))`,
      ]);
    }
    const type = scalarMapType(state.type);
    if (!type) throw new Error("bounded Z3 finite expansion supports scalar Set, Map, and record state only");
    const names = mapNames(type);
    const keys = type.key === "bool" ? universe.bool.map(String) : universe.int.map(String);
    return keys.flatMap((key, index) => [
      `(declare-const ${memberName(state.name, step, index)} Bool)`,
      `(declare-const ${mapValueName(state.name, step, index)} ${smtSort(type.value)})`,
      `(assert (= ${memberName(state.name, step, index)} (select (${names.domain} ${at(state.name, step)}) ${key})))`,
      `(assert (= ${mapValueName(state.name, step, index)} (select (${names.values} ${at(state.name, step)}) ${key})))`,
    ]);
  })).flat();
  const declarations = [...z3TypeDeclarations(spec.states.map((state) => state.type)), ...stateDeclarations, ...actionDeclarations, ...memberViews];
  const init = spec.init.map((assignment) => `(= ${at(assignment.target, 0)} ${temporalToSmt(assignment.expressionAst, (name) => at(name, 0), symbols, symbols.get(assignment.target))})`);
  const transition = (step: number): string => `(or ${spec.actions.map((action, actionIndex) => {
    const assignments = new Map(action.assignments.map((assignment) => [assignment.target, assignment]));
    const guard = action.guard ? temporalToSmt(action.guard.expressionAst, (name) => at(name, step), symbols) : "true";
    const updates = spec.states.map((state) => {
      const assignment = assignments.get(state.name);
      const value = assignment ? temporalToSmt(assignment.expressionAst, (name) => at(name, step), symbols, state.type) : at(state.name, step);
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
      `(not ${temporalToSmt(property.expressionAst, (name) => at(name, depth), symbols)})`,
    ];
    const solver = new context.Solver();
    const program = ["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`)].join("\n");
    solver.fromString(program);
    const status = String(await solver.check());
    if (status === "unknown") return { status: "unknown", depth };
    if (status !== "sat") continue;
    const model = solver.model();
    const states: ModelState[] = Array.from({ length: depth + 1 }, (_, step) => Object.fromEntries(spec.states.map((state) => {
      if (typeof state.type === "string") {
        const expression = state.type === "int" ? context.Int.const(at(state.name, step)) : context.Bool.const(at(state.name, step));
        return [state.name, parseZ3TemporalValue(model.eval(expression, true).toString(), state.type)];
      }
      if (state.type.kind === "set") {
        const values = state.type.element === "bool" ? universe.bool : universe.int;
        return [state.name, values.filter((_value, index) => model.eval(context.Bool.const(memberName(state.name, step, index)), true).toString() === "true")];
      }
      const recordType = scalarRecordType(state.type);
      if (recordType) {
        const names = recordNames(recordType);
        const record = Object.fromEntries(names.fields.map((field, index) => {
          const type = recordType.fields[field]!;
          const expression = type === "int" ? context.Int.const(recordFieldName(state.name, step, index)) : context.Bool.const(recordFieldName(state.name, step, index));
          return [field, parseZ3TemporalValue(model.eval(expression, true).toString(), type)];
        }));
        return [state.name, record];
      }
      const type = scalarMapType(state.type);
      if (!type) throw new Error("bounded Z3 finite expansion supports scalar Set, Map, and record state only");
      const keys = type.key === "bool" ? universe.bool : universe.int;
      const entries = keys.flatMap((key, index) => {
        if (model.eval(context.Bool.const(memberName(state.name, step, index)), true).toString() !== "true") return [];
        const valueExpression = type.value === "int" ? context.Int.const(mapValueName(state.name, step, index)) : context.Bool.const(mapValueName(state.name, step, index));
        return [[key, parseZ3TemporalValue(model.eval(valueExpression, true).toString(), type.value)]];
      });
      return [state.name, entries];
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
  if (spec.states.some((state) => !supportsZ3FiniteCollectionState(state.type))) return [{
    code: "unsupported-backend-domain", name: "<model>", backend: "z3",
    message: "bounded Z3 reachability supports scalar state, scalar-element Sets, scalar Maps, and scalar-field records only; use Quint for this temporal domain",
  }];
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new Error(`maxSteps must be a non-negative safe integer, got ${maxSteps}`);
  const at = (name: string, step: number) => `${name}__${step}`;
  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  const declarations = [
    ...z3TypeDeclarations(spec.states.map((state) => state.type)),
    ...Array.from({ length: maxSteps + 1 }, (_, step) => spec.states.map((state) => `(declare-const ${at(state.name, step)} ${smtSort(state.type)})`)).flat(),
  ];
  const init = spec.init.map((assignment) => `(= ${at(assignment.target, 0)} ${temporalToSmt(assignment.expressionAst, (name) => at(name, 0), symbols, symbols.get(assignment.target))})`);
  const guard = (action: TemporalSpec["actions"][number], step: number) => action.guard ? temporalToSmt(action.guard.expressionAst, (name) => at(name, step), symbols) : "true";
  const actionTransition = (action: TemporalSpec["actions"][number], step: number): string => {
    const assignments = new Map(action.assignments.map((assignment) => [assignment.target, assignment]));
    const updates = spec.states.map((state) => {
      const assignment = assignments.get(state.name);
      const value = assignment ? temporalToSmt(assignment.expressionAst, (name) => at(name, step), symbols, state.type) : at(state.name, step);
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
  if (initStatus === "sat" && enabledStatus !== "unsat") {
    for (let depth = 1; depth <= maxSteps; depth++) {
      const transitions = Array.from({ length: depth }, (_, index) => step(index));
      const noneEnabled = `(not ${disjoin(spec.actions.map((action) => guard(action, depth)))})`;
      const status = await checkSmt(declarations, [...init, ...transitions, noneEnabled]);
      if (status !== "sat") continue;
      diagnostics.push({
        code: "bounded-reachable-deadlock", name: "<deadlock>", backend: "z3", depth,
        message: `a deadlocked state is reachable in ${depth} transition steps; this is a bounded counterexample`,
      });
      break;
    }
    for (let depth = 1; depth <= maxSteps; depth++) {
      const transitions = Array.from({ length: depth }, (_, index) => step(index));
      const enabled = disjoin(spec.actions.map((action) => guard(action, depth)));
      const actionCannotChange = spec.actions.map((action) => {
        const unchanged = action.assignments.map((assignment) =>
          `(= ${temporalToSmt(assignment.expressionAst, (name) => at(name, depth), symbols, symbols.get(assignment.target))} ${at(assignment.target, depth)})`);
        const stutters = unchanged.length === 0 ? "true" : unchanged.length === 1 ? unchanged[0]! : `(and ${unchanged.join(" ")})`;
        return `(or (not ${guard(action, depth)}) ${stutters})`;
      });
      const status = await checkSmt(declarations, [...init, ...transitions, enabled, ...actionCannotChange]);
      if (status !== "sat") continue;
      diagnostics.push({
        code: "bounded-no-state-progress", name: "<progress>", backend: "z3", depth,
        message: `a state where actions are enabled but every enabled action stutters is reachable in ${depth} transition steps`,
      });
      break;
    }
  }
  if (initStatus === "sat" && maxSteps >= 1) for (const property of spec.properties) {
    const references = [...referencedNames(property.expressionAst)].filter((name) => spec.states.some((state) => state.name === name));
    if (references.length === 0) continue;
    const violations = Array.from({ length: maxSteps + 1 }, (_, depth) => {
      const transitions = Array.from({ length: depth }, (_, index) => step(index));
      const violation = `(not ${temporalToSmt(property.expressionAst, (name) => at(name, depth), symbols)})`;
      return `(and ${[...transitions, violation].join(" ")})`;
    });
    if (await checkSmt(declarations, [...init, disjoin(violations)]) !== "unsat") continue;
    const relevantChanges = Array.from({ length: maxSteps }, (_, depth) => {
      const transitions = Array.from({ length: depth + 1 }, (_, index) => step(index));
      const changes = disjoin(references.map((name) => `(not (= ${at(name, depth + 1)} ${at(name, depth)}))`));
      return `(and ${[...transitions, changes].join(" ")})`;
    });
    if (await checkSmt(declarations, [...init, disjoin(relevantChanges)]) === "unsat") diagnostics.push({
      code: "bounded-vacuous-property", name: property.name, backend: "z3", depth: maxSteps,
      message: `${property.name} holds within ${maxSteps} steps, but none of its referenced state can change on a reachable transition within that bound`,
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
  if (spec.states.some((state) => !supportsZ3SemanticType(state.type))) return [{
    code: "unsupported-backend-domain", name: "<model>", backend: "z3",
    message: "Z3 semantic lint supports scalar state, scalar-element Sets, scalar Maps, and scalar-field records only; use Quint for this temporal domain",
  }];
  const diagnostics: SpecLintDiagnostic[] = [];
  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  const initConstraints = spec.init.map((item) => `(= ${item.target} ${temporalToSmt(item.expressionAst, (name) => name, symbols, symbols.get(item.target))})`);
  if (await check(spec, initConstraints) === "unsat") diagnostics.push({
    code: "inconsistent-init", name: "<init>", backend: "z3", message: "temporal init constraints are jointly unsatisfiable",
  });

  const classified = new Set<string>();
  for (const property of spec.properties) {
    const expression = temporalToSmt(property.expressionAst, (name) => name, symbols);
    if (await check(spec, [`(not ${expression})`]) === "unsat") {
      classified.add(property.name);
      diagnostics.push({ code: "solver-tautology", name: property.name, backend: "z3", message: `${property.name} is valid for every typed state` });
    } else if (await check(spec, [expression]) === "unsat") {
      classified.add(property.name);
      diagnostics.push({ code: "solver-contradiction", name: property.name, backend: "z3", message: `${property.name} is false for every typed state` });
    }
  }
  for (const action of spec.actions) if (action.guard && await check(spec, [temporalToSmt(action.guard.expressionAst, (name) => name, symbols)]) === "unsat") diagnostics.push({
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
      const implicationCounterexample = [temporalToSmt(earlier.expressionAst, (name) => name, symbols), `(not ${temporalToSmt(current.expressionAst, (name) => name, symbols)})`];
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

function referencedNames(expression: TemporalExpression, names = new Set<string>(), bound = new Set<string>()): Set<string> {
  if (expression.kind === "name" && !bound.has(expression.name)) names.add(expression.name);
  else if (expression.kind === "unary") referencedNames(expression.operand, names, bound);
  else if (expression.kind === "binary") { referencedNames(expression.left, names, bound); referencedNames(expression.right, names, bound); }
  else if (expression.kind === "lambda") referencedNames(expression.body, names, new Set([...bound, expression.parameter]));
  else if (expression.kind === "array") expression.elements.forEach((element) => referencedNames(element, names, bound));
  else if (expression.kind === "call") expression.arguments.forEach((argument) => referencedNames(argument, names, bound));
  else if (expression.kind === "method") {
    referencedNames(expression.receiver, names, bound);
    expression.arguments.forEach((argument) => referencedNames(argument, names, bound));
  }
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
