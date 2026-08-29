import type { ParsedSpec, TemporalSpec } from "./spec-ir.js";
import { parseTemporalExpression, typeCheckTemporalExpression, type TemporalExpression, type TemporalValueType } from "./temporal-expressions.js";
import { parseSpec } from "./spec-ir.js";
import { createHash } from "node:crypto";
import { createModelCounterexample, type ModelCounterexample, type ModelState, type ModelValue } from "./model-replay.js";
import { executeZ3, type Z3Backend, type Z3Execution, type Z3ExecutionOptions, type Z3ValueRequest } from "./z3.js";

export interface SpecLintDiagnostic {
  code: "tautological-invariant" | "contradictory-invariant" | "state-independent-invariant" | "no-op-action"
    | "solver-tautology" | "solver-contradiction" | "inconsistent-init" | "unreachable-action" | "duplicate-property" | "subsumed-property"
    | "bounded-unreachable-action" | "deadlocked-initial-state" | "bounded-reachable-deadlock"
    | "inductively-unreachable-action" | "strengthened-unreachable-action" | "finite-state-unreachable-action" | "non-inductive-strengthening-property" | "unknown-strengthening-property" | "inductively-vacuous-property" | "strengthened-vacuous-property"
    | "no-state-progress-from-init" | "bounded-no-state-progress" | "reachable-stutter-cycle" | "reachable-liveness-cycle" | "reachable-recurrence-cycle" | "reachable-stabilization-cycle" | "reachable-response-cycle" | "initially-vacuous-liveness" | "unsatisfiable-recurrence-target" | "statewise-vacuous-recurrence" | "unsatisfiable-stabilization-target" | "statewise-vacuous-stabilization" | "unsatisfiable-response-trigger" | "statewise-vacuous-response" | "bounded-unreachable-response-trigger" | "inductively-unreachable-response-trigger" | "strengthened-unreachable-response-trigger" | "finite-state-unreachable-response-trigger" | "bounded-unreachable-recurrence-target" | "inductively-unreachable-recurrence-target" | "strengthened-unreachable-recurrence-target" | "finite-state-unreachable-recurrence-target" | "bounded-unreachable-stabilization-target" | "inductively-unreachable-stabilization-target" | "strengthened-unreachable-stabilization-target" | "finite-state-unreachable-stabilization-target" | "bounded-vacuous-property" | "unsupported-backend-domain" | "solver-backend-error";
  name: string;
  message: string;
  relatedName?: string;
  backend?: "z3";
  depth?: number;
  loopStart?: number;
  triggerDepth?: number;
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
  if (type === "string") return "String";
  if (type === "never") return "Int";
  if (type.kind === "set" && (type.element === "never" || supportsZ3SemanticType(type.element))) return `(Array ${smtSort(type.element)} Bool)`;
  const mapType = z3MapType(type);
  if (mapType) return mapNames(mapType).sort;
  const recordType = z3RecordType(type);
  if (recordType) return recordNames(recordType).sort;
  throw new Error("this temporal value type is not supported by the Z3 lint backend");
}

function smtStringLiteral(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("temporal SMT strings do not support control characters");
  return `"${value.replaceAll('"', '""')}"`;
}

function smtScalarLiteral(value: number | boolean | string): string {
  return typeof value === "string" ? smtStringLiteral(value) : String(value);
}

function supportsZ3SemanticType(type: TemporalValueType): boolean {
  if (typeof type === "string") return true;
  if (type.kind === "set") return type.element === "never" || supportsZ3SemanticType(type.element);
  if (type.kind === "map") return type.key !== "never" && type.value !== "never" && supportsZ3SemanticType(type.value);
  for (const field of Object.values(type.fields)) if (!supportsZ3SemanticType(field)) return false;
  return true;
}

function supportsZ3FiniteCollectionState(type: TemporalValueType): boolean {
  if (typeof type === "string") return true;
  if (type.kind === "set") return type.element === "never" || supportsZ3FiniteCollectionState(type.element);
  if (type.kind === "map") return type.key !== "never" && type.value !== "never" && supportsZ3FiniteCollectionState(type.value);
  for (const field of Object.values(type.fields)) if (!supportsZ3FiniteCollectionState(field)) return false;
  return true;
}

function finiteTypeCardinality(type: TemporalValueType | "never"): bigint | undefined {
  if (type === "bool") return 2n;
  if (type === "int") return undefined;
  if (type === "string") return undefined;
  if (type === "never") return 0n;
  if (type.kind === "record") {
    let total = 1n;
    for (const field of Object.values(type.fields)) {
      const cardinality = finiteTypeCardinality(field);
      if (cardinality === undefined) return undefined;
      total *= cardinality;
    }
    return total;
  }
  if (type.kind === "set") {
    const elements = finiteTypeCardinality(type.element);
    return elements === undefined || elements > 52n ? undefined : 2n ** elements;
  }
  if (type.key !== "bool") return undefined;
  const values = finiteTypeCardinality(type.value);
  return values === undefined ? undefined : (2n * values) ** 2n;
}

function finiteStateCompletenessDepth(spec: TemporalSpec): number | undefined {
  let states = 1n;
  for (const state of spec.states) {
    const cardinality = finiteTypeCardinality(state.type);
    if (cardinality === undefined) return undefined;
    states *= cardinality;
    if (states > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  }
  return Math.max(0, Number(states) - 1);
}

function synthesizedStrengtheningProperties(spec: TemporalSpec): TemporalSpec["properties"] {
  return spec.states.flatMap((state) => {
    const expressions = state.type === "int"
      ? [`${state.name} < 0`, `${state.name} <= 0`, `${state.name} >= 0`, `${state.name} > 0`]
      : state.type === "bool" ? [state.name, `!${state.name}`] : [];
    return expressions.map((expression) => ({
      name: `<synth:${expression}>`,
      expression,
      expressionAst: parseTemporalExpression(expression),
    }));
  });
}

interface RelationalStrengtheningSynthesisOptions {
  maxArity?: number;
  maxCoefficient?: number;
  candidateLimit?: number;
}

export interface TemporalReachabilityLintOptions {
  maxSteps?: number;
  strengtheningProperties?: readonly string[];
  discoverStrengtheningProperties?: boolean;
  synthesizeStrengtheningProperties?: boolean;
  synthesizeRelationalStrengtheningProperties?: boolean;
  relationalStrengtheningMaxArity?: number;
  relationalStrengtheningMaxCoefficient?: number;
  relationalStrengtheningCandidateLimit?: number;
  synthesizeCollectionStrengtheningProperties?: boolean;
  /** Select the common native/WASM SMT-LIB execution policy. */
  z3?: Z3ExecutionOptions;
}

export interface SpecLintWithZ3Options extends Omit<TemporalReachabilityLintOptions, "maxSteps"> {
  reachabilitySteps?: number | false;
}

function synthesizedRelationalStrengtheningProperties(
  spec: TemporalSpec,
  options: RelationalStrengtheningSynthesisOptions = {},
): TemporalSpec["properties"] {
  const integers = spec.states.filter((state) => state.type === "int");
  const initialInteger = (name: string): bigint | undefined => {
    const expression = spec.init.find((assignment) => assignment.target === name)?.expressionAst;
    if (expression?.kind === "integer") return BigInt(expression.value);
    if (expression?.kind === "unary" && expression.operator === "negate" && expression.operand.kind === "integer") return -BigInt(expression.operand.value);
    return undefined;
  };
  const requestedMaxCoefficient = options.maxCoefficient ?? 2;
  const maxCoefficient = Number.isFinite(requestedMaxCoefficient)
    ? Math.max(1, Math.min(8, Math.trunc(requestedMaxCoefficient)))
    : 2;
  const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right);
  const term = (coefficient: bigint, name: string) => coefficient === 1n ? name : `${coefficient} * ${name}`;
  const pairwiseExpressions = integers.flatMap((left, leftIndex) => integers.slice(leftIndex + 1).flatMap((right) => {
    const direct = [`${left.name} === ${right.name}`, `${left.name} <= ${right.name}`, `${left.name} >= ${right.name}`];
    const leftInitial = initialInteger(left.name), rightInitial = initialInteger(right.name);
    if (leftInitial === undefined || rightInitial === undefined) return direct;
    const coefficientPairs = Array.from({ length: maxCoefficient }, (_, left) => left + 1).flatMap((left) =>
      Array.from({ length: maxCoefficient }, (_, right) => right + 1)
        .filter((right) => gcd(left, right) === 1)
        .map((right) => [BigInt(left), BigInt(right)] as const));
    const affine = coefficientPairs.flatMap(([leftCoefficient, rightCoefficient]) => {
      const difference = leftCoefficient * leftInitial - rightCoefficient * rightInitial;
      const rightTerm = term(rightCoefficient, right.name);
      const rightWithOffset = difference > 0n ? `${rightTerm} + ${difference}` : difference < 0n ? `${rightTerm} - ${-difference}` : rightTerm;
      const leftTerm = term(leftCoefficient, left.name);
      const differenceRelations = leftCoefficient === 1n && rightCoefficient === 1n && difference === 0n
        ? []
        : [`${leftTerm} === ${rightWithOffset}`, `${leftTerm} <= ${rightWithOffset}`, `${leftTerm} >= ${rightWithOffset}`];
      const sum = leftCoefficient * leftInitial + rightCoefficient * rightInitial;
      const sumTerm = `${leftTerm} + ${rightTerm}`;
      return [
        ...differenceRelations,
        `${sumTerm} === ${sum}`,
        `${sumTerm} <= ${sum}`,
        `${sumTerm} >= ${sum}`,
      ];
    });
    return [...direct, ...affine];
  }));
  const withOffset = (left: string, right: string, difference: bigint): string => {
    const rightWithOffset = difference > 0n ? `${right} + ${difference}` : difference < 0n ? `${right} - ${-difference}` : right;
    return `${left} === ${rightWithOffset}`;
  };
  const requestedMaxArity = options.maxArity ?? 3;
  const requestedCandidateLimit = options.candidateLimit ?? 256;
  const maxArity = Number.isFinite(requestedMaxArity) ? Math.max(3, Math.min(6, Math.trunc(requestedMaxArity))) : 3;
  const candidateLimit = Number.isFinite(requestedCandidateLimit) ? Math.max(0, Math.trunc(requestedCandidateLimit)) : 256;
  const initializedIntegers = integers.flatMap((state) => {
    const initial = initialInteger(state.name);
    return initial === undefined ? [] : [{ name: state.name, initial }];
  });
  const conservationExpressions: string[] = [];
  const combinations = function* <T>(values: readonly T[], size: number, start = 0, prefix: readonly T[] = []): Generator<readonly T[]> {
    if (prefix.length === size) {
      yield prefix;
      return;
    }
    for (let index = start; index <= values.length - (size - prefix.length); index++) {
      yield* combinations(values, size, index + 1, [...prefix, values[index]!]);
    }
  };
  const coefficientVectors = function* (size: number, prefix: readonly number[] = []): Generator<readonly number[]> {
    if (prefix.length === size) {
      if (prefix.reduce(gcd) === 1) yield prefix;
      return;
    }
    for (let coefficient = 1; coefficient <= maxCoefficient; coefficient++) {
      yield* coefficientVectors(size, [...prefix, coefficient]);
    }
  };
  outer: for (let arity = 3; arity <= Math.min(maxArity, initializedIntegers.length); arity++) {
    for (const variables of combinations(initializedIntegers, arity)) {
      for (const coefficients of coefficientVectors(arity)) {
        if (conservationExpressions.length >= candidateLimit) break outer;
        const weighted = variables.map((variable, index) => ({
          ...variable,
          coefficient: BigInt(coefficients[index]!),
        }));
        conservationExpressions.push(`${weighted.map((variable) => term(variable.coefficient, variable.name)).join(" + ")} === ${weighted.reduce((sum, variable) => sum + variable.coefficient * variable.initial, 0n)}`);
      }
      // Keep the first variable on the left to emit only one of each complementary partition.
      const partitionCount = 2 ** (arity - 1);
      for (let suffixMask = 0; suffixMask < partitionCount - 1; suffixMask++) {
        if (conservationExpressions.length >= candidateLimit) break outer;
        for (const coefficients of coefficientVectors(arity)) {
          if (conservationExpressions.length >= candidateLimit) break outer;
          const left = variables.flatMap((variable, index) => index === 0 || (suffixMask & (1 << (index - 1))) !== 0
            ? [{ ...variable, coefficient: BigInt(coefficients[index]!) }]
            : []);
          const right = variables.flatMap((variable, index) => index !== 0 && (suffixMask & (1 << (index - 1))) === 0
            ? [{ ...variable, coefficient: BigInt(coefficients[index]!) }]
            : []);
          const leftInitial = left.reduce((sum, variable) => sum + variable.coefficient * variable.initial, 0n);
          const rightInitial = right.reduce((sum, variable) => sum + variable.coefficient * variable.initial, 0n);
          conservationExpressions.push(withOffset(
            left.map((variable) => term(variable.coefficient, variable.name)).join(" + "),
            right.map((variable) => term(variable.coefficient, variable.name)).join(" + "),
            leftInitial - rightInitial,
          ));
        }
      }
    }
  }
  const arithmeticSource = (expression: TemporalExpression, parentPrecedence = 0): string | undefined => {
    if (expression.kind === "name") return expression.name;
    if (expression.kind === "integer") return expression.value;
    if (expression.kind === "unary" && expression.operator === "negate") {
      const operand = arithmeticSource(expression.operand, 4);
      return operand === undefined ? undefined : `-${operand}`;
    }
    if (expression.kind !== "binary" || !["add", "subtract", "multiply"].includes(expression.operator)) return undefined;
    const precedence = expression.operator === "multiply" ? 3 : 2;
    const left = arithmeticSource(expression.left, precedence), right = arithmeticSource(expression.right, precedence + (expression.operator === "subtract" ? 1 : 0));
    if (left === undefined || right === undefined) return undefined;
    const operator = expression.operator === "add" ? "+" : expression.operator === "subtract" ? "-" : "*";
    const source = `${left} ${operator} ${right}`;
    return precedence < parentPrecedence ? `(${source})` : source;
  };
  const seededExpressions = spec.actions.flatMap((action) => {
    const candidates = (expression: TemporalExpression): TemporalExpression[] => expression.kind === "binary" && expression.operator === "and"
      ? [...candidates(expression.left), ...candidates(expression.right)]
      : [expression];
    return action.guard ? candidates(action.guard.expressionAst).flatMap((expression) => {
      if (expression.kind !== "binary" || !["neq", "lt", "lte", "gt", "gte"].includes(expression.operator)) return [];
      const withinCoefficientBound = (value: TemporalExpression): boolean => {
        if (value.kind === "binary" && value.operator === "multiply") {
          const literals = [value.left, value.right].filter((operand) => operand.kind === "integer");
          if (literals.some((literal) => BigInt(literal.kind === "integer" ? literal.value : "0") > BigInt(maxCoefficient))) return false;
          if ([value.left, value.right].some((operand) => operand.kind === "unary" && operand.operator === "negate" && operand.operand.kind === "integer")) return false;
        }
        if (value.kind === "binary") return withinCoefficientBound(value.left) && withinCoefficientBound(value.right);
        if (value.kind === "unary") return withinCoefficientBound(value.operand);
        return true;
      };
      if (!withinCoefficientBound(expression.left) || !withinCoefficientBound(expression.right)) return [];
      const left = arithmeticSource(expression.left), right = arithmeticSource(expression.right);
      if (left === undefined || right === undefined) return [];
      const references = new Set([...referencedNames(expression.left), ...referencedNames(expression.right)]);
      if (references.size < 2 || references.size > maxArity || [...references].some((name) => !integers.some((state) => state.name === name))) return [];
      const initialValue = (value: TemporalExpression): bigint | undefined => {
        if (value.kind === "integer") return BigInt(value.value);
        if (value.kind === "name") return initialInteger(value.name);
        if (value.kind === "unary" && value.operator === "negate") {
          const operand = initialValue(value.operand);
          return operand === undefined ? undefined : -operand;
        }
        if (value.kind !== "binary" || !["add", "subtract", "multiply"].includes(value.operator)) return undefined;
        const leftValue = initialValue(value.left), rightValue = initialValue(value.right);
        if (leftValue === undefined || rightValue === undefined) return undefined;
        return value.operator === "add" ? leftValue + rightValue : value.operator === "subtract" ? leftValue - rightValue : leftValue * rightValue;
      };
      const leftInitial = initialValue(expression.left), rightInitial = initialValue(expression.right);
      const equality = leftInitial !== undefined && leftInitial === rightInitial ? [`${left} === ${right}`] : [];
      const complement = expression.operator === "lt" ? `${left} >= ${right}`
        : expression.operator === "lte" ? `${left} > ${right}`
          : expression.operator === "gt" ? `${left} <= ${right}`
            : expression.operator === "gte" ? `${left} < ${right}`
              : `${left} === ${right}`;
      return [...equality, complement];
    }) : [];
  });
  const boundedConservationExpressions = [...new Set([...seededExpressions, ...conservationExpressions])].slice(0, candidateLimit);
  // Guards point directly at the relation needed to discharge the current
  // unreachable-action obligation. Keep those bounded seeds ahead of the
  // generic pairwise pool so arity-four models do not prove hundreds of
  // irrelevant candidates before reaching the load-bearing conservation law.
  const expressions = [...new Set([...boundedConservationExpressions, ...pairwiseExpressions])];
  return expressions.map((expression) => ({
    name: `<synth:${expression}>`,
    expression,
    expressionAst: parseTemporalExpression(expression),
  }));
}

