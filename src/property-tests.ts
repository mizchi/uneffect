import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, posix } from "node:path";
import ts from "typescript";
import { init as initZ3 } from "z3-solver";
import { extractAnnotations } from "./annotations.js";
import { logicToSmt, parseLogicExpression } from "./invariant-ir.js";
import type { LogicExpression } from "./invariant-ir.js";

export type PropertyBoundaryKind = "Int" | "Nat" | "U8" | "U32" | "I32";
export type PropertyLiteral = string | number | boolean;
export type PropertyTestDomain = PropertyBoundaryKind
  | { kind: "bounded-array"; element: "U8" | "U32"; maximum: number }
  | { kind: "record"; fields: Record<string, PropertyTestDomain>; optional?: string[] }
  | { kind: "union"; members: Array<PropertyBoundaryKind | { kind: "literal"; value: PropertyLiteral }> };
export type PropertyRecord = { [name: string]: PropertyValue };
export type PropertyValue = PropertyLiteral | number[] | PropertyRecord;

export interface PropertyTestBoundary {
  fileName: string;
  functionName: string;
  generators: PropertyTestDomain[];
  shrinkers: PropertyTestDomain[];
  generatorHints: PropertyLiteral[][];
  generatorTuples: PropertyValue[][];
  requires: string[];
  ensures: string[];
}

export interface GenerateUneffectPropertyTestsOptions {
  files: Record<string, string>;
  backend?: "quickcheck";
  shrinking?: boolean;
  cases?: number;
  seed?: number;
  arrayLengthCap?: number;
  refinementTuples?: Record<string, readonly (readonly PropertyValue[])[]>;
}

export interface GenerateUneffectPropertyTestsWithZ3Options extends GenerateUneffectPropertyTestsOptions { solverCases?: number }
export interface PropertySolverDiagnostic { fileName: string; functionName: string; status: "unsat" | "unknown"; message: string }
export interface GenerateUneffectPropertyTestsWithZ3Result extends GenerateUneffectPropertyTestsResult { solverDiagnostics: PropertySolverDiagnostic[] }

export interface GenerateUneffectPropertyTestsResult {
  generatedFiles: Record<string, string>;
  boundaries: PropertyTestBoundary[];
  diagnostics: Array<{ fileName: string; functionName: string; message: string }>;
}

export type PropertyCounterexample = {
  version: "uneffect-counterexample/v1";
  functionName: string;
  arguments: number[];
  seed: number;
} | {
  version: "uneffect-counterexample/v2";
  functionName: string;
  arguments: PropertyValue[];
  seed: number;
};

export interface CheckUneffectPropertyOptions {
  functionName: string;
  domains: readonly PropertyTestDomain[];
  property: (...values: any[]) => boolean | Promise<boolean>;
  precondition?: (...values: any[]) => boolean;
  cases?: number;
  seed?: number;
  shrinking?: boolean;
  counterexamplePath?: string;
  arrayLengthCap?: number;
  refinementValues?: readonly (readonly PropertyLiteral[])[];
  refinementTuples?: readonly (readonly PropertyValue[])[];
}

export interface CheckUneffectPropertyResult {
  status: "passed" | "counterexample";
  counterexample?: PropertyCounterexample;
  replayed: boolean;
  tested: number;
}

interface InternalBoundary extends PropertyTestBoundary { parameters: string[] }

const supported = new Set<PropertyBoundaryKind>(["Int", "Nat", "U8", "U32", "I32"]);
const edgeValues: Record<PropertyBoundaryKind, readonly number[]> = {
  Int: [0, 1, -1, 2, -2, 2_147_483_647, -2_147_483_648], Nat: [0, 1, 2, 255, 65_535],
  U8: [0, 1, 2, 254, 255], U32: [0, 1, 2, 4_294_967_294, 4_294_967_295], I32: [0, 1, -1, 2_147_483_647, -2_147_483_648],
};

function arrayCap(value: number | undefined): number {
  const cap = value ?? 4_096;
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error(`arrayLengthCap must be a non-negative safe integer, got ${cap}`);
  return cap;
}

function scalarAccepts(domain: PropertyBoundaryKind, value: PropertyLiteral): boolean {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (domain === "Nat") return value >= 0;
  if (domain === "U8") return value >= 0 && value <= 0xff;
  if (domain === "U32") return value >= 0 && value <= 0xffff_ffff;
  if (domain === "I32") return value >= -0x8000_0000 && value <= 0x7fff_ffff;
  return true;
}

function domainAccepts(domain: PropertyTestDomain, value: PropertyValue): boolean {
  if (typeof domain === "string") return (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && scalarAccepts(domain, value);
  if (domain.kind === "bounded-array") return Array.isArray(value) && value.length <= domain.maximum
    && value.every((entry) => scalarAccepts(domain.element, entry));
  if (domain.kind === "record") return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((name) => Object.hasOwn(domain.fields, name))
    && Object.keys(domain.fields).filter((name) => !domain.optional?.includes(name)).every((name) => Object.hasOwn(value, name))
    && Object.entries(domain.fields).every(([name, field]) => {
      const entry = value[name];
      return entry === undefined ? Boolean(domain.optional?.includes(name) && !Object.hasOwn(value, name)) : domainAccepts(field, entry);
    });
  if (typeof value === "object") return false;
  return domain.members.some((member) => typeof member === "string" ? scalarAccepts(member, value) : member.value === value);
}

function shrinkNumber(value: number, domain: PropertyBoundaryKind): number[] {
  const values: number[] = [];
  let current = value;
  while (Math.abs(current) > 1) { current = Math.trunc(current / 2); values.push(current); }
  values.push(0);
  return [...new Set(values)].filter((candidate) => domain !== "Nat" && domain !== "U8" && domain !== "U32" || candidate >= 0);
}

function domainValues(domain: PropertyTestDomain, arrayLengthCap = 4_096, refinementValues: readonly PropertyLiteral[] = []): PropertyValue[] {
  const unique = (values: PropertyValue[]): PropertyValue[] => values.filter((value, index) => values.findIndex((other) => JSON.stringify(other) === JSON.stringify(value)) === index);
  if (typeof domain === "string") return unique([...refinementValues.filter((value) => domainAccepts(domain, value)), ...edgeValues[domain]]);
  if (domain.kind === "union") {
    const values: PropertyValue[] = [];
    for (const member of domain.members) values.push(...(typeof member === "string" ? edgeValues[member] : [member.value]));
    return unique([...refinementValues.filter((value) => domainAccepts(domain, value)), ...values]);
  }
  if (domain.kind === "record") {
    const entries = Object.entries(domain.fields);
    let values: PropertyRecord[] = [{}];
    for (const [name, field] of entries) {
      const fieldValues: Array<PropertyValue | undefined> = [...(domain.optional?.includes(name) ? [undefined] : []), ...domainValues(field, arrayLengthCap).slice(0, 5)];
      values = values.flatMap((record) => fieldValues.map((value) => value === undefined ? record : ({ ...record, [name]: value }))).slice(0, 64);
    }
    return values;
  }
  const sampledMaximum = Math.min(domain.maximum, arrayLengthCap);
  const lengths = [...new Set([0, Math.min(1, sampledMaximum), Math.min(2, sampledMaximum), sampledMaximum])];
  const edges = edgeValues[domain.element];
  return lengths.map((length, index) => Array.from({ length }, (_, at) => edges[(at + index) % edges.length]!));
}

function shrinkValue(value: PropertyValue, domain: PropertyTestDomain): PropertyValue[] {
  if (typeof domain === "string") return typeof value === "number" ? shrinkNumber(value, domain) : [];
  if (domain.kind === "union") return domain.members.flatMap((member) => typeof member === "string" && typeof value === "number" ? shrinkNumber(value, member) : []);
  if (domain.kind === "record") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(domain.fields).flatMap(([name, field]) => {
      const entry = value[name];
      const omitted = domain.optional?.includes(name) && Object.hasOwn(value, name) ? [Object.fromEntries(Object.entries(value).filter(([key]) => key !== name)) as PropertyRecord] : [];
      return entry === undefined ? omitted : [...omitted, ...shrinkValue(entry, field).map((candidate) => ({ ...value, [name]: candidate }))];
    });
  }
  if (!Array.isArray(value)) return [];
  const structural: number[][] = [];
  for (let length = Math.floor(value.length / 2); length > 0; length = Math.floor(length / 2)) structural.push(value.slice(0, length));
  if (value.length > 1) structural.push(value.slice(0, 1));
  const elementShrinks = value.flatMap((entry, index) => shrinkNumber(entry, domain.element).map((candidate) => value.with(index, candidate)));
  return [...structural, ...elementShrinks, []].filter((candidate, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index);
}

function materialize(value: PropertyValue, domain: PropertyTestDomain): any {
  if (typeof domain === "object" && domain.kind === "bounded-array") return domain.element === "U8" ? new Uint8Array(value as number[]) : new Uint32Array(value as number[]);
  return value;
}

function sampleSize(values: readonly PropertyValue[]): number {
  const valueSize = (value: PropertyValue): number => Array.isArray(value)
    ? value.length + value.reduce((sum, entry) => sum + Math.abs(entry), 0)
    : value !== null && typeof value === "object" ? Object.values(value as PropertyRecord).reduce<number>((sum, entry) => sum + valueSize(entry), 0)
    : typeof value === "number" ? Math.abs(value) : typeof value === "string" ? value.length : Number(value);
  return values.reduce<number>((total, value) => total + valueSize(value), 0);
}

function makeSamples(domains: readonly PropertyTestDomain[], cases: number, seed: number, arrayLengthCap: number, refinementValues: readonly (readonly PropertyLiteral[])[], refinementTuples: readonly (readonly PropertyValue[])[] = []): PropertyValue[][] {
  const samples: PropertyValue[][] = refinementTuples.filter((tuple) => tuple.length === domains.length && tuple.every((value, index) => domainAccepts(domains[index]!, value))).map((tuple) => [...tuple]);
  const limit = Math.max(cases, samples.length);
  const visit = (index: number, values: PropertyValue[]): void => {
    if (samples.length >= limit) return;
    if (index === domains.length) { if (!samples.some((sample) => JSON.stringify(sample) === JSON.stringify(values))) samples.push(values); return; }
    for (const value of domainValues(domains[index]!, arrayLengthCap, refinementValues[index])) visit(index + 1, [...values, value]);
  };
  visit(0, []);
  let state = seed >>> 0;
  const random = (): number => ((state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 0x1_0000_0000);
  while (samples.length < limit) samples.push(domains.map((domain, index) => {
    const values = domainValues(domain, arrayLengthCap, refinementValues[index]);
    return values[Math.floor(random() * values.length)]!;
  }));
  return samples;
}

/** Runs generated-test semantics, minimizes failures, and optionally persists a replay artifact. */
export async function checkUneffectProperty(options: CheckUneffectPropertyOptions): Promise<CheckUneffectPropertyResult> {
  const seed = options.seed ?? 0x5eed, precondition = options.precondition ?? (() => true);
  let replay: PropertyCounterexample | undefined;
  if (options.counterexamplePath) {
    try { replay = JSON.parse(await readFile(options.counterexamplePath, "utf8")) as PropertyCounterexample; } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  const samples = [...(replay?.functionName === options.functionName ? [replay.arguments] : []), ...makeSamples(options.domains, options.cases ?? 100, seed, arrayCap(options.arrayLengthCap), options.refinementValues ?? [], options.refinementTuples ?? [])];
  let tested = 0;
  for (const sample of samples) {
    const invoke = (values: PropertyValue[]) => values.map((value, index) => materialize(value, options.domains[index]!));
    if (!precondition(...invoke(sample))) continue;
    tested++;
    if (await options.property(...invoke(sample))) continue;
    const minimal = [...sample];
    if (options.shrinking !== false) {
      const joint = (options.refinementTuples ?? []).map((tuple) => [...tuple] as PropertyValue[]).sort((left, right) => sampleSize(left) - sampleSize(right));
      for (const candidate of joint) {
        if (candidate.length !== minimal.length || sampleSize(candidate) >= sampleSize(minimal)) continue;
        if (precondition(...invoke(candidate)) && !(await options.property(...invoke(candidate)))) minimal.splice(0, minimal.length, ...candidate);
      }
      for (let index = 0; index < minimal.length; index++) for (const value of shrinkValue(minimal[index]!, options.domains[index]!)) {
        const candidate = minimal.with(index, value);
        if (precondition(...invoke(candidate)) && !(await options.property(...invoke(candidate)))) minimal[index] = value;
      }
    }
    const scalarOnly = options.domains.every((domain) => typeof domain === "string") && minimal.every((value) => typeof value === "number");
    const counterexample: PropertyCounterexample = scalarOnly
      ? { version: "uneffect-counterexample/v1", functionName: options.functionName, arguments: minimal as number[], seed }
      : { version: "uneffect-counterexample/v2", functionName: options.functionName, arguments: minimal, seed };
    if (options.counterexamplePath) await writeFile(options.counterexamplePath, `${JSON.stringify(counterexample, null, 2)}\n`);
    return { status: "counterexample", counterexample, replayed: replay?.functionName === options.functionName && sample === samples[0], tested };
  }
  return { status: "passed", replayed: false, tested };
}

function literalValue(type: ts.TypeNode): PropertyLiteral | undefined {
  if (type.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (type.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (!ts.isLiteralTypeNode(type)) return undefined;
  if (ts.isStringLiteral(type.literal) || ts.isNumericLiteral(type.literal)) return ts.isStringLiteral(type.literal) ? type.literal.text : Number(type.literal.text);
  if (ts.isPrefixUnaryExpression(type.literal) && type.literal.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(type.literal.operand)) return -Number(type.literal.operand.text);
  return undefined;
}

function typeDomain(type: ts.TypeNode | undefined): PropertyTestDomain | undefined {
  if (!type) return undefined;
  if (ts.isParenthesizedTypeNode(type)) return typeDomain(type.type);
  if (ts.isTypeLiteralNode(type)) {
    const fields: Record<string, PropertyTestDomain> = {};
    const optional: string[] = [];
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.type
        || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) return undefined;
      const field = typeDomain(member.type);
      if (!field || typeof field === "object" && field.kind === "union") return undefined;
      if (member.questionToken) {
        if (typeof field !== "string") return undefined;
        optional.push(member.name.text);
      }
      fields[member.name.text] = field;
    }
    return Object.keys(fields).length > 0 ? { kind: "record", fields, ...(optional.length ? { optional } : {}) } : undefined;
  }
  if (ts.isUnionTypeNode(type)) {
    const members = type.types.map((member) => typeDomain(member) ?? (literalValue(member) === undefined ? undefined : { kind: "literal" as const, value: literalValue(member)! }));
    if (members.some((member) => member === undefined || typeof member === "object" && member.kind !== "literal")) return undefined;
    return { kind: "union", members: members as Array<PropertyBoundaryKind | { kind: "literal"; value: PropertyLiteral }> };
  }
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  if (supported.has(type.typeName.text as PropertyBoundaryKind)) return type.typeName.text as PropertyBoundaryKind;
  if ((type.typeName.text === "BoundedUint8Array" || type.typeName.text === "BoundedUint32Array") && type.typeArguments?.length === 1) {
    const maximumNode = type.typeArguments[0]!;
    if (!ts.isLiteralTypeNode(maximumNode) || !ts.isNumericLiteral(maximumNode.literal)) return undefined;
    return { kind: "bounded-array", element: type.typeName.text === "BoundedUint8Array" ? "U8" : "U32", maximum: Number(maximumNode.literal.text) };
  }
  return undefined;
}

function generatedName(fileName: string): string {
  const extension = extname(fileName);
  return `${fileName.slice(0, -extension.length)}.uneffect.test.ts`;
}

function boundaryKey(fileName: string, functionName: string): string { return `${fileName}:${functionName}`; }

function importPath(sourceName: string, generatedFile: string): string {
  const relative = posix.relative(dirname(generatedFile), sourceName.replace(/\.[cm]?tsx?$/, ".js"));
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function propertyExpression(expression: string): ts.Expression {
  const source = ts.createSourceFile("property-expression.ts", `const value = (${expression})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  const value = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
  if (!value) throw new Error(`invalid property expression: ${expression}`);
  return value;
}

function validateStructuredPropertyExpression(node: ts.Expression): void {
  if (ts.isIdentifier(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return;
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return validateStructuredPropertyExpression(node.expression);
  if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.MinusToken].includes(node.operator)) return validateStructuredPropertyExpression(node.operand);
  if (ts.isPropertyAccessExpression(node) && propertyPath(node)) return;
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.argumentExpression
    && (ts.isNumericLiteral(node.argumentExpression) || ts.isIdentifier(node.argumentExpression))) return;
  if (ts.isBinaryExpression(node) && [
    ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
  ].includes(node.operatorToken.kind)) {
    validateStructuredPropertyExpression(node.left);
    validateStructuredPropertyExpression(node.right);
    return;
  }
  throw new Error(`unsupported property expression: ${node.getText()}`);
}

function validateExpression(expression: string): void {
  try { parseLogicExpression(expression); } catch { validateStructuredPropertyExpression(propertyExpression(expression)); }
}

function integerValue(expression: LogicExpression): number | undefined {
  if (expression.kind === "integer") return Number(expression.value);
  if (expression.kind === "unary" && expression.operator === "negate" && expression.operand.kind === "integer") return -Number(expression.operand.value);
  return undefined;
}

function affineVariable(expression: LogicExpression): { name: string; offset: number } | undefined {
  if (expression.kind === "variable") return { name: expression.name, offset: 0 };
  if (expression.kind !== "binary" || (expression.operator !== "add" && expression.operator !== "sub")) return undefined;
  const left = affineVariable(expression.left), right = affineVariable(expression.right);
  const leftConstant = integerValue(expression.left), rightConstant = integerValue(expression.right);
  if (left && rightConstant !== undefined) return { name: left.name, offset: left.offset + (expression.operator === "add" ? rightConstant : -rightConstant) };
  if (expression.operator === "add" && leftConstant !== undefined && right) return { name: right.name, offset: leftConstant + right.offset };
  return undefined;
}

function refinementHints(requires: readonly string[], parameters: readonly string[], domains: readonly PropertyTestDomain[]): PropertyLiteral[][] {
  const hints = parameters.map((): PropertyLiteral[] => []);
  const addComparison = (expression: LogicExpression): void => {
    if (expression.kind === "binary" && (expression.operator === "and" || expression.operator === "or")) { addComparison(expression.left); addComparison(expression.right); return; }
    if (expression.kind !== "binary" || !["gte", "gt", "lte", "lt", "eq"].includes(expression.operator)) return;
    let name: string | undefined, value: number | undefined, operator = expression.operator;
    const left = affineVariable(expression.left), right = affineVariable(expression.right);
    if (left) { name = left.name; const constant = integerValue(expression.right); value = constant === undefined ? undefined : constant - left.offset; }
    else if (right) {
      name = right.name; const constant = integerValue(expression.left); value = constant === undefined ? undefined : constant - right.offset;
      operator = ({ gte: "lte", gt: "lt", lte: "gte", lt: "gt", eq: "eq" } as Record<string, string>)[operator]!;
    }
    if (name === undefined || value === undefined) return;
    const index = parameters.indexOf(name), domain = domains[index];
    if (index < 0 || typeof domain !== "string") return;
    const candidates = operator === "gte" ? [value, value + 1] : operator === "gt" ? [value + 1, value + 2]
      : operator === "lte" ? [value - 1, value] : operator === "lt" ? [value - 2, value - 1] : [value];
    hints[index]!.push(...candidates.filter((candidate) => scalarAccepts(domain, candidate)));
  };
  for (const requirement of requires) try { addComparison(parseLogicExpression(requirement)); } catch { /* Structured hints are derived by the solver-backed path. */ }
  return hints.map((values) => [...new Set(values)].sort((left, right) => Number(left) - Number(right)));
}

function correlatedRefinementTuples(requires: readonly string[], parameters: readonly string[], domains: readonly PropertyTestDomain[], hints: readonly (readonly PropertyLiteral[])[]): PropertyLiteral[][] {
  if (domains.some((domain) => typeof domain !== "string")) return [];
  const relations: Array<{ target: number; source: number; offset: number }> = [];
  const visit = (expression: LogicExpression): void => {
    if (expression.kind === "binary" && expression.operator === "and") { visit(expression.left); visit(expression.right); return; }
    if (expression.kind !== "binary" || expression.operator !== "eq") return;
    let targetName: string | undefined, source: { name: string; offset: number } | undefined;
    if (expression.left.kind === "variable") { targetName = expression.left.name; source = affineVariable(expression.right); }
    else if (expression.right.kind === "variable") { targetName = expression.right.name; source = affineVariable(expression.left); }
    if (!targetName || !source || targetName === source.name) return;
    const target = parameters.indexOf(targetName), sourceIndex = parameters.indexOf(source.name);
    if (target >= 0 && sourceIndex >= 0) relations.push({ target, source: sourceIndex, offset: source.offset });
  };
  for (const requirement of requires) try { visit(parseLogicExpression(requirement)); } catch { /* Structured relations are handled by Z3. */ }
  const tuples: PropertyLiteral[][] = [];
  const related = new Set(relations.flatMap((relation) => [relation.source, relation.target]));
  const hintedSeeds = [...related].filter((index) => hints[index]?.length);
  const seedIndices = hintedSeeds.length ? hintedSeeds : [...new Set(relations.map((relation) => relation.source))];
  for (const seedIndex of seedIndices) {
    const seedDomain = domains[seedIndex] as PropertyBoundaryKind;
    const seedValues = hints[seedIndex]?.length ? hints[seedIndex]! : edgeValues[seedDomain];
    for (const seedValue of seedValues) {
      if (typeof seedValue !== "number") continue;
      const assigned = new Map<number, number>([[seedIndex, seedValue]]);
      let valid = true, changed = true;
      while (changed && valid) {
        changed = false;
        for (const relation of relations) {
          const source = assigned.get(relation.source), target = assigned.get(relation.target);
          if (source !== undefined) {
            const expected = source + relation.offset;
            if (target !== undefined && target !== expected) { valid = false; break; }
            if (target === undefined) { assigned.set(relation.target, expected); changed = true; }
          } else if (target !== undefined) {
            assigned.set(relation.source, target - relation.offset); changed = true;
          }
        }
        if (!changed) {
          const unresolved = relations.find((relation) => !assigned.has(relation.source) && !assigned.has(relation.target));
          if (unresolved) {
            const domain = domains[unresolved.source] as PropertyBoundaryKind;
            assigned.set(unresolved.source, Number(hints[unresolved.source]?.[0] ?? edgeValues[domain][0]!));
            changed = true;
          }
        }
      }
      const tuple = domains.map((domain, index): PropertyLiteral => assigned.get(index) ?? hints[index]?.[0] ?? edgeValues[domain as PropertyBoundaryKind][0]!);
      if (!valid || !tuple.every((value, index) => domainAccepts(domains[index]!, value))) continue;
      if (!relations.every((relation) => Number(tuple[relation.target]) === Number(tuple[relation.source]) + relation.offset)) continue;
      if (!tuples.some((candidate) => JSON.stringify(candidate) === JSON.stringify(tuple))) tuples.push(tuple);
    }
  }
  return tuples;
}

function emitTest(boundary: InternalBoundary, sourceName: string, outputName: string, cases: number, seed: number, shrinking: boolean, arrayLengthCap: number): string {
  const parameterNames = boundary.parameters;
  const predicates = boundary.requires.length ? boundary.requires.map((value) => `(${value})`).join(" && ") : "true";
  const postconditions = boundary.ensures.map((value) => `(${value})`).join(" && ");
  return `// Generated by Uneffect. Test-only code; no production runtime dependency.\n` +
    `import { expect, test } from "vitest"\n` +
    `import { ${boundary.functionName} } from ${JSON.stringify(importPath(sourceName, outputName))}\n\n` +
    `const domains = ${JSON.stringify(boundary.generators)} as const\n` +
    `const refinementValues = ${JSON.stringify(boundary.generatorHints)} as const\n` +
    `const refinementTuples = ${JSON.stringify(boundary.generatorTuples)} as const\n` +
    `const limits: Record<string, readonly number[]> = ${JSON.stringify(edgeValues)}\n` +
    `type Domain = typeof domains[number]\n` +
    `function values(domain: any, refined: readonly any[] = []): any[] { if (typeof domain === "string") return [...new Set([...refined, ...limits[domain]!] as any[])]; if (domain.kind === "union") return [...new Set([...refined, ...domain.members.flatMap((member: any) => typeof member === "string" ? limits[member]! : [member.value])] as any[])]; if (domain.kind === "record") { let out: any[] = [{}]; for (const [name, field] of Object.entries(domain.fields)) { const fieldValues = [...(domain.optional?.includes(name) ? [undefined] : []), ...values(field).slice(0, 5)]; out = out.flatMap(record => fieldValues.map(value => value === undefined ? record : ({ ...record, [name]: value }))).slice(0, 64) } return out } const maximum = Math.min(domain.maximum, ${arrayLengthCap}); const lengths = [...new Set([0, Math.min(1, maximum), Math.min(2, maximum), maximum])]; return lengths.map((length, offset) => Array.from({ length }, (_, index) => limits[domain.element]![(index + offset) % limits[domain.element]!.length]!)) }\n` +
    `function shrinkNumber(value: number, domain: string): number[] { const values: number[] = []; let current = value; while (Math.abs(current) > 1) { current = Math.trunc(current / 2); values.push(current) } values.push(0); return [...new Set(values)].filter(value => !["Nat", "U8", "U32"].includes(domain) || value >= 0) }\n` +
    `function shrink(value: any, domain: any): any[] { if (typeof domain === "string") return typeof value === "number" ? shrinkNumber(value, domain) : []; if (domain.kind === "union") return domain.members.flatMap((member: any) => typeof member === "string" && typeof value === "number" ? shrinkNumber(value, member) : []); if (domain.kind === "record") return Object.entries(domain.fields).flatMap(([name, field]) => { const omitted = domain.optional?.includes(name) && Object.hasOwn(value, name) ? [Object.fromEntries(Object.entries(value).filter(([key]) => key !== name))] : []; return [...omitted, ...shrink(value[name], field).map(candidate => ({ ...value, [name]: candidate }))] }); const structural: number[][] = []; for (let length = Math.floor(value.length / 2); length > 0; length = Math.floor(length / 2)) structural.push(value.slice(0, length)); if (value.length > 1) structural.push(value.slice(0, 1)); return [...structural, ...value.flatMap((entry: number, index: number) => shrinkNumber(entry, domain.element).map(candidate => value.with(index, candidate))), []] }\n` +
    `function materialize(value: any, domain: Domain): any { if (typeof domain === "object" && domain.kind === "bounded-array") return domain.element === "U8" ? new Uint8Array(value) : new Uint32Array(value); return value }\n` +
    `function sampleSize(values: readonly any[]): number { const size = (value: any): number => Array.isArray(value) ? value.length + value.reduce((sum: number, entry: number) => sum + Math.abs(entry), 0) : value !== null && typeof value === "object" ? Object.values(value).reduce((sum: number, entry) => sum + size(entry), 0) : typeof value === "number" ? Math.abs(value) : typeof value === "string" ? value.length : Number(value); return values.reduce((total, value) => total + size(value), 0) }\n` +
    `function random(seed: number) { let state = seed >>> 0; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000) }\n` +
    `function samples() { const out: any[][] = refinementTuples.map(row => [...row]); const limit = Math.max(${cases}, out.length); const visit = (at: number, row: any[]) => { if (out.length >= limit) return; if (at === domains.length) { if (!out.some(item => JSON.stringify(item) === JSON.stringify(row))) out.push(row); return } for (const value of values(domains[at]!, refinementValues[at])) visit(at + 1, [...row, value]) }; visit(0, []); const next = random(${seed}); while (out.length < limit) out.push(domains.map((domain, index) => { const candidates = values(domain, refinementValues[index]); return candidates[Math.floor(next() * candidates.length)]! })); return out }\n` +
    `const precondition = (${parameterNames.join(", ")}) => ${predicates}\n` +
    `const property = (${parameterNames.join(", ")}) => { const result = ${boundary.functionName}(${parameterNames.join(", ")}); return ${postconditions} }\n\n` +
    `test(${JSON.stringify(`uneffect property: ${boundary.functionName}`)}, () => {\n` +
    `  for (const candidate of samples()) {\n` +
    `    const invoke = (values: any[]) => values.map((value, index) => materialize(value, domains[index]!))\n` +
    `    if (!precondition(...invoke(candidate))) continue\n` +
    `    if (property(...invoke(candidate))) continue\n` +
    (shrinking ? `    const minimal = [...candidate]; for (const joint of refinementTuples.map(row => [...row]).sort((left, right) => sampleSize(left) - sampleSize(right))) { if (sampleSize(joint) < sampleSize(minimal) && precondition(...invoke(joint)) && !property(...invoke(joint))) minimal.splice(0, minimal.length, ...joint) } for (let index = 0; index < minimal.length; index++) for (const value of shrink(minimal[index]!, domains[index]!)) { const next = minimal.with(index, value); if (precondition(...invoke(next)) && !property(...invoke(next))) minimal[index] = value }\n` : `    const minimal = candidate\n`) +
    `    expect.fail("Uneffect counterexample: " + JSON.stringify({ functionName: ${JSON.stringify(boundary.functionName)}, arguments: minimal }))\n` +
    `  }\n` +
    `})\n`;
}

/** Generates standalone Vitest property tests. It never changes production JavaScript emit. */
export function generateUneffectPropertyTests(options: GenerateUneffectPropertyTestsOptions): GenerateUneffectPropertyTestsResult {
  if (options.backend !== undefined && options.backend !== "quickcheck") throw new Error(`unsupported property backend: ${options.backend}`);
  const maximumGeneratedArrayLength = arrayCap(options.arrayLengthCap);
  const generatedFiles: Record<string, string> = {}, boundaries: InternalBoundary[] = [], diagnostics: GenerateUneffectPropertyTestsResult["diagnostics"] = [];
  for (const [fileName, text] of Object.entries(options.files)) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fileBoundaries: InternalBoundary[] = [];
    for (const node of source.statements) {
      if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
      const comments = text.slice(node.getFullStart(), node.getStart(source));
      const requires = extractAnnotations(comments, "requires"), ensures = extractAnnotations(comments, "ensures");
      if (requires.length === 0 && ensures.length === 0) continue;
      if (ensures.length === 0) { diagnostics.push({ fileName, functionName: node.name.text, message: "property generation requires at least one ensures clause" }); continue; }
      const domains = node.parameters.map((parameter) => typeDomain(parameter.type));
      if (domains.some((value) => !value) || node.parameters.some((parameter) => !ts.isIdentifier(parameter.name))) {
        diagnostics.push({ fileName, functionName: node.name.text, message: "property generation currently supports identifier parameters with scalar, bounded typed-array, or literal-union boundaries" }); continue;
      }
      try { [...requires, ...ensures].forEach(validateExpression); } catch (cause) {
        diagnostics.push({ fileName, functionName: node.name.text, message: cause instanceof Error ? cause.message : String(cause) }); continue;
      }
      const parameters = node.parameters.map((parameter) => (parameter.name as ts.Identifier).text);
      const generatorHints = refinementHints(requires, parameters, domains as PropertyTestDomain[]);
      const derivedTuples = correlatedRefinementTuples(requires, parameters, domains as PropertyTestDomain[], generatorHints);
      const suppliedTuples = options.refinementTuples?.[boundaryKey(fileName, node.name.text)] ?? [];
      const generatorTuples = [...derivedTuples, ...suppliedTuples.map((tuple) => [...tuple])]
        .filter((tuple, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(tuple)) === index);
      const boundary: InternalBoundary = { fileName, functionName: node.name.text, generators: domains as PropertyTestDomain[], shrinkers: domains as PropertyTestDomain[], generatorHints, generatorTuples, parameters, requires, ensures };
      boundaries.push(boundary); fileBoundaries.push(boundary);
    }
    if (fileBoundaries.length > 0) {
      const outputName = generatedName(fileName);
      generatedFiles[outputName] = fileBoundaries.map((boundary) => emitTest(boundary, fileName, outputName, options.cases ?? 100, options.seed ?? 0x5eed, options.shrinking !== false, maximumGeneratedArrayLength)).join("\n");
    }
  }
  return { generatedFiles, boundaries: boundaries.map(({ parameters: _, ...boundary }) => boundary), diagnostics };
}

function z3Integer(value: string): number | undefined {
  const normalized = /^\(-\s+(\d+)\)$/.exec(value)?.[1];
  const parsed = Number(normalized === undefined ? value : `-${normalized}`);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function scalarDomainConstraint(name: string, domain: PropertyBoundaryKind): string[] {
  if (domain === "Nat") return [`(>= ${name} 0)`];
  if (domain === "U8") return [`(>= ${name} 0)`, `(<= ${name} 255)`];
  if (domain === "U32") return [`(>= ${name} 0)`, `(<= ${name} 4294967295)`];
  if (domain === "I32") return [`(>= ${name} -2147483648)`, `(<= ${name} 2147483647)`];
  return [];
}

interface Z3ArrayLayout { name: string; maximum: number; element: "U8" | "U32" }
interface Z3RecordLayout { name: string; fields: Readonly<Record<string, PropertyTestDomain>>; optional?: readonly string[] }

function recordLeaves(fields: Readonly<Record<string, PropertyTestDomain>>, prefix = "", optional: readonly string[] = []): Array<{ path: string; domain: PropertyBoundaryKind; optional: boolean }> {
  return Object.entries(fields).flatMap(([name, domain]) => {
    const path = prefix ? `${prefix}__${name}` : name;
    if (typeof domain === "string") return [{ path, domain, optional: optional.includes(name) }];
    return domain.kind === "record" ? recordLeaves(domain.fields, path, domain.optional) : [];
  });
}

function propertyPath(node: ts.Expression): { root: string; path: string[] } | undefined {
  if (ts.isIdentifier(node)) return { root: node.text, path: [] };
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const parent = propertyPath(node.expression);
  return parent ? { root: parent.root, path: [...parent.path, node.name.text] } : undefined;
}

function nestedRecordValue(entries: readonly (readonly [string, number])[]): PropertyRecord {
  const result: PropertyRecord = {};
  for (const [path, value] of entries) {
    const parts = path.split("__");
    let target = result;
    for (const part of parts.slice(0, -1)) {
      const existing = target[part];
      if (existing === null || typeof existing !== "object" || Array.isArray(existing)) target[part] = {};
      target = target[part] as PropertyRecord;
    }
    target[parts.at(-1)!] = value;
  }
  return result;
}

function structuredPropertyToSmt(node: ts.Expression, arrays: ReadonlyMap<string, Z3ArrayLayout>, records: ReadonlyMap<string, Z3RecordLayout>): string {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return structuredPropertyToSmt(node.expression, arrays, records);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = structuredPropertyToSmt(node.operand, arrays, records);
    if (node.operator === ts.SyntaxKind.ExclamationToken) return `(not ${operand})`;
    if (node.operator === ts.SyntaxKind.MinusToken) return `(- ${operand})`;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.name.text === "length" && arrays.has(node.expression.text)) {
    return `${node.expression.text}__length`;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const access = propertyPath(node), layout = access && records.get(access.root);
    const path = access?.path.join("__");
    if (!layout || !path || !recordLeaves(layout.fields).some((leaf) => leaf.path === path)) throw new Error(`unknown solver-backed record field ${node.getText()}`);
    return `${layout.name}__${path}`;
  }
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.argumentExpression && ts.isNumericLiteral(node.argumentExpression)) {
    const layout = arrays.get(node.expression.text), index = Number(node.argumentExpression.text);
    if (!layout || !Number.isSafeInteger(index) || index < 0 || index >= layout.maximum) throw new Error(`array index ${node.getText()} is outside the solver-backed finite layout`);
    return `${layout.name}__${index}`;
  }
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.argumentExpression) {
    const layout = arrays.get(node.expression.text);
    if (!layout || layout.maximum === 0) throw new Error(`dynamic array access ${node.getText()} has no finite solver-backed elements`);
    const index = structuredPropertyToSmt(node.argumentExpression, arrays, records);
    let selected = "-1";
    for (let at = layout.maximum - 1; at >= 0; at--) selected = `(ite (= ${index} ${at}) ${layout.name}__${at} ${selected})`;
    return selected;
  }
  if (ts.isBinaryExpression(node)) {
    const undefinedAccess = (candidate: ts.Expression, other: ts.Expression): string | undefined => {
      if (!ts.isIdentifier(other) || other.text !== "undefined") return undefined;
      const access = propertyPath(candidate), layout = access && records.get(access.root), path = access?.path.join("__");
      return layout && path && recordLeaves(layout.fields, "", layout.optional).some((leaf) => leaf.path === path && leaf.optional)
        ? `${layout.name}__${path}__present` : undefined;
    };
    const presence = undefinedAccess(node.left, node.right) ?? undefinedAccess(node.right, node.left);
    if (presence && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind)) return `(not ${presence})`;
    if (presence && [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return presence;
    const operator = new Map<ts.SyntaxKind, string>([
      [ts.SyntaxKind.PlusToken, "+"], [ts.SyntaxKind.MinusToken, "-"], [ts.SyntaxKind.AsteriskToken, "*"], [ts.SyntaxKind.SlashToken, "div"], [ts.SyntaxKind.PercentToken, "mod"],
      [ts.SyntaxKind.LessThanToken, "<"], [ts.SyntaxKind.LessThanEqualsToken, "<="], [ts.SyntaxKind.GreaterThanToken, ">"], [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
      [ts.SyntaxKind.EqualsEqualsToken, "="], [ts.SyntaxKind.EqualsEqualsEqualsToken, "="], [ts.SyntaxKind.AmpersandAmpersandToken, "and"], [ts.SyntaxKind.BarBarToken, "or"],
    ]).get(node.operatorToken.kind);
    const left = structuredPropertyToSmt(node.left, arrays, records), right = structuredPropertyToSmt(node.right, arrays, records);
    if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return `(not (= ${left} ${right}))`;
    if (operator) return `(${operator} ${left} ${right})`;
  }
  throw new Error(`unsupported solver-backed property expression: ${node.getText()}`);
}

function structuredAccessBounds(node: ts.Expression, arrays: ReadonlyMap<string, Z3ArrayLayout>, records: ReadonlyMap<string, Z3RecordLayout>): string[] {
  const bounds: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isElementAccessExpression(current) && ts.isIdentifier(current.expression) && current.argumentExpression
      && !ts.isNumericLiteral(current.argumentExpression) && arrays.has(current.expression.text)) {
      const index = structuredPropertyToSmt(current.argumentExpression, arrays, records);
      bounds.push(`(>= ${index} 0)`, `(< ${index} ${current.expression.text}__length)`);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return bounds;
}

/** Enumerates numeric models for restricted nonlinear `requires` clauses, then emits ordinary standalone tests. */
export async function generateUneffectPropertyTestsWithZ3(options: GenerateUneffectPropertyTestsWithZ3Options): Promise<GenerateUneffectPropertyTestsWithZ3Result> {
  const solverCases = options.solverCases ?? 16;
  if (!Number.isSafeInteger(solverCases) || solverCases < 1) throw new Error(`solverCases must be a positive safe integer, got ${solverCases}`);
  const initial = generateUneffectPropertyTests(options);
  const accepted = new Set(initial.boundaries.map((boundary) => boundaryKey(boundary.fileName, boundary.functionName)));
  const injected: Record<string, PropertyValue[][]> = {};
  const solverDiagnostics: PropertySolverDiagnostic[] = [];
  const { Context } = await initZ3();
  const context: any = new Context(`uneffect_property_models_${Date.now()}_${Math.random()}`);
  for (const [fileName, text] of Object.entries(options.files)) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const node of source.statements) {
      if (!ts.isFunctionDeclaration(node) || !node.name || !accepted.has(boundaryKey(fileName, node.name.text))) continue;
      const comments = text.slice(node.getFullStart(), node.getStart(source));
      const requires = extractAnnotations(comments, "requires");
      if (requires.length === 0) continue;
      const names = node.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : "");
      const domains = node.parameters.map((parameter) => typeDomain(parameter.type));
      if (names.some((name) => !name) || domains.some((domain) => !domain || typeof domain === "object" && domain.kind === "union")) continue;
      const layouts = new Map<string, Z3ArrayLayout>();
      const records = new Map<string, Z3RecordLayout>();
      names.forEach((name, index) => {
        const domain = domains[index]!;
        if (typeof domain === "object" && domain.kind === "bounded-array") layouts.set(name, {
          name, element: domain.element, maximum: Math.min(domain.maximum, arrayCap(options.arrayLengthCap)),
        });
        if (typeof domain === "object" && domain.kind === "record") records.set(name, { name, fields: domain.fields, optional: domain.optional });
      });
      const requirementExpressions = requires.map(propertyExpression);
      const declarations = names.flatMap((name, index) => {
        const domain = domains[index]!;
        if (typeof domain === "string") return [`(declare-const ${name} Int)`];
        if (domain.kind === "bounded-array") {
          const layout = layouts.get(name)!;
          return [`(declare-const ${name}__length Int)`, ...Array.from({ length: layout.maximum }, (_, at) => `(declare-const ${name}__${at} Int)` )];
        }
        return domain.kind === "record" ? recordLeaves(domain.fields, "", domain.optional).flatMap(({ path, optional }) => [
          `(declare-const ${name}__${path} Int)`, ...(optional ? [`(declare-const ${name}__${path}__present Bool)`] : []),
        ]) : [];
      });
      const assertions = [
        ...requirementExpressions.map((requirement) => structuredPropertyToSmt(requirement, layouts, records)),
        ...requirementExpressions.flatMap((requirement) => structuredAccessBounds(requirement, layouts, records)),
        ...names.flatMap((name, index) => {
          const domain = domains[index]!;
          if (typeof domain === "string") return scalarDomainConstraint(name, domain);
          if (domain.kind === "bounded-array") {
            const layout = layouts.get(name)!;
            const upper = layout.element === "U8" ? 255 : 4_294_967_295;
            return [
              `(>= ${name}__length 0)`, `(<= ${name}__length ${layout.maximum})`,
              ...Array.from({ length: layout.maximum }, (_, at) => `(>= ${name}__${at} 0)`),
              ...Array.from({ length: layout.maximum }, (_, at) => `(<= ${name}__${at} ${upper})`),
              ...Array.from({ length: layout.maximum }, (_, at) => `(=> (<= ${name}__length ${at}) (= ${name}__${at} 0))`),
            ];
          }
          return domain.kind === "record" ? recordLeaves(domain.fields, "", domain.optional).flatMap(({ path, domain: fieldDomain, optional }) => {
            const constraints = scalarDomainConstraint(`${name}__${path}`, fieldDomain);
            return optional ? constraints.map((constraint) => `(=> ${name}__${path}__present ${constraint})`) : constraints;
          }) : [];
        }),
      ];
      const blocks: string[] = [];
      const tuples: PropertyValue[][] = [];
      let terminal: "unsat" | "unknown" | undefined;
      for (let count = 0; count < solverCases; count++) {
        const solver = new context.Solver();
        solver.fromString(["(set-logic ALL)", ...declarations, ...assertions.map((value) => `(assert ${value})`), ...blocks.map((value) => `(assert ${value})`)].join("\n"));
        const status = String(await solver.check());
        if (status !== "sat") { terminal = status === "unsat" ? "unsat" : "unknown"; break; }
        const model = solver.model();
        const tuple = names.map((name, index): PropertyValue | undefined => {
          const domain = domains[index]!;
          if (typeof domain === "string") return z3Integer(model.eval(context.Int.const(name), true).toString());
          if (domain.kind === "bounded-array") {
            const layout = layouts.get(name)!;
            const length = z3Integer(model.eval(context.Int.const(`${name}__length`), true).toString());
            if (length === undefined || length < 0 || length > layout.maximum) return undefined;
            const values = Array.from({ length }, (_, at) => z3Integer(model.eval(context.Int.const(`${name}__${at}`), true).toString()));
            return values.some((value) => value === undefined) ? undefined : values as number[];
          }
          if (domain.kind !== "record") return undefined;
          const leaves = recordLeaves(domain.fields, "", domain.optional);
          const entries = leaves.filter(({ path, optional }) => !optional || model.eval(context.Bool.const(`${name}__${path}__present`), true).toString() === "true")
            .map(({ path }) => [path, z3Integer(model.eval(context.Int.const(`${name}__${path}`), true).toString())] as const);
          return entries.some(([, value]) => value === undefined) ? undefined : nestedRecordValue(entries as Array<readonly [string, number]>);
        });
        if (tuple.some((value) => value === undefined)) { terminal = "unknown"; break; }
        const values = tuple as PropertyValue[];
        tuples.push(values);
        const equalities = names.flatMap((name, index) => {
          const value = values[index]!;
          if (typeof value !== "object") return [`(= ${name} ${value})`];
          if (Array.isArray(value)) {
            const layout = layouts.get(name)!;
            return [`(= ${name}__length ${value.length})`, ...Array.from({ length: layout.maximum }, (_, at) => `(= ${name}__${at} ${value[at] ?? 0})`)];
          }
          const recordDomain = domains[index] as Extract<PropertyTestDomain, { kind: "record" }>;
          return recordLeaves(recordDomain.fields, "", recordDomain.optional).flatMap(({ path, optional }) => {
            const entry = path.split("__").reduce<PropertyValue | undefined>((current, part) => current !== null && typeof current === "object" && !Array.isArray(current) ? current[part] : undefined, value);
            const present = entry !== undefined;
            return [...(optional ? [`(= ${name}__${path}__present ${present})`] : []), ...(present ? [`(= ${name}__${path} ${entry})`] : [])];
          });
        });
        blocks.push(`(not (and ${equalities.join(" ")}))`);
      }
      tuples.sort((left, right) => sampleSize(left) - sampleSize(right) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const key = boundaryKey(fileName, node.name.text);
      injected[key] = [...(options.refinementTuples?.[key] ?? []).map((tuple) => [...tuple]), ...tuples];
      if (terminal === "unknown" || terminal === "unsat" && tuples.length === 0) solverDiagnostics.push({
        fileName, functionName: node.name.text, status: terminal,
        message: terminal === "unsat"
          ? `requires has no ${layouts.size + records.size === 0 ? "scalar" : "supported structured"} model`
          : `Z3 could not enumerate a ${layouts.size + records.size === 0 ? "scalar" : "supported structured"} model`,
      });
    }
  }
  const generated = generateUneffectPropertyTests({ ...options, refinementTuples: { ...options.refinementTuples, ...injected } });
  return { ...generated, solverDiagnostics };
}