function synthesizedCollectionStrengtheningProperties(spec: TemporalSpec): TemporalSpec["properties"] {
  const collections: Array<{ name: string; type: Exclude<TemporalValueType, "int" | "bool" | "string"> }> = [];
  const collect = (name: string, type: TemporalValueType): void => {
    if (typeof type === "string") return;
    collections.push({ name, type });
    if (type.kind === "record") for (const [field, fieldType] of Object.entries(type.fields)) collect(`${name}.${field}`, fieldType);
  };
  for (const state of spec.states) collect(state.name, state.type);
  const candidates = collections.flatMap((left, leftIndex) => collections.slice(leftIndex + 1).flatMap((right) => {
    if (z3TypeKey(left.type) !== z3TypeKey(right.type)) return [];
    return [{ name: `${left.name} === ${right.name}`, expression: `${left.name} === ${right.name}` }];
  }));
  const setViews = collections.flatMap(({ name, type }) => {
    if (type.kind === "set") return [{ name, type }];
    if (type.kind !== "map") return [];
    return [
      ...(type.key !== "never" ? [{ name: `${name}.keys()`, type: { kind: "set", element: type.key } as const }] : []),
      ...(type.value === "int" || type.value === "bool" || type.value === "string" ? [{ name: `${name}.values()`, type: { kind: "set", element: type.value } as const }] : []),
    ];
  });
  candidates.push(...setViews.flatMap((left, leftIndex) => setViews.slice(leftIndex + 1).flatMap((right) => {
    if (z3TypeKey(left.type) !== z3TypeKey(right.type)) return [];
    return [
      { name: `${left.name} subset ${right.name}`, expression: `${left.name}.forall(__uneffect_element => ${right.name}.contains(__uneffect_element))` },
      { name: `${right.name} subset ${left.name}`, expression: `${right.name}.forall(__uneffect_element => ${left.name}.contains(__uneffect_element))` },
    ];
  })));
  return [...new Map(candidates.map((candidate) => [candidate.name, candidate])).values()].map((candidate) => ({
    name: `<synth:${candidate.name}>`,
    expression: candidate.expression,
    expressionAst: parseTemporalExpression(candidate.expression),
  }));
}

type MapType = Extract<TemporalValueType, { kind: "map" }> & { key: "int" | "bool" | "string"; value: TemporalValueType };
type RecordType = Extract<TemporalValueType, { kind: "record" }>;
type ScalarMapType = MapType & { value: "int" | "bool" | "string" };
type ScalarRecordType = RecordType & { fields: Readonly<Record<string, "int" | "bool" | "string">> };

function z3TypeKey(type: TemporalValueType | "never"): string {
  if (typeof type === "string") return type;
  if (type.kind === "set") return `set(${z3TypeKey(type.element)})`;
  if (type.kind === "map") return `map(${type.key},${z3TypeKey(type.value)})`;
  return `record(${Object.keys(type.fields).sort().map((name) => `${name}:${z3TypeKey(type.fields[name]!)}`).join(";")})`;
}

function typeSuffix(type: TemporalValueType): string {
  return createHash("sha256").update(z3TypeKey(type)).digest("hex").slice(0, 12);
}

function mapNames(type: MapType) {
  const suffix = typeSuffix(type);
  return {
    sort: `UneffectMap_${suffix}`,
    constructor: `uneffect_map_${suffix}`,
    domain: `uneffect_map_domain_${suffix}`,
    values: `uneffect_map_values_${suffix}`,
  };
}

function scalarMapType(type: TemporalValueType | undefined): ScalarMapType | undefined {
  return type && typeof type !== "string" && type.kind === "map" && type.key !== "never"
    && (type.value === "int" || type.value === "bool" || type.value === "string") ? type as ScalarMapType : undefined;
}

function z3MapType(type: TemporalValueType | undefined): MapType | undefined {
  return type && typeof type !== "string" && type.kind === "map" && type.key !== "never" && type.value !== "never"
    && supportsZ3SemanticType(type.value) ? type as MapType : undefined;
}

function scalarRecordType(type: TemporalValueType | undefined): ScalarRecordType | undefined {
  if (!type || typeof type === "string" || type.kind !== "record") return undefined;
  for (const field of Object.values(type.fields)) if (field !== "int" && field !== "bool" && field !== "string") return undefined;
  return type as ScalarRecordType;
}

function z3RecordType(type: TemporalValueType | undefined): RecordType | undefined {
  if (!type || typeof type === "string" || type.kind !== "record") return undefined;
  for (const field of Object.values(type.fields)) if (!supportsZ3SemanticType(field)) return undefined;
  return type;
}

function recordNames(type: RecordType) {
  const fields = Object.keys(type.fields).sort();
  const suffix = typeSuffix(type);
  return {
    sort: `UneffectRecord_${suffix}`,
    constructor: `uneffect_record_${suffix}`,
    fields,
    selector: (name: string) => `uneffect_record_${suffix}_field_${fields.indexOf(name)}`,
  };
}

function z3TypeDeclarations(types: readonly TemporalValueType[]): string[] {
  const declarations = new Map<string, string>();
  const visit = (candidate: TemporalValueType | "never"): void => {
    if (typeof candidate === "string") return;
    if (candidate.kind === "set") { visit(candidate.element); return; }
    if (candidate.kind === "map") {
      visit(candidate.value);
      const type = z3MapType(candidate);
      if (!type) return;
      const names = mapNames(type);
      declarations.set(names.sort, `(declare-datatypes ((${names.sort} 0)) (((${names.constructor} (${names.domain} (Array ${smtSort(type.key)} Bool)) (${names.values} (Array ${smtSort(type.key)} ${smtSort(type.value)}))))))`);
      return;
    }
    for (const field of Object.values(candidate.fields)) visit(field);
    const type = z3RecordType(candidate);
    if (!type) return;
    const names = recordNames(type);
    const fields = names.fields.map((name) => `(${names.selector(name)} ${smtSort(type.fields[name]!)})`).join(" ");
    declarations.set(names.sort, `(declare-datatypes ((${names.sort} 0)) (((${names.constructor} ${fields}))))`);
  };
  for (const type of types) visit(type);
  return [...declarations.values()];
}

function defaultSmtValue(type: TemporalValueType | "never"): string {
  if (type === "int" || type === "never") return "0";
  if (type === "bool") return "false";
  if (type === "string") return '""';
  if (type.kind === "set") return `((as const ${smtSort(type)}) false)`;
  const mapType = z3MapType(type);
  if (mapType) {
    const names = mapNames(mapType);
    return `(${names.constructor} ((as const (Array ${smtSort(mapType.key)} Bool)) false) ((as const (Array ${smtSort(mapType.key)} ${smtSort(mapType.value)})) ${defaultSmtValue(mapType.value)}))`;
  }
  const recordType = z3RecordType(type);
  if (recordType) {
    const names = recordNames(recordType);
    return `(${names.constructor} ${names.fields.map((name) => defaultSmtValue(recordType.fields[name]!)).join(" ")})`;
  }
  throw new Error("this temporal value type has no Z3 default");
}

function z3TemporalType(expression: TemporalExpression, symbols: ReadonlyMap<string, TemporalValueType>): TemporalValueType {
  if (expression.kind === "name") {
    const type = symbols.get(expression.name);
    if (!type) throw new Error(`unknown temporal symbol \`${expression.name}\``);
    return type;
  }
  if (expression.kind === "integer") return "int";
  if (expression.kind === "boolean") return "bool";
  if (expression.kind === "string") return "string";
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
  if (expression.kind === "conditional") return z3TemporalType(expression.whenTrue, symbols);
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
    if (key !== "int" && key !== "bool" && key !== "string") throw new Error("Z3 Map keys must be scalar");
    return { kind: "map", key, value };
  }
  if (expression.kind === "method") {
    const receiver = z3TemporalType(expression.receiver, symbols);
    if (typeof receiver !== "string" && receiver.kind === "map") {
      if (expression.name === "put" || expression.name === "remove") return receiver;
      if (expression.name === "get" || expression.name === "getOrElse") {
        if (receiver.value !== "never") return receiver.value;
        return expression.name === "getOrElse"
          ? z3TemporalType(expression.arguments[1]!, symbols)
          : "int";
      }
      if (expression.name === "keys") return { kind: "set", element: receiver.key };
      if (expression.name === "values") return { kind: "set", element: receiver.value };
    }
    if (expression.name === "union" || expression.name === "exclude") return receiver;
    if (expression.name === "contains" || expression.name === "forall" || expression.name === "exists") return "bool";
    if (expression.name === "size") return "int";
  }
  throw new Error("this temporal value type is not supported by the Z3 lint backend");
}

interface FiniteCollectionUniverse {
  readonly int: number[];
  readonly bool: boolean[];
  readonly string: string[];
  readonly composite: Readonly<Record<string, readonly CompositeObservationValue[]>>;
  readonly complete: boolean;
  readonly dynamicMapLookupKeys: readonly TemporalExpression[];
  readonly unsupportedDynamicCollection: boolean;
}

interface CompositeObservationValue {
  readonly expression: TemporalExpression;
  readonly value: ModelValue;
}

function stableModelValue(value: ModelValue): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item);
}

function finiteCollectionUniverse(spec: TemporalSpec): FiniteCollectionUniverse {
  const integers = new Set<number>(), booleans = new Set<boolean>(), strings = new Set<string>();
  const composites = new Map<string, Map<string, CompositeObservationValue>>();
  let complete = true;
  let unsupportedDynamicCollection = false;
  const dynamicMapLookupKeys: TemporalExpression[] = [];
  const literal = (expression: TemporalExpression): number | boolean | string | undefined => {
    if (expression.kind === "integer") return Number(expression.value);
    if (expression.kind === "boolean") return expression.value;
    if (expression.kind === "string") return expression.value;
    if (expression.kind === "unary" && expression.operator === "negate" && expression.operand.kind === "integer") return -Number(expression.operand.value);
    return undefined;
  };
  const recordLiteral = (expression: TemporalExpression): ModelValue | undefined => {
    if (expression.kind !== "record" || expression.base) return undefined;
    const fields: Record<string, ModelValue> = {};
    for (const [name, field] of Object.entries(expression.fields)) {
      const value = literal(field);
      if (value === undefined) return undefined;
      fields[name] = value;
    }
    return fields;
  };
  const addComposite = (expression: TemporalExpression): boolean => {
    const value = recordLiteral(expression);
    if (value === undefined) return false;
    const type = z3TemporalType(expression, new Map());
    const key = z3TypeKey(type);
    const values = composites.get(key) ?? new Map<string, CompositeObservationValue>();
    values.set(stableModelValue(value), { expression, value });
    composites.set(key, values);
    return true;
  };
  const visit = (expression: TemporalExpression): void => {
    if (expression.kind === "call" && expression.name === "Set") for (const item of expression.arguments) {
      const value = literal(item);
      if (typeof value === "number") integers.add(value);
      else if (typeof value === "boolean") booleans.add(value);
      else if (typeof value === "string") strings.add(value);
      else if (!addComposite(item)) { complete = false; unsupportedDynamicCollection = true; }
    }
    if (expression.kind === "call" && expression.name === "Map") {
      const entries = expression.arguments[0];
      if (!entries || entries.kind !== "array") { complete = false; unsupportedDynamicCollection = true; }
      else for (const pair of entries.elements) {
        if (pair.kind !== "array" || pair.elements.length !== 2) {
          complete = false;
          unsupportedDynamicCollection = true;
          continue;
        }
        const key = literal(pair.elements[0]!);
        if (typeof key === "number") integers.add(key);
        else if (typeof key === "boolean") booleans.add(key);
        else if (typeof key === "string") strings.add(key);
        else { complete = false; unsupportedDynamicCollection = true; }
      }
    }
    if (expression.kind === "method" && (expression.name === "put" || expression.name === "remove"
      || expression.name === "get" || expression.name === "getOrElse")) {
      const key = literal(expression.arguments[0]!);
      if (typeof key === "number") integers.add(key);
      else if (typeof key === "boolean") booleans.add(key);
      else if (typeof key === "string") strings.add(key);
      else {
        complete = false;
        if (expression.name === "getOrElse") dynamicMapLookupKeys.push(expression.arguments[0]!);
        else unsupportedDynamicCollection = true;
      }
    }
    if (expression.kind === "unary") visit(expression.operand);
    else if (expression.kind === "binary") { visit(expression.left); visit(expression.right); }
    else if (expression.kind === "conditional") { visit(expression.condition); visit(expression.whenTrue); visit(expression.whenFalse); }
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
  for (const property of spec.liveness) visit(property.expressionAst);
  for (const property of spec.recurrences) visit(property.expressionAst);
  for (const property of spec.stabilizations) visit(property.expressionAst);
  for (const property of spec.responses) { visit(property.triggerAst); visit(property.responseAst); }
  return {
    int: [...integers].sort((a, b) => a - b),
    bool: [...booleans].sort((a, b) => Number(a) - Number(b)),
    string: [...strings].sort(),
    composite: Object.fromEntries([...composites].map(([key, values]) => [key, [...values.values()]])),
    complete,
    dynamicMapLookupKeys,
    unsupportedDynamicCollection,
  };
}

interface ProvedFiniteCollectionUniverse {
  readonly universe: FiniteCollectionUniverse;
  readonly evidence: readonly TemporalObservationDomainEvidence[];
}

function scalarLiteralValue(expression: TemporalExpression): number | boolean | string | undefined {
  if (expression.kind === "integer") return Number(expression.value);
  if (expression.kind === "boolean") return expression.value;
  if (expression.kind === "string") return expression.value;
  if (expression.kind === "unary" && expression.operator === "negate" && expression.operand.kind === "integer") {
    return -Number(expression.operand.value);
  }
  return undefined;
}

async function proveFiniteCollectionUniverse(
  spec: TemporalSpec,
  universe: FiniteCollectionUniverse,
  options: Z3ExecutionOptions,
): Promise<ProvedFiniteCollectionUniverse | undefined> {
  if (universe.complete) return { universe, evidence: [] };
  if (universe.unsupportedDynamicCollection || universe.dynamicMapLookupKeys.length === 0) return undefined;
  const keyNames = new Set(universe.dynamicMapLookupKeys.map((key) => key.kind === "name" ? key.name : undefined));
  if (keyNames.has(undefined)) return undefined;
  const keys = [...keyNames].sort() as string[];
  if (keys.length === 0) return undefined;
  const candidates = keys.map((keyState) => {
    const keyType = spec.states.find((state) => state.name === keyState)?.type;
    if (keyType !== "int" && keyType !== "bool" && keyType !== "string") return undefined;
    const matching = spec.states.flatMap((state) => {
      if (typeof state.type === "string" || state.type.kind !== "set" || state.type.element !== keyType) return [];
      const initializer = spec.init.find((assignment) => assignment.target === state.name)?.expressionAst;
      if (!initializer || initializer.kind !== "call" || initializer.name !== "Set" || initializer.arguments.length === 0) return [];
      const parsedValues = initializer.arguments.map(scalarLiteralValue);
      if (parsedValues.some((value) => value === undefined)) return [];
      const values = [...new Set(parsedValues as (number | boolean | string)[])].sort((left, right) => {
        if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
        if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
        return Number(left) - Number(right);
      });
      if (spec.actions.some((action) => action.assignments.some((assignment) => assignment.target === state.name
        && !(assignment.expressionAst.kind === "name" && assignment.expressionAst.name === state.name)))) return [];
      const properties = spec.properties.filter((property) => {
        const expression = property.expressionAst;
        return expression.kind === "method" && expression.name === "contains"
          && expression.receiver.kind === "name" && expression.receiver.name === state.name
          && expression.arguments.length === 1
          && expression.arguments[0]?.kind === "name" && expression.arguments[0].name === keyState;
      });
      return properties.length === 1 ? [{
        domainState: state.name,
        initializer,
        keyState,
        property: properties[0]!,
        values,
      }] : [];
    });
    return matching.length === 1 ? matching[0] : undefined;
  });
  const provedCandidates = candidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined,
  );
  if (provedCandidates.length !== candidates.length) return undefined;

  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  const at = (name: string, step: number) => `uneffect_domain_${step}_${name}`;
  const declarations = [
    ...z3TypeDeclarations(spec.states.map((state) => state.type)),
    ...[0, 1].flatMap((step) => spec.states.map((state) => `(declare-const ${at(state.name, step)} ${smtSort(state.type)})`)),
  ];
  const init = spec.init.map((assignment) =>
    `(= ${at(assignment.target, 0)} ${temporalAtStepToSmt(
      assignment.expressionAst, "uneffect_domain", 0, symbols, symbols.get(assignment.target),
    )})`);
  const propertyAt = (candidate: NonNullable<typeof candidates[number]>, step: number) => temporalAtStepToSmt(
    candidate.property.expressionAst, "uneffect_domain", step, symbols,
  );
  const domainAt = (candidate: NonNullable<typeof candidates[number]>, step: number) => `(= ${at(candidate.domainState, step)} ${temporalAtStepToSmt(
    candidate.initializer, "uneffect_domain", step, symbols, symbols.get(candidate.domainState),
  )})`;
  const transitions = spec.actions.map((action) => {
    const assignments = new Map(action.assignments.map((assignment) => [assignment.target, assignment]));
    const guard = action.guard ? temporalAtStepToSmt(action.guard.expressionAst, "uneffect_domain", 0, symbols) : "true";
    const updates = spec.states.map((state) => {
      const assignment = assignments.get(state.name);
      const value = assignment
        ? temporalAtStepToSmt(assignment.expressionAst, "uneffect_domain", 0, symbols, state.type)
        : at(state.name, 0);
      return `(= ${at(state.name, 1)} ${value})`;
    });
    return `(and ${guard} ${updates.join(" ")})`;
  });
  const transition = transitions.length === 0 ? "false" : transitions.length === 1 ? transitions[0]! : `(or ${transitions.join(" ")})`;
  const run = async (assertions: readonly string[]): Promise<Z3Execution> => executeZ3([
      "(set-logic ALL)", ...declarations, ...assertions.map((assertion) => `(assert ${assertion})`),
    ].join("\n"), options);
  const initExecution = await run(init);
  if (initExecution.status !== "sat") return undefined;
  const initiationExecutions: Z3Execution[] = [];
  const preservationExecutions: Z3Execution[] = [];
  for (const candidate of provedCandidates) {
    const initiationExecution = await run([...init, `(not ${propertyAt(candidate, 0)})`]);
    if (initiationExecution.status !== "unsat") return undefined;
    initiationExecutions.push(initiationExecution);
    const preservationExecution = await run([
      domainAt(candidate, 0), propertyAt(candidate, 0), transition, `(not ${propertyAt(candidate, 1)})`,
    ]);
    preservationExecutions.push(preservationExecution);
  }
  const independentlyPreserved = preservationExecutions.every((execution) => execution.status === "unsat");
  const preservationAssumptions = provedCandidates.map((candidate) => candidate.property.name);
  const jointPreservationExecution = independentlyPreserved ? undefined : await run([
    ...provedCandidates.map((candidate) => domainAt(candidate, 0)),
    ...provedCandidates.map((candidate) => propertyAt(candidate, 0)),
    transition,
    `(not (and ${provedCandidates.map((candidate) => propertyAt(candidate, 1)).join(" ")}))`,
  ]);
  if (!independentlyPreserved && jointPreservationExecution?.status !== "unsat") return undefined;

  const evidence: TemporalObservationDomainEvidence[] = provedCandidates.map((candidate, index) => {
    const initiationExecution = initiationExecutions[index]!;
    const preservationExecution = preservationExecutions[index]!;
    const effectivePreservation = independentlyPreserved ? preservationExecution : jointPreservationExecution!;
    return {
      rule: independentlyPreserved
        ? "inductively-proved-finite-membership"
        : "jointly-inductive-finite-membership",
      domainState: candidate.domainState,
      keyState: candidate.keyState,
      property: candidate.property.name,
      values: candidate.values,
      proof: {
        initSatisfiable: "verified",
        membershipInitiation: "verified",
        domainStability: "verified-by-syntax",
        membershipPreservation: independentlyPreserved ? "verified" : "verified-jointly",
        ...(!independentlyPreserved ? { preservationAssumptions } : {}),
        solverChecks: [
          { obligation: "init-satisfiable", result: "sat", backend: initExecution.backend, version: initExecution.version },
          { obligation: "membership-initiation", result: "unsat", backend: initiationExecution.backend, version: initiationExecution.version },
          {
            obligation: independentlyPreserved ? "membership-preservation" : "joint-membership-preservation",
            result: "unsat",
            backend: effectivePreservation.backend,
            version: effectivePreservation.version,
          },
        ],
      },
    };
  });

  return {
    universe: { ...universe, complete: true },
    evidence,
  };
}

function supportsZ3Expression(expression: TemporalExpression): boolean {
  if (expression.kind === "string") return !/[\u0000-\u001f\u007f]/u.test(expression.value);
  if (expression.kind === "method" && expression.name === "size") return false;
  if (expression.kind === "unary") return supportsZ3Expression(expression.operand);
  if (expression.kind === "binary") return supportsZ3Expression(expression.left) && supportsZ3Expression(expression.right);
  if (expression.kind === "conditional") return supportsZ3Expression(expression.condition) && supportsZ3Expression(expression.whenTrue) && supportsZ3Expression(expression.whenFalse);
  if (expression.kind === "array") return expression.elements.every(supportsZ3Expression);
  if (expression.kind === "record") {
    if (expression.base && !supportsZ3Expression(expression.base)) return false;
    return Object.values(expression.fields).every(supportsZ3Expression);
  }
  if (expression.kind === "field") return supportsZ3Expression(expression.receiver);
  if (expression.kind === "lambda") return supportsZ3Expression(expression.body);
  if (expression.kind === "call") return expression.arguments.every(supportsZ3Expression);
  if (expression.kind === "method") return supportsZ3Expression(expression.receiver) && expression.arguments.every(supportsZ3Expression);
  return true;
}

function supportsZ3SpecExpressions(spec: TemporalSpec): boolean {
  for (const assignment of [...spec.init, ...spec.actions.flatMap((action) => action.assignments)]) if (!supportsZ3Expression(assignment.expressionAst)) return false;
  for (const action of spec.actions) if (action.guard && !supportsZ3Expression(action.guard.expressionAst)) return false;
  for (const property of spec.properties) if (!supportsZ3Expression(property.expressionAst)) return false;
  for (const property of spec.liveness) if (!supportsZ3Expression(property.expressionAst)) return false;
  for (const property of spec.recurrences) if (!supportsZ3Expression(property.expressionAst)) return false;
  for (const property of spec.stabilizations) if (!supportsZ3Expression(property.expressionAst)) return false;
  for (const property of spec.responses) if (!supportsZ3Expression(property.triggerAst) || !supportsZ3Expression(property.responseAst)) return false;
  return true;
}

function temporalExpressionAtStep(
  expression: TemporalExpression,
  prefix: string,
  step: number,
  boundNames: ReadonlySet<string> = new Set(),
): TemporalExpression {
  if (expression.kind === "name") return boundNames.has(expression.name)
    ? expression : { ...expression, name: `${prefix}_${step}_${expression.name}` };
  if (expression.kind === "integer" || expression.kind === "boolean" || expression.kind === "string") return expression;
  if (expression.kind === "unary") return {
    ...expression, operand: temporalExpressionAtStep(expression.operand, prefix, step, boundNames),
  };
  if (expression.kind === "binary") return {
    ...expression,
    left: temporalExpressionAtStep(expression.left, prefix, step, boundNames),
    right: temporalExpressionAtStep(expression.right, prefix, step, boundNames),
  };
  if (expression.kind === "conditional") return {
    ...expression,
    condition: temporalExpressionAtStep(expression.condition, prefix, step, boundNames),
    whenTrue: temporalExpressionAtStep(expression.whenTrue, prefix, step, boundNames),
    whenFalse: temporalExpressionAtStep(expression.whenFalse, prefix, step, boundNames),
  };
  if (expression.kind === "array") return {
    ...expression,
    elements: expression.elements.map((item) => temporalExpressionAtStep(item, prefix, step, boundNames)),
  };
  if (expression.kind === "record") return {
    ...expression,
    ...(expression.base ? { base: temporalExpressionAtStep(expression.base, prefix, step, boundNames) } : {}),
    fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [
      name, temporalExpressionAtStep(value, prefix, step, boundNames),
    ])),
  };
  if (expression.kind === "field") return {
    ...expression, receiver: temporalExpressionAtStep(expression.receiver, prefix, step, boundNames),
  };
  if (expression.kind === "lambda") return {
    ...expression,
    body: temporalExpressionAtStep(expression.body, prefix, step, new Set(boundNames).add(expression.parameter)),
  };
  if (expression.kind === "call") return {
    ...expression,
    arguments: expression.arguments.map((argument) => temporalExpressionAtStep(argument, prefix, step, boundNames)),
  };
  return {
    ...expression,
    receiver: temporalExpressionAtStep(expression.receiver, prefix, step, boundNames),
    arguments: expression.arguments.map((argument) => temporalExpressionAtStep(argument, prefix, step, boundNames)),
  };
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
  if (expression.kind === "string") return smtStringLiteral(expression.value);
  if (expression.kind === "unary") return expression.operator === "not" ? `(not ${temporalToSmt(expression.operand, resolveName, symbols, undefined, boundName)})` : `(- ${temporalToSmt(expression.operand, resolveName, symbols, undefined, boundName)})`;
  if (expression.kind === "conditional") return `(ite ${temporalToSmt(expression.condition, resolveName, symbols, undefined, boundName)} ${temporalToSmt(expression.whenTrue, resolveName, symbols, expected, boundName)} ${temporalToSmt(expression.whenFalse, resolveName, symbols, expected, boundName)})`;
  if (expression.kind === "call" && expression.name === "Set") {
    const type = expression.arguments.length === 0 ? expected : z3TemporalType(expression, symbols);
    if (!type || typeof type === "string" || type.kind !== "set" || !supportsZ3SemanticType(type)) throw new Error("Z3 Set literals require a scalar Set type");
    let set = `((as const ${smtSort(type)}) false)`;
    for (const item of expression.arguments) set = `(store ${set} ${temporalToSmt(item, resolveName, symbols, undefined, boundName)} true)`;
    return set;
  }
  if (expression.kind === "call" && expression.name === "Map") {
    const type = z3MapType(expression.arguments[0]?.kind === "array" && expression.arguments[0].elements.length === 0 ? expected : z3TemporalType(expression, symbols));
    const entries = expression.arguments[0];
    if (!type || !entries || entries.kind !== "array") throw new Error("Z3 Map literals require a scalar Map type");
    const names = mapNames(type);
    let domain = `((as const (Array ${smtSort(type.key)} Bool)) false)`;
    const defaultValue = defaultSmtValue(type.value);
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
    const type = z3RecordType(expected ?? z3TemporalType(expression, symbols));
    if (!type) throw new Error("Z3 record literal type is not supported");
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
    const type = z3RecordType(z3TemporalType(expression.receiver, symbols));
    if (!type || !type.fields[expression.name]) throw new Error(`unknown Z3 record field \`${expression.name}\``);
    const names = recordNames(type);
    return `(${names.selector(expression.name)} ${temporalToSmt(expression.receiver, resolveName, symbols, type, boundName)})`;
  }
  if (expression.kind === "method") {
    const receiverType = z3TemporalType(expression.receiver, symbols);
    const mapType = z3MapType(receiverType);
    if (mapType) {
      const names = mapNames(mapType);
      const receiver = temporalToSmt(expression.receiver, resolveName, symbols, mapType, boundName);
      if (expression.name === "put") {
        const key = temporalToSmt(expression.arguments[0]!, resolveName, symbols, undefined, boundName);
        const value = temporalToSmt(expression.arguments[1]!, resolveName, symbols, undefined, boundName);
        return `(${names.constructor} (store (${names.domain} ${receiver}) ${key} true) (store (${names.values} ${receiver}) ${key} ${value}))`;
      }
      if (expression.name === "remove") {
        const key = temporalToSmt(expression.arguments[0]!, resolveName, symbols, undefined, boundName);
        return `(${names.constructor} (store (${names.domain} ${receiver}) ${key} false) (store (${names.values} ${receiver}) ${key} ${defaultSmtValue(mapType.value)}))`;
      }
      if (expression.name === "get") {
        const key = temporalToSmt(expression.arguments[0]!, resolveName, symbols, undefined, boundName);
        return `(select (${names.values} ${receiver}) ${key})`;
      }
      if (expression.name === "getOrElse") {
        const key = temporalToSmt(expression.arguments[0]!, resolveName, symbols, undefined, boundName);
        const fallback = temporalToSmt(
          expression.arguments[1]!, resolveName, symbols, mapType.value, boundName,
        );
        return `(ite (select (${names.domain} ${receiver}) ${key}) (select (${names.values} ${receiver}) ${key}) ${fallback})`;
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
    if (expression.name === "exclude") return `((_ map and) ${receiver} ((_ map not) ${temporalToSmt(expression.arguments[0]!, resolveName, symbols, receiverType, boundName)}))`;
    if (expression.name === "forall") {
      const predicate = expression.arguments[0];
      if (!predicate || predicate.kind !== "lambda") throw new Error("Z3 Set forall requires a lambda");
      const scoped = new Map(symbols);
      scoped.set(predicate.parameter, receiverType.element === "never" ? "int" : receiverType.element);
      return `(forall ((${predicate.parameter} ${smtSort(receiverType.element)})) (=> (select ${receiver} ${predicate.parameter}) ${temporalToSmt(predicate.body, resolveName, scoped, undefined, predicate.parameter)}))`;
    }
    if (expression.name === "exists") {
      const predicate = expression.arguments[0];
      if (!predicate || predicate.kind !== "lambda") throw new Error("Z3 Set exists requires a lambda");
      const scoped = new Map(symbols);
      scoped.set(predicate.parameter, receiverType.element === "never" ? "int" : receiverType.element);
      return `(exists ((${predicate.parameter} ${smtSort(receiverType.element)})) (and (select ${receiver} ${predicate.parameter}) ${temporalToSmt(predicate.body, resolveName, scoped, undefined, predicate.parameter)}))`;
    }
    throw new Error(`Z3 Set method \`${expression.name}\` is not supported`);
  }
  if (expression.kind === "array" || expression.kind === "lambda" || expression.kind === "call") throw new Error("this collection temporal expression is not supported by the Z3 lint backend");
  if (expression.operator === "neq") return `(not (= ${temporalToSmt(expression.left, resolveName, symbols, undefined, boundName)} ${temporalToSmt(expression.right, resolveName, symbols, undefined, boundName)}))`;
  return `(${smtBinaryOperator(expression.operator)} ${temporalToSmt(expression.left, resolveName, symbols, undefined, boundName)} ${temporalToSmt(expression.right, resolveName, symbols, undefined, boundName)})`;
}

function temporalAtStepToSmt(
  expression: TemporalExpression,
  prefix: string,
  step: number,
  symbols: ReadonlyMap<string, TemporalValueType>,
  expected?: TemporalValueType,
): string {
  const steppedSymbols = new Map([...symbols].map(([name, type]) => [`${prefix}_${step}_${name}`, type]));
  return temporalToSmt(temporalExpressionAtStep(expression, prefix, step), undefined, steppedSymbols, expected);
}

async function executeCheck(spec: TemporalSpec, assertions: readonly string[], options: Z3ExecutionOptions = {}): Promise<Z3Execution> {
  const declarations = [...z3TypeDeclarations(spec.states.map((state) => state.type)), ...spec.states.map((state) => `(declare-const ${state.name} ${smtSort(state.type)})`)];
  return executeZ3(["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`)].join("\n"), options);
}

async function check(spec: TemporalSpec, assertions: readonly string[]): Promise<"sat" | "unsat" | "unknown"> {
  const status = (await executeCheck(spec, assertions)).status;
  return status === "error" ? "unknown" : status;
}

export type TemporalEquivalenceResult =
  | { status: "equivalent"; backend: "z3" }
  | { status: "different"; backend: "z3" }
  | { status: "unknown"; backend: "z3"; reason: string };

/** Proves typed scalar equivalence over every state valuation, independently of reachability. */
export async function checkTemporalExpressionEquivalenceWithZ3(
  spec: TemporalSpec,
  left: TemporalExpression,
  right: TemporalExpression,
  options: Z3ExecutionOptions = {},
): Promise<TemporalEquivalenceResult> {
  return checkTemporalExpressionEquivalenceUnderAssumptionsWithZ3(spec, left, right, [], options);
}

/** Proves scalar equivalence only inside an explicit, reviewable predicate domain. */
export async function checkTemporalExpressionEquivalenceUnderAssumptionsWithZ3(
  spec: TemporalSpec,
  left: TemporalExpression,
  right: TemporalExpression,
  assumptions: readonly TemporalExpression[],
  options: Z3ExecutionOptions = {},
): Promise<TemporalEquivalenceResult> {
  if (spec.states.some((state) => !supportsZ3SemanticType(state.type)) || !supportsZ3Expression(left) || !supportsZ3Expression(right)) {
    return { status: "unknown", backend: "z3", reason: "unsupported-backend-domain" };
  }
  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  try {
    const leftType = typeCheckTemporalExpression(left, symbols);
    const rightType = typeCheckTemporalExpression(right, symbols);
    if ((leftType !== "bool" && leftType !== "int") || leftType !== rightType) {
      return { status: "unknown", backend: "z3", reason: "equivalence-requires-matching-scalar-expressions" };
    }
    if (assumptions.some((assumption) => !supportsZ3Expression(assumption)
      || typeCheckTemporalExpression(assumption, symbols) !== "bool")) {
      return { status: "unknown", backend: "z3", reason: "equivalence-assumptions-require-boolean-expressions" };
    }
    const unequal = `(not (= ${temporalToSmt(left, (name) => name, symbols)} ${temporalToSmt(right, (name) => name, symbols)}))`;
    const execution = await executeCheck(spec, [
      ...assumptions.map((assumption) => temporalToSmt(assumption, (name) => name, symbols, "bool")),
      unequal,
    ], options);
    const status = execution.status;
    return status === "unsat"
      ? { status: "equivalent", backend: "z3" }
      : status === "sat"
        ? { status: "different", backend: "z3" }
        : { status: "unknown", backend: "z3", reason: status === "error"
          ? `solver-${execution.failureKind ?? "error"}: ${execution.stderr}`
          : "solver-returned-unknown" };
  } catch (error) {
    return { status: "unknown", backend: "z3", reason: error instanceof Error ? error.message : String(error) };
  }
}

export type TemporalCounterexampleResult =
  | { status: "counterexample"; depth: number; trace: ModelCounterexample; observationDomains?: readonly TemporalObservationDomainEvidence[] }
  | { status: "safe-within-bound"; depth: number; observationDomains?: readonly TemporalObservationDomainEvidence[] }
  | { status: "unknown"; depth: number };

export interface TemporalObservationDomainEvidence {
  readonly rule: "inductively-proved-finite-membership" | "jointly-inductive-finite-membership";
  readonly domainState: string;
  readonly keyState: string;
  readonly property: string;
  readonly values: readonly (number | boolean | string)[];
  readonly proof: {
    readonly initSatisfiable: "verified";
    readonly membershipInitiation: "verified";
    readonly domainStability: "verified-by-syntax";
    readonly membershipPreservation: "verified" | "verified-jointly";
    readonly preservationAssumptions?: readonly string[];
    readonly solverChecks: readonly {
      readonly obligation: "init-satisfiable" | "membership-initiation" | "membership-preservation" | "joint-membership-preservation";
      readonly result: "sat" | "unsat";
      readonly backend: Z3Backend;
      readonly version: string;
    }[];
  };
}

function parseZ3TemporalValue(value: string, type: "int" | "bool" | "string"): number | boolean | string {
  if (type === "bool") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Z3 returned a non-boolean temporal value: ${value}`);
  }
  if (type === "string") {
    if (!value.startsWith('"') || !value.endsWith('"')) throw new Error(`Z3 returned a non-string temporal value: ${value}`);
    return value.slice(1, -1).replaceAll('""', '"');
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

type FiniteUniverse = ReturnType<typeof finiteCollectionUniverse>;

function observationValues(type: "int" | "bool" | "string" | "never", universe: FiniteUniverse): readonly (number | boolean | string)[] {
  return type === "bool" ? universe.bool : type === "string" ? universe.string : universe.int;
}

function compositeObservationValues(type: TemporalValueType, universe: FiniteUniverse): readonly CompositeObservationValue[] {
  return universe.composite[z3TypeKey(type)] ?? [];
}

function observationSetValues(type: TemporalValueType | "never", universe: FiniteUniverse): readonly (number | boolean | string | CompositeObservationValue)[] {
  return type === "never" ? [] : typeof type === "string" ? observationValues(type, universe) : compositeObservationValues(type, universe);
}

function observationValueSmt(value: number | boolean | string | CompositeObservationValue, type: TemporalValueType | "never"): string {
  if (typeof value !== "object") return smtScalarLiteral(value);
  return temporalToSmt(value.expression, () => { throw new Error("finite composite observation literals cannot reference state"); }, new Map(), type === "never" ? undefined : type);
}

function z3ObservationDeclarations(prefix: string, expression: string, type: TemporalValueType, universe: FiniteUniverse): string[] {
  if (typeof type === "string") return [`(declare-const ${prefix} ${smtSort(type)})`, `(assert (= ${prefix} ${expression}))`];
  if (type.kind === "set") {
    const values = observationSetValues(type.element, universe);
    if (type.element !== "never" && typeof type.element !== "string" && values.length === 0) throw new Error("Z3 counterexample observation requires an exact finite composite Set universe");
    return values.flatMap((value, index) => [
      `(declare-const ${prefix}__member__${index} Bool)`,
      `(assert (= ${prefix}__member__${index} (select ${expression} ${observationValueSmt(value, type.element)})))`,
    ]);
  }
  if (type.kind === "map") {
    const mapType = z3MapType(type);
    if (!mapType) throw new Error("Z3 counterexample observation requires a supported Map");
    const names = mapNames(mapType);
    return observationValues(mapType.key, universe).flatMap((key, index) => [
      `(declare-const ${prefix}__member__${index} Bool)`,
      `(assert (= ${prefix}__member__${index} (select (${names.domain} ${expression}) ${smtScalarLiteral(key)})))`,
      ...z3ObservationDeclarations(`${prefix}__value__${index}`, `(select (${names.values} ${expression}) ${smtScalarLiteral(key)})`, mapType.value, universe),
    ]);
  }
  const recordType = z3RecordType(type);
  if (!recordType) throw new Error("Z3 counterexample observation requires a supported record");
  const names = recordNames(recordType);
  return names.fields.flatMap((field, index) => z3ObservationDeclarations(
    `${prefix}__field__${index}`, `(${names.selector(field)} ${expression})`, recordType.fields[field]!, universe,
  ));
}

function z3ObservationRequests(prefix: string, type: TemporalValueType, universe: FiniteUniverse): Z3ValueRequest[] {
  if (typeof type === "string") return [{ name: prefix, expression: prefix, sort: type === "int" ? "Int" : type === "bool" ? "Bool" : "String" }];
  if (type.kind === "set") {
    const values = observationSetValues(type.element, universe);
    if (type.element !== "never" && typeof type.element !== "string" && values.length === 0) throw new Error("Z3 counterexample observation requires an exact finite composite Set universe");
    return values.map((_value, index) => ({ name: `${prefix}__member__${index}`, expression: `${prefix}__member__${index}`, sort: "Bool" }));
  }
  if (type.kind === "map") {
    const mapType = z3MapType(type);
    if (!mapType) throw new Error("Z3 counterexample observation requires a supported Map");
    return observationValues(mapType.key, universe).flatMap((_key, index) => [
      { name: `${prefix}__member__${index}`, expression: `${prefix}__member__${index}`, sort: "Bool" as const },
      ...z3ObservationRequests(`${prefix}__value__${index}`, mapType.value, universe),
    ]);
  }
  const recordType = z3RecordType(type);
  if (!recordType) throw new Error("Z3 counterexample observation requires a supported record");
  const names = recordNames(recordType);
  return names.fields.flatMap((field, index) => z3ObservationRequests(`${prefix}__field__${index}`, recordType.fields[field]!, universe));
}

function decodeZ3Observation(values: Readonly<Record<string, string>>, prefix: string, type: TemporalValueType, universe: FiniteUniverse): any {
  if (typeof type === "string") {
    const value = values[prefix];
    if (value === undefined) throw new Error(`Z3 omitted temporal observation ${prefix}`);
    return parseZ3TemporalValue(value, type);
  }
  if (type.kind === "set") {
    const candidates = observationSetValues(type.element, universe);
    if (type.element !== "never" && typeof type.element !== "string" && candidates.length === 0) throw new Error("Z3 counterexample observation requires an exact finite composite Set universe");
    return candidates.filter((_value, index) => values[`${prefix}__member__${index}`] === "true")
      .map((value) => typeof value === "object" ? value.value : value)
      .sort((left, right) => stableModelValue(left).localeCompare(stableModelValue(right)));
  }
  if (type.kind === "map") {
    const mapType = z3MapType(type);
    if (!mapType) throw new Error("Z3 counterexample observation requires a supported Map");
    return observationValues(mapType.key, universe).flatMap((key, index) => {
      if (values[`${prefix}__member__${index}`] !== "true") return [];
      return [[key, decodeZ3Observation(values, `${prefix}__value__${index}`, mapType.value, universe)]];
    });
  }
  const recordType = z3RecordType(type);
  if (!recordType) throw new Error("Z3 counterexample observation requires a supported record");
  const names = recordNames(recordType);
  return Object.fromEntries(names.fields.map((field, index) => [
    field, decodeZ3Observation(values, `${prefix}__field__${index}`, recordType.fields[field]!, universe),
  ]));
}

/** Finds the shortest bounded safety violation and extracts its chosen actions and states. */
export async function findTemporalCounterexampleWithZ3(
  spec: TemporalSpec,
  propertyName: string,
  options: { maxSteps?: number; z3?: Z3ExecutionOptions } = {},
): Promise<TemporalCounterexampleResult> {
  const property = spec.properties.find((candidate) => candidate.name === propertyName);
  if (!property) throw new Error(`unknown temporal property: ${propertyName}`);
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new Error(`maxSteps must be a non-negative safe integer, got ${maxSteps}`);
  if (!supportsZ3SpecExpressions(spec)) return { status: "unknown", depth: 0 };
  if (spec.states.some((state) => !supportsZ3FiniteCollectionState(state.type))) return { status: "unknown", depth: 0 };
  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  const provedUniverse = await proveFiniteCollectionUniverse(spec, finiteCollectionUniverse(spec), options.z3 ?? {});
  if (!provedUniverse) return { status: "unknown", depth: 0 };
  const { universe, evidence: observationDomains } = provedUniverse;
  const at = (name: string, step: number) => `${name}__${step}`;
  const actionAt = (step: number) => `uneffect_action__${step}`;
  const stateDeclarations = Array.from({ length: maxSteps + 1 }, (_, step) => spec.states.map((state) => `(declare-const ${at(state.name, step)} ${smtSort(state.type)})`)).flat();
  const actionDeclarations = Array.from({ length: maxSteps }, (_, step) => `(declare-const ${actionAt(step)} Int)`);
  const observationAt = (name: string, step: number) => `${at(name, step)}__observation`;
  const observationViews = Array.from({ length: maxSteps + 1 }, (_, step) => spec.states.flatMap((state) =>
    z3ObservationDeclarations(observationAt(state.name, step), at(state.name, step), state.type, universe))).flat();
  const declarations = [...z3TypeDeclarations(spec.states.map((state) => state.type)), ...stateDeclarations, ...actionDeclarations, ...observationViews];
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
  for (let depth = 0; depth <= maxSteps; depth++) {
    if (depth > 0 && spec.actions.length === 0) break;
    const assertions = [
      ...init,
      ...Array.from({ length: depth }, (_, step) => transition(step)),
      `(not ${temporalToSmt(property.expressionAst, (name) => at(name, depth), symbols)})`,
    ];
    const program = ["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`)].join("\n");
    const requests = [
      ...Array.from({ length: depth + 1 }, (_, step) => spec.states.flatMap((state) => z3ObservationRequests(observationAt(state.name, step), state.type, universe))).flat(),
      ...Array.from({ length: depth }, (_, step): Z3ValueRequest => ({ name: actionAt(step), expression: actionAt(step), sort: "Int" })),
    ];
    const execution = await executeZ3(program, { ...options.z3, values: requests });
    if (execution.status === "unknown" || execution.status === "error") return { status: "unknown", depth };
    if (execution.status !== "sat") continue;
    const values = execution.values;
    if (!values) return { status: "unknown", depth };
    const states: ModelState[] = Array.from({ length: depth + 1 }, (_, step) => Object.fromEntries(spec.states.map((state) => [
      state.name, decodeZ3Observation(values, observationAt(state.name, step), state.type, universe),
    ])));
    const actions = Array.from({ length: depth }, (_, step) => {
      const selectedValue = values[actionAt(step)];
      if (selectedValue === undefined) throw new Error(`Z3 omitted temporal action ${actionAt(step)}`);
      const selected = parseZ3TemporalValue(selectedValue, "int") as number;
      const action = spec.actions[selected];
      if (!action) throw new Error(`Z3 selected invalid temporal action ${selected} at step ${step}`);
      return action.name;
    });
    const modelHash = createHash("sha256").update(program).digest("hex");
    const trace = createModelCounterexample({
      backend: "z3", modelHash, initialState: states[0]!,
      steps: actions.map((action, index) => ({ action, before: states[index]!, after: states[index + 1]! })),
    });
    return {
      status: "counterexample", depth, trace,
      ...(observationDomains.length > 0 ? { observationDomains } : {}),
    };
  }
  return {
    status: "safe-within-bound", depth: maxSteps,
    ...(observationDomains.length > 0 ? { observationDomains } : {}),
  };
}

/** Bounded transition reachability. An unreachable result is only a depth-bounded finding. */
export async function lintTemporalReachabilityWithZ3(spec: TemporalSpec, options: TemporalReachabilityLintOptions = {}): Promise<SpecLintDiagnostic[]> {
  if (spec.states.length === 0 && spec.actions.length === 0) return [];
  if (!supportsZ3SpecExpressions(spec) || spec.states.some((state) => !supportsZ3SemanticType(state.type))) return [{
    code: "unsupported-backend-domain", name: "<model>", backend: "z3",
    message: "bounded Z3 reachability does not support this temporal domain; use Quint or a supported scalar/collection shape",
  }];
  const maxSteps = options.maxSteps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new Error(`maxSteps must be a non-negative safe integer, got ${maxSteps}`);
  const at = (name: string, step: number) => `${name}__${step}`;
  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  const declarations = [
    ...z3TypeDeclarations(spec.states.map((state) => state.type)),
    ...Array.from({ length: Math.max(maxSteps, 1) + 1 }, (_, step) => spec.states.map((state) => `(declare-const ${at(state.name, step)} ${smtSort(state.type)})`)).flat(),
    ...Array.from({ length: Math.max(maxSteps, 1) }, (_, step) => `(declare-const __uneffect_action_${step} Int)`),
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
  const selectedStep = (index: number) => disjoin(spec.actions.map((action, actionIndex) =>
    `(and (= __uneffect_action_${index} ${actionIndex}) ${actionTransition(action, index)})`));
  const fairnessAssertions = (loopStart: number, depth: number): string[] => spec.actions.flatMap((action, actionIndex) => {
    if (!action.fairness) return [];
    const enabled = Array.from({ length: depth - loopStart }, (_, offset) => guard(action, loopStart + offset));
    const occurs = Array.from({ length: depth - loopStart }, (_, offset) => `(= __uneffect_action_${loopStart + offset} ${actionIndex})`);
    const premise = action.fairness === "weak" ? `(and ${enabled.join(" ")})` : `(or ${enabled.join(" ")})`;
    return [`(or (not ${premise}) (or ${occurs.join(" ")}))`];
  });
  const diagnostics: SpecLintDiagnostic[] = [];
  const completenessDepth = finiteStateCompletenessDepth(spec);
  let backendFailure: Z3Execution | undefined;
  const checkAssertions = async (assertions: readonly string[]): Promise<"sat" | "unsat" | "unknown"> => {
    if (backendFailure) return "unknown";
    const execution = await executeZ3(["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`)].join("\n"), options.z3);
    if (execution.status === "error") { backendFailure = execution; return "unknown"; }
    return execution.status;
  };
  const initStatus = await checkAssertions(init);
  if (backendFailure) return [{
    code: "solver-backend-error", name: "<backend>", backend: "z3",
    message: `Z3 ${backendFailure.backend} backend failed (${backendFailure.failureKind ?? "error"}): ${backendFailure.stderr}`,
  }];
  const strengthening: TemporalSpec["properties"] = [];
  const explicitStrengthening = new Set(options.strengtheningProperties ?? []);
  const synthesized = [
    ...(options.synthesizeStrengtheningProperties ? synthesizedStrengtheningProperties(spec) : []),
    ...(options.synthesizeRelationalStrengtheningProperties ? synthesizedRelationalStrengtheningProperties(spec, {
      maxArity: options.relationalStrengtheningMaxArity,
      maxCoefficient: options.relationalStrengtheningMaxCoefficient,
      candidateLimit: options.relationalStrengtheningCandidateLimit,
    }) : []),
    ...(options.synthesizeCollectionStrengtheningProperties ? synthesizedCollectionStrengtheningProperties(spec) : []),
  ];
  const synthesizedByName = new Map(synthesized.map((property) => [property.name, property]));
  const eagerStrengtheningNames = new Set([
    ...explicitStrengthening,
    ...(options.discoverStrengtheningProperties ? spec.properties.map((property) => property.name) : []),
  ]);
  const proofCache = new Map<string, boolean>();
  const proveStrengthening = async (property: TemporalSpec["properties"][number], reportFailure: boolean): Promise<boolean> => {
    const cached = proofCache.get(property.name);
    if (cached !== undefined) return cached;
    const invariantAt = (index: number) => temporalToSmt(property.expressionAst, (state) => at(state, index), symbols);
    const established = await checkAssertions([...init, `(not ${invariantAt(0)})`]);
    const preserved = await checkAssertions([invariantAt(0), step(0), `(not ${invariantAt(1)})`]);
    const proven = established === "unsat" && preserved === "unsat";
    proofCache.set(property.name, proven);
    if (!proven && reportFailure) diagnostics.push({
      code: "non-inductive-strengthening-property", name: property.name, backend: "z3",
      message: `${property.name} cannot be used as a strengthening invariant because Z3 did not prove both initialization and one-step preservation`,
    });
    if (proven && !strengthening.some((candidate) => candidate.name === property.name)) strengthening.push(property);
    return proven;
  };
  for (const name of eagerStrengtheningNames) {
    const property = spec.properties.find((candidate) => candidate.name === name) ?? synthesizedByName.get(name);
    if (!property) {
      diagnostics.push({ code: "unknown-strengthening-property", name, backend: "z3", message: `strengthening property ${name} is not declared` });
      continue;
    }
    await proveStrengthening(property, explicitStrengthening.has(name));
  }
  const findStrengthening = async (
    obligation: readonly string[],
  ): Promise<TemporalSpec["properties"] | undefined> => {
    const establishes = async (properties: TemporalSpec["properties"]): Promise<boolean> => {
      const invariant = properties.length === 1
        ? temporalToSmt(properties[0]!.expressionAst, (state) => at(state, 0), symbols)
        : `(and ${properties.map((property) => temporalToSmt(property.expressionAst, (state) => at(state, 0), symbols)).join(" ")})`;
      return await checkAssertions([invariant, ...obligation]) === "unsat";
    };
    for (const property of strengthening) if (await establishes([property])) return [property];
    if (strengthening.length > 1 && await establishes(strengthening)) return [...strengthening];
    for (const property of synthesized) {
      if (proofCache.has(property.name)) continue;
      if (!await proveStrengthening(property, false)) continue;
      if (await establishes([property])) return [property];
    }
    return strengthening.length > 1 && await establishes(strengthening) ? [...strengthening] : undefined;
  };
  const enabledStatus = await checkAssertions([...init, disjoin(spec.actions.map((action) => guard(action, 0)))]);
  if (enabledStatus === "unsat" && initStatus === "sat") diagnostics.push({
    code: "deadlocked-initial-state", name: "<init>", backend: "z3", depth: 0, message: "no action is enabled in any state satisfying init",
  });
  if (maxSteps >= 1 && enabledStatus === "sat") {
    const changes = disjoin(spec.states.map((state) => `(not (= ${at(state.name, 1)} ${at(state.name, 0)}))`));
    if (await checkAssertions([...init, step(0), changes]) === "unsat") diagnostics.push({
      code: "no-state-progress-from-init", name: "<init>", backend: "z3", depth: 1,
      message: "actions are enabled at init, but no enabled initial transition can change temporal state",
    });
  }
  if (initStatus === "sat" && enabledStatus !== "unsat") {
    for (let depth = 1; depth <= maxSteps; depth++) {
      const transitions = Array.from({ length: depth }, (_, index) => step(index));
      const noneEnabled = `(not ${disjoin(spec.actions.map((action) => guard(action, depth)))})`;
      const status = await checkAssertions([...init, ...transitions, noneEnabled]);
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
      const status = await checkAssertions([...init, ...transitions, enabled, ...actionCannotChange]);
      if (status !== "sat") continue;
      diagnostics.push({
        code: "bounded-no-state-progress", name: "<progress>", backend: "z3", depth,
        message: `a state where actions are enabled but every enabled action stutters is reachable in ${depth} transition steps`,
      });
      diagnostics.push({
        code: "reachable-stutter-cycle", name: "<liveness>", backend: "z3", depth,
        message: `the reachable stuttering state yields an infinite no-progress execution; a stronger fairness or progress specification must rule it out`,
      });
      break;
    }
  }
  if (initStatus === "sat") for (const property of spec.liveness) {
    const initiallyFalse = `(not ${temporalToSmt(property.expressionAst, (name) => at(name, 0), symbols)})`;
    if (await checkAssertions([...init, initiallyFalse]) === "unsat") diagnostics.push({
      code: "initially-vacuous-liveness", name: property.name, backend: "z3", depth: 0,
      message: `${property.name} is already true in every initial state, so this eventuality imposes no future progress obligation`,
    });
  }
  if (initStatus === "sat" && spec.actions.length > 0 && spec.liveness.length > 0) for (const property of spec.liveness) {
    let found = false;
    for (let depth = 1; depth <= maxSteps && !found; depth++) for (let loopStart = 0; loopStart < depth; loopStart++) {
      const transitions = Array.from({ length: depth }, (_, index) => selectedStep(index));
      const loop = spec.states.map((state) => `(= ${at(state.name, depth)} ${at(state.name, loopStart)})`);
      const neverReached = Array.from({ length: depth }, (_, index) =>
        `(not ${temporalToSmt(property.expressionAst, (name) => at(name, index), symbols)})`);
      const fairness = fairnessAssertions(loopStart, depth);
      if (await checkAssertions([...init, ...transitions, ...loop, ...neverReached, ...fairness]) !== "sat") continue;
      diagnostics.push({
        code: "reachable-liveness-cycle", name: property.name, backend: "z3", depth, loopStart,
        message: `${property.name} is false along a reachable lasso of length ${depth} with loop start ${loopStart}, while all declared action fairness constraints hold`,
      });
      found = true;
      break;
    }
  }
  if (initStatus === "sat" && spec.actions.length > 0 && spec.recurrences.length > 0) for (const property of spec.recurrences) {
    let found = false;
    for (let depth = 1; depth <= maxSteps && !found; depth++) for (let loopStart = 0; loopStart < depth; loopStart++) {
      const transitions = Array.from({ length: depth }, (_, index) => selectedStep(index));
      const loop = spec.states.map((state) => `(= ${at(state.name, depth)} ${at(state.name, loopStart)})`);
      const absentFromLoop = Array.from({ length: depth - loopStart }, (_, offset) =>
        `(not ${temporalToSmt(property.expressionAst, (name) => at(name, loopStart + offset), symbols)})`);
      const fairness = fairnessAssertions(loopStart, depth);
      if (await checkAssertions([...init, ...transitions, ...loop, ...absentFromLoop, ...fairness]) !== "sat") continue;
      diagnostics.push({
        code: "reachable-recurrence-cycle", name: property.name, backend: "z3", depth, loopStart,
        message: `${property.name} is false throughout a reachable loop starting at ${loopStart}, so it never recurs on that infinite execution while all declared action fairness constraints hold`,
      });
      found = true;
      break;
    }
  }
  if (initStatus === "sat" && spec.actions.length > 0 && spec.stabilizations.length > 0) for (const property of spec.stabilizations) {
    let found = false;
    for (let depth = 1; depth <= maxSteps && !found; depth++) for (let loopStart = 0; loopStart < depth; loopStart++) {
      const transitions = Array.from({ length: depth }, (_, index) => selectedStep(index));
      const loop = spec.states.map((state) => `(= ${at(state.name, depth)} ${at(state.name, loopStart)})`);
      const falseSomewhereOnLoop = disjoin(Array.from({ length: depth - loopStart }, (_, offset) =>
        `(not ${temporalToSmt(property.expressionAst, (name) => at(name, loopStart + offset), symbols)})`));
      const fairness = fairnessAssertions(loopStart, depth);
      if (await checkAssertions([...init, ...transitions, ...loop, falseSomewhereOnLoop, ...fairness]) !== "sat") continue;
      diagnostics.push({
        code: "reachable-stabilization-cycle", name: property.name, backend: "z3", depth, loopStart,
        message: `${property.name} is false on a recurring state of the reachable loop starting at ${loopStart}, so it never becomes permanently true while all declared action fairness constraints hold`,
      });
      found = true;
      break;
    }
  }
  if (initStatus === "sat" && spec.actions.length > 0 && spec.responses.length > 0) for (const property of spec.responses) {
    let found = false;
    for (let depth = 1; depth <= maxSteps && !found; depth++) for (let loopStart = 0; loopStart < depth && !found; loopStart++) {
      const transitions = Array.from({ length: depth }, (_, index) => selectedStep(index));
      const loop = spec.states.map((state) => `(= ${at(state.name, depth)} ${at(state.name, loopStart)})`);
      const fairness = fairnessAssertions(loopStart, depth);
      for (let triggerDepth = 0; triggerDepth < depth; triggerDepth++) {
        const trigger = temporalToSmt(property.triggerAst, (name) => at(name, triggerDepth), symbols);
        const responseAbsent = Array.from({ length: depth - triggerDepth + 1 }, (_, offset) =>
          `(not ${temporalToSmt(property.responseAst, (name) => at(name, triggerDepth + offset), symbols)})`);
        if (await checkAssertions([...init, ...transitions, ...loop, trigger, ...responseAbsent, ...fairness]) !== "sat") continue;
        diagnostics.push({
          code: "reachable-response-cycle", name: property.name, backend: "z3", depth, loopStart, triggerDepth,
          message: `${property.name} is violated by a reachable lasso: its trigger holds at depth ${triggerDepth}, but its response stays false forever on the loop starting at ${loopStart}`,
        });
        found = true;
        break;
      }
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
    if (await checkAssertions([...init, disjoin(violations)]) !== "unsat") continue;
    const relevantChanges = Array.from({ length: maxSteps }, (_, depth) => {
      const transitions = Array.from({ length: depth + 1 }, (_, index) => step(index));
      const changes = disjoin(references.map((name) => `(not (= ${at(name, depth + 1)} ${at(name, depth)}))`));
      return `(and ${[...transitions, changes].join(" ")})`;
    });
    if (await checkAssertions([...init, disjoin(relevantChanges)]) === "unsat") {
      diagnostics.push({
        code: "bounded-vacuous-property", name: property.name, backend: "z3", depth: maxSteps,
        message: `${property.name} holds within ${maxSteps} steps, but none of its referenced state can change on a reachable transition within that bound`,
      });
      const changesOnAnyTransition = disjoin(references.map((name) => `(not (= ${at(name, 1)} ${at(name, 0)}))`));
      if (await checkAssertions([step(0), changesOnAnyTransition]) === "unsat") diagnostics.push({
        code: "inductively-vacuous-property", name: property.name, backend: "z3", depth: 1,
        message: `${property.name} is vacuous without a bound: init establishes it and no transition can change any state it references`,
      });
      else {
        const properties = await findStrengthening([step(0), changesOnAnyTransition]);
        if (properties) {
          const propertyNames = properties.map((candidate) => candidate.name).join(" & ");
          diagnostics.push({
            code: "strengthened-vacuous-property", name: property.name, relatedName: propertyNames, backend: "z3", depth: 1,
            message: `${property.name} is vacuous without a bound under proven inductive strengthening ${properties.length === 1 ? "property" : "properties"} ${propertyNames}`,
          });
        }
      }
    }
  }
  for (const action of spec.actions) {
    const prefixes: string[] = [];
    for (let depth = 0; depth <= maxSteps; depth++) {
      const transitions = Array.from({ length: depth }, (_, index) => step(index));
      prefixes.push(`(and ${[...transitions, guard(action, depth)].join(" ")})`);
    }
    const result = await checkAssertions([...init, disjoin(prefixes)]);
    if (result === "unsat") {
      diagnostics.push({
        code: "bounded-unreachable-action", name: action.name, backend: "z3", depth: maxSteps,
        message: `${action.name} is unreachable from init within ${maxSteps} transition steps; this is not by itself an unbounded proof`,
      });
      if (completenessDepth !== undefined && maxSteps >= completenessDepth) diagnostics.push({
        code: "finite-state-unreachable-action", name: action.name, backend: "z3", depth: completenessDepth,
        message: `${action.name} is unreachable: the complete finite state space is covered by paths of at most ${completenessDepth} transitions`,
      });
      if (maxSteps >= 1) {
        const induction = await checkAssertions([`(not ${guard(action, 0)})`, step(0), guard(action, 1)]);
        if (induction === "unsat") diagnostics.push({
          code: "inductively-unreachable-action", name: action.name, backend: "z3", depth: 1,
          message: `${action.name} is unreachable: init excludes its guard and one-step induction preserves that exclusion across every transition`,
        });
        else {
          const properties = await findStrengthening([step(0), guard(action, 1)]);
          if (properties) {
          const propertyNames = properties.map((property) => property.name).join(" & ");
          diagnostics.push({
            code: "strengthened-unreachable-action", name: action.name, relatedName: propertyNames, backend: "z3", depth: 1,
            message: `${action.name} is unreachable using proven inductive strengthening ${properties.length === 1 ? "property" : "properties"} ${propertyNames}`,
          });
          }
        }
      }
    }
  }
  const unreachableTargets: Array<{
    name: string;
    expressionAst: TemporalExpression;
    subject: string;
    boundedCode: SpecLintDiagnostic["code"];
    inductiveCode: SpecLintDiagnostic["code"];
    strengthenedCode: SpecLintDiagnostic["code"];
    finiteCode: SpecLintDiagnostic["code"];
  }> = [
    ...spec.responses.map((property) => ({
      name: property.name, expressionAst: property.triggerAst, subject: "response trigger",
      boundedCode: "bounded-unreachable-response-trigger" as const,
      inductiveCode: "inductively-unreachable-response-trigger" as const,
      strengthenedCode: "strengthened-unreachable-response-trigger" as const,
      finiteCode: "finite-state-unreachable-response-trigger" as const,
    })),
    ...spec.recurrences.map((property) => ({
      name: property.name, expressionAst: property.expressionAst, subject: "recurrence target",
      boundedCode: "bounded-unreachable-recurrence-target" as const,
      inductiveCode: "inductively-unreachable-recurrence-target" as const,
      strengthenedCode: "strengthened-unreachable-recurrence-target" as const,
      finiteCode: "finite-state-unreachable-recurrence-target" as const,
    })),
    ...spec.stabilizations.map((property) => ({
      name: property.name, expressionAst: property.expressionAst, subject: "stabilization target",
      boundedCode: "bounded-unreachable-stabilization-target" as const,
      inductiveCode: "inductively-unreachable-stabilization-target" as const,
      strengthenedCode: "strengthened-unreachable-stabilization-target" as const,
      finiteCode: "finite-state-unreachable-stabilization-target" as const,
    })),
  ];
  for (const target of unreachableTargets) {
    const targetAt = (depth: number) => temporalToSmt(target.expressionAst, (name) => at(name, depth), symbols);
    const prefixes = Array.from({ length: maxSteps + 1 }, (_, depth) => {
      const transitions = Array.from({ length: depth }, (__, index) => step(index));
      return `(and ${[...transitions, targetAt(depth)].join(" ")})`;
    });
    if (await checkAssertions([...init, disjoin(prefixes)]) !== "unsat") continue;
    diagnostics.push({
      code: target.boundedCode, name: target.name, backend: "z3", depth: maxSteps,
      message: `${target.name}'s ${target.subject} is unreachable from init within ${maxSteps} transition steps; this is not by itself an unbounded proof`,
    });
    if (completenessDepth !== undefined && maxSteps >= completenessDepth) diagnostics.push({
      code: target.finiteCode, name: target.name, backend: "z3", depth: completenessDepth,
      message: `${target.name}'s ${target.subject} is unreachable: the complete finite state space is covered by paths of at most ${completenessDepth} transitions`,
    });
    if (maxSteps >= 1) {
      const induction = await checkAssertions([`(not ${targetAt(0)})`, step(0), targetAt(1)]);
      if (induction === "unsat") diagnostics.push({
        code: target.inductiveCode, name: target.name, backend: "z3", depth: 1,
        message: `${target.name}'s ${target.subject} is unreachable: init excludes it and one-step induction preserves that exclusion across every transition`,
      });
      else {
        const properties = await findStrengthening([step(0), targetAt(1)]);
        if (properties) {
        const propertyNames = properties.map((candidate) => candidate.name).join(" & ");
        diagnostics.push({
          code: target.strengthenedCode, name: target.name, relatedName: propertyNames, backend: "z3", depth: 1,
          message: `${target.name}'s ${target.subject} is unreachable using proven inductive strengthening ${properties.length === 1 ? "property" : "properties"} ${propertyNames}`,
        });
        }
      }
    }
  }
  return diagnostics;
}

/** Semantic lint over all typed states. It does not claim reachable-state or progress analysis. */
export async function lintTemporalSpecWithZ3(spec: TemporalSpec, options: Z3ExecutionOptions = {}): Promise<SpecLintDiagnostic[]> {
  if (!supportsZ3SpecExpressions(spec) || spec.states.some((state) => !supportsZ3SemanticType(state.type))) return [{
    code: "unsupported-backend-domain", name: "<model>", backend: "z3",
    message: "Z3 semantic lint does not support this temporal domain; use Quint or a supported scalar/collection shape",
  }];
  const diagnostics: SpecLintDiagnostic[] = [];
  let backendFailure: Z3Execution | undefined;
  const run = async (assertions: readonly string[]): Promise<"sat" | "unsat" | "unknown"> => {
    if (backendFailure) return "unknown";
    const execution = await executeCheck(spec, assertions, options);
    if (execution.status === "error") { backendFailure = execution; return "unknown"; }
    return execution.status;
  };
  const symbols = new Map<string, TemporalValueType>(spec.states.map((state) => [state.name, state.type]));
  const initConstraints = spec.init.map((item) => `(= ${item.target} ${temporalToSmt(item.expressionAst, (name) => name, symbols, symbols.get(item.target))})`);
  if (await run(initConstraints) === "unsat") diagnostics.push({
    code: "inconsistent-init", name: "<init>", backend: "z3", message: "temporal init constraints are jointly unsatisfiable",
  });

  const classified = new Set<string>();
  for (const property of spec.properties) {
    const expression = temporalToSmt(property.expressionAst, (name) => name, symbols);
    if (await run([`(not ${expression})`]) === "unsat") {
      classified.add(property.name);
      diagnostics.push({ code: "solver-tautology", name: property.name, backend: "z3", message: `${property.name} is valid for every typed state` });
    } else if (await run([expression]) === "unsat") {
      classified.add(property.name);
      diagnostics.push({ code: "solver-contradiction", name: property.name, backend: "z3", message: `${property.name} is false for every typed state` });
    }
  }
  for (const action of spec.actions) if (action.guard && await run([temporalToSmt(action.guard.expressionAst, (name) => name, symbols)]) === "unsat") diagnostics.push({
    code: "unreachable-action", name: action.name, backend: "z3", message: `${action.name} has an unsatisfiable guard for every typed state`,
  });
  for (const property of spec.recurrences) {
    const expression = temporalToSmt(property.expressionAst, (name) => name, symbols);
    if (await run([expression]) === "unsat") diagnostics.push({
      code: "unsatisfiable-recurrence-target", name: property.name, backend: "z3",
      message: `${property.name} is false for every typed state, so its recurrence obligation cannot be satisfied`,
    });
    else if (await run([`(not ${expression})`]) === "unsat") diagnostics.push({
      code: "statewise-vacuous-recurrence", name: property.name, backend: "z3",
      message: `${property.name} is true for every typed state, so its recurrence obligation imposes no temporal constraint`,
    });
  }
  for (const property of spec.stabilizations) {
    const expression = temporalToSmt(property.expressionAst, (name) => name, symbols);
    if (await run([expression]) === "unsat") diagnostics.push({
      code: "unsatisfiable-stabilization-target", name: property.name, backend: "z3",
      message: `${property.name} is false for every typed state, so its stabilization obligation cannot be satisfied`,
    });
    else if (await run([`(not ${expression})`]) === "unsat") diagnostics.push({
      code: "statewise-vacuous-stabilization", name: property.name, backend: "z3",
      message: `${property.name} is true for every typed state, so its stabilization obligation imposes no temporal constraint`,
    });
  }
  for (const property of spec.responses) {
    const trigger = temporalToSmt(property.triggerAst, (name) => name, symbols);
    const response = temporalToSmt(property.responseAst, (name) => name, symbols);
    if (await run([trigger]) === "unsat") diagnostics.push({
      code: "unsatisfiable-response-trigger", name: property.name, backend: "z3",
      message: `${property.name} has an unsatisfiable trigger for every typed state, so its response obligation can never start`,
    });
    else if (await run([trigger, `(not ${response})`]) === "unsat") diagnostics.push({
      code: "statewise-vacuous-response", name: property.name, backend: "z3",
      message: `${property.name} is already satisfied whenever its trigger holds in any typed state, so it imposes no future response obligation`,
    });
  }

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
      if (await run(implicationCounterexample) === "unsat") {
        diagnostics.push({ code: "subsumed-property", name: current.name, relatedName: earlier.name, backend: "z3", message: `${current.name} is implied by earlier property ${earlier.name}` });
        break;
      }
    }
  }
  if (backendFailure) diagnostics.unshift({
    code: "solver-backend-error", name: "<backend>", backend: "z3",
    message: `Z3 ${backendFailure.backend} backend failed (${backendFailure.failureKind ?? "error"}): ${backendFailure.stderr}`,
  });
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
  else if (expression.kind === "conditional") { referencedNames(expression.condition, names, bound); referencedNames(expression.whenTrue, names, bound); referencedNames(expression.whenFalse, names, bound); }
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
  for (const property of spec.recurrences) {
    const constant = constantBoolean(property.expressionAst);
    if (constant !== undefined) diagnostics.push({
      code: constant ? "statewise-vacuous-recurrence" : "unsatisfiable-recurrence-target",
      name: property.name,
      message: constant
        ? `${property.name} is statically true, so its recurrence obligation imposes no temporal constraint`
        : `${property.name} is statically false, so its recurrence obligation cannot be satisfied`,
    });
    else if (![...referencedNames(property.expressionAst)].some((name) => stateNames.has(name))) diagnostics.push({
      code: "state-independent-invariant", name: property.name,
      message: `${property.name} does not reference temporal state`,
    });
  }
  for (const property of spec.stabilizations) {
    const constant = constantBoolean(property.expressionAst);
    if (constant !== undefined) diagnostics.push({
      code: constant ? "statewise-vacuous-stabilization" : "unsatisfiable-stabilization-target",
      name: property.name,
      message: constant
        ? `${property.name} is statically true, so its stabilization obligation imposes no temporal constraint`
        : `${property.name} is statically false, so its stabilization obligation cannot be satisfied`,
    });
    else if (![...referencedNames(property.expressionAst)].some((name) => stateNames.has(name))) diagnostics.push({
      code: "state-independent-invariant", name: property.name,
      message: `${property.name} does not reference temporal state`,
    });
  }
  for (const property of spec.responses) {
    const trigger = constantBoolean(property.triggerAst);
    if (trigger === false) diagnostics.push({
      code: "unsatisfiable-response-trigger", name: property.name,
      message: `${property.name} has a statically false trigger, so its response obligation can never start`,
    });
    else if (same(property.triggerAst, property.responseAst) || constantBoolean(property.responseAst) === true) diagnostics.push({
      code: "statewise-vacuous-response", name: property.name,
      message: `${property.name} is already satisfied whenever its trigger holds, so it imposes no future response obligation`,
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
export async function lintSpecWithZ3(fileName: string, text: string, options: SpecLintWithZ3Options = {}): Promise<{ spec: ParsedSpec; diagnostics: SpecLintDiagnostic[] }> {
  const result = lintSpec(fileName, text);
  const reachability = options.reachabilitySteps === false ? [] : await lintTemporalReachabilityWithZ3(result.spec.temporal, {
    maxSteps: options.reachabilitySteps ?? 8,
    strengtheningProperties: options.strengtheningProperties,
    discoverStrengtheningProperties: options.discoverStrengtheningProperties,
    synthesizeStrengtheningProperties: options.synthesizeStrengtheningProperties,
    synthesizeRelationalStrengtheningProperties: options.synthesizeRelationalStrengtheningProperties,
    relationalStrengtheningMaxArity: options.relationalStrengtheningMaxArity,
    relationalStrengtheningMaxCoefficient: options.relationalStrengtheningMaxCoefficient,
    relationalStrengtheningCandidateLimit: options.relationalStrengtheningCandidateLimit,
    synthesizeCollectionStrengtheningProperties: options.synthesizeCollectionStrengtheningProperties,
    z3: options.z3,
  });
  const semantic = await lintTemporalSpecWithZ3(result.spec.temporal, options.z3);
  const solverFailure = semantic.find((diagnostic) => diagnostic.code === "solver-backend-error")
    ?? reachability.find((diagnostic) => diagnostic.code === "solver-backend-error");
  return {
    spec: result.spec,
    diagnostics: solverFailure
      ? [...result.diagnostics, solverFailure]
      : [...result.diagnostics, ...semantic, ...reachability],
  };
}
