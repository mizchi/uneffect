import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { ModelRefinementAdapter, ModelState } from "./model-replay.js";
import type { TemporalSpec } from "./spec-ir.js";
import type { TemporalBinaryOperator, TemporalExpression, TemporalValueType } from "./temporal-expressions.js";
import { formatTemporalValueType, generateRuntimeAssertionExpression, parseTemporalExpression } from "./temporal-expressions.js";
import { checkTemporalExpressionEquivalenceWithZ3 } from "./spec-lint.js";

export type RefinementBindingRole = "create" | "observe" | "action" | "invariant";

export interface RefinementBinding {
  adapterName: string;
  version: string;
  role: RefinementBindingRole;
  modelName?: string;
  exportName: string;
  span: { start: number; end: number };
}

export interface RefinementBindingManifest {
  schema: "uneffect-refinement-bindings/v1";
  fileName: string;
  adapterName: string;
  version: string;
  create: string;
  observe: string;
  abstractions: Record<string, string>;
  actions: Record<string, string>;
  invariants: Record<string, string>;
}

export type RefinementBindingCoverageCode =
  | "missing-action-binding"
  | "unknown-action-binding"
  | "missing-invariant-binding"
  | "unknown-invariant-binding";

export interface RefinementBindingCoverageDiagnostic {
  code: RefinementBindingCoverageCode;
  adapterName: string;
  modelName: string;
  exportName?: string;
  message: string;
}

export type RefinementActionDiagnosticCode =
  | "missing-action-binding" | "unknown-action-binding"
  | "missing-action-guard" | "unexpected-action-guard" | "action-guard-mismatch"
  | "unsupported-action-body" | "action-update-mismatch";

export interface RefinementActionDiagnostic {
  code: RefinementActionDiagnosticCode;
  adapterName: string;
  modelName: string;
  exportName?: string;
  target?: string;
  expected?: string;
  actual?: string;
  message: string;
}

export type RefinementInvariantDiagnosticCode = "missing-invariant-binding" | "unknown-invariant-binding" | "unsupported-invariant-body" | "invariant-expression-mismatch";

export interface RefinementInvariantDiagnostic {
  code: RefinementInvariantDiagnosticCode;
  adapterName: string;
  modelName: string;
  exportName?: string;
  expected?: string;
  actual?: string;
  message: string;
}

const refinementMismatchExpressions = new WeakMap<object, {
  expected: TemporalExpression;
  actual: TemporalExpression;
}>();

export type Z3RefinementDiagnostic<T> = T & {
  backend?: "z3";
  equivalence?: "different" | "unknown";
  reason?: string;
};

export type RefinementStateProjectionDiagnosticCode = "unsupported-create-body" | "unsupported-observe-body" | "create-state-mismatch" | "observe-state-mismatch" | "create-type-mismatch" | "observe-type-mismatch";

export interface RefinementStateProjectionDiagnostic {
  code: RefinementStateProjectionDiagnosticCode;
  adapterName: string;
  role: "create" | "observe";
  exportName: string;
  field?: string;
  expected?: string;
  actual?: string;
  message: string;
}

function parseBinding(value: string, exportName: string, span: { start: number; end: number }): RefinementBinding {
  const match = /^([A-Za-z_$][\w$]*)@([^\s@]+)\s+(create|observe|action\s+([A-Za-z_$][\w$]*)|invariant\s+([A-Za-z_$][\w$]*))$/.exec(value);
  if (!match) throw new Error(`invalid refinement binding on ${exportName}: ${value}`);
  const role: RefinementBindingRole = match[3] === "create" || match[3] === "observe" ? match[3] : match[4] ? "action" : "invariant";
  return { adapterName: match[1]!, version: match[2]!, role, ...(match[4] || match[5] ? { modelName: match[4] ?? match[5] } : {}), exportName, span };
}

/** Extracts function-role bindings without evaluating source expressions. */
export function extractRefinementBindings(fileName: string, text: string): RefinementBinding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings: RefinementBinding[] = [];
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name) continue;
    const leading = text.slice(node.getFullStart(), node.getStart(source));
    for (const value of extractAnnotations(leading, "refinement")) {
      if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) throw new Error(`refinement binding target ${node.name.text} must be exported`);
      const binding = parseBinding(value, node.name.text, { start: node.getStart(source), end: node.getEnd() });
      const count = node.parameters.length;
      const validArity = binding.role === "action" ? count === 1 || count === 2 : count === 1;
      if (!validArity) throw new Error(`refinement ${binding.role} binding ${node.name.text} has ${count} parameters; expected ${binding.role === "action" ? "one runtime parameter and an optional trace-step parameter" : "exactly one parameter"}`);
      bindings.push(binding);
    }
  }
  return bindings;
}

export function buildRefinementBindingManifest(fileName: string, text: string, adapterName: string): RefinementBindingManifest {
  const bindings = extractRefinementBindings(fileName, text).filter((binding) => binding.adapterName === adapterName);
  if (bindings.length === 0) throw new Error(`no refinement bindings found for ${adapterName}`);
  const versions = new Set(bindings.map((binding) => binding.version));
  if (versions.size !== 1) throw new Error(`refinement adapter ${adapterName} has inconsistent versions: ${[...versions].join(", ")}`);
  const singleton = (role: "create" | "observe"): string => {
    const matches = bindings.filter((binding) => binding.role === role);
    if (matches.length !== 1) throw new Error(`refinement adapter ${adapterName} requires exactly one ${role} binding`);
    return matches[0]!.exportName;
  };
  const named = (role: "action" | "invariant"): Record<string, string> => {
    const entries = bindings.filter((binding) => binding.role === role).map((binding) => [binding.modelName!, binding.exportName] as const);
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error(`refinement adapter ${adapterName} has duplicate ${role} bindings`);
    return Object.fromEntries(entries);
  };
  return {
    schema: "uneffect-refinement-bindings/v1", fileName, adapterName, version: bindings[0]!.version,
    create: singleton("create"), observe: singleton("observe"),
    abstractions: Object.fromEntries(parseAbstractionRelations(text, adapterName, bindings[0]!.version)),
    actions: named("action"), invariants: named("invariant"),
  };
}

function parseAbstractionRelations(
  text: string,
  adapterName: string,
  version: string,
  stateNames?: ReadonlySet<string>,
): Map<string, string> {
  const abstraction = new Map<string, string>();
  for (const value of extractAnnotations(text, "abstraction")) {
    const match = /^([A-Za-z_$][\w$]*)@([^\s@]+)\s+([A-Za-z_$][\w$]*)\s*=\s*(\S+)$/.exec(value);
    if (!match) throw new Error(`invalid abstraction relation: ${value}`);
    parseAbstractionValue(match[4]!);
    if (match[1] !== adapterName) continue;
    if (match[2] !== version) throw new Error(`abstraction relation ${match[1]} has version ${match[2]}, expected ${version}`);
    if (stateNames && !stateNames.has(match[3]!)) throw new Error(`abstraction relation refers to unknown model state ${match[3]}`);
    const concretePath = parseAbstractionValue(match[4]!).path;
    const overlaps = [...abstraction.values()].some((existing) => {
      const existingPath = parseAbstractionValue(existing).path;
      return existingPath === concretePath || existingPath.startsWith(`${concretePath}.`) || concretePath.startsWith(`${existingPath}.`);
    });
    if (abstraction.has(match[3]!) || overlaps) throw new Error(`duplicate or overlapping abstraction relation for ${match[3]} or ${match[4]}`);
    abstraction.set(match[3]!, match[4]!);
  }
  return abstraction;
}

function parseAbstractionValue(value: string): { kind: "identity" | "set-from-array" | "map-from-entries"; path: string } {
  const pathPattern = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*";
  if (new RegExp(`^${pathPattern}$`).test(value)) return { kind: "identity", path: value };
  const set = new RegExp(`^Set\\((${pathPattern})\\)$`).exec(value);
  if (set) return { kind: "set-from-array", path: set[1]! };
  const map = new RegExp(`^Map\\((${pathPattern})\\)$`).exec(value);
  if (map) return { kind: "map-from-entries", path: map[1]! };
  throw new Error(`unsupported abstraction expression: ${value}`);
}

/** Checks structural coverage only; it does not prove that implementation bodies refine model transitions. */
export function validateRefinementBindingCoverage(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementBindingCoverageDiagnostic[] {
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const compare = (
    kind: "action" | "invariant",
    modelNames: readonly string[],
    bindings: Record<string, string>,
  ): RefinementBindingCoverageDiagnostic[] => {
    const declared = new Set(modelNames);
    const bound = new Set(Object.keys(bindings));
    return [
      ...modelNames.filter((name) => !bound.has(name)).map((modelName) => ({
        code: `missing-${kind}-binding` as const,
        adapterName,
        modelName,
        message: `${kind} ${modelName} has no ${adapterName} refinement binding`,
      })),
      ...Object.entries(bindings).filter(([name]) => !declared.has(name)).map(([modelName, exportName]) => ({
        code: `unknown-${kind}-binding` as const,
        adapterName,
        modelName,
        exportName,
        message: `${kind} refinement ${exportName} refers to unknown model ${kind} ${modelName}`,
      })),
    ];
  };
  return [
    ...compare("action", spec.actions.map(({ name }) => name), manifest.actions),
    ...compare("invariant", spec.properties.map(({ name }) => name), manifest.invariants),
  ];
}

const temporalBinaryOperators = new Map<ts.SyntaxKind, TemporalBinaryOperator>([
  [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "subtract"],
  [ts.SyntaxKind.AsteriskToken, "multiply"], [ts.SyntaxKind.SlashToken, "divide"],
  [ts.SyntaxKind.PercentToken, "modulo"],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "neq"],
  [ts.SyntaxKind.AmpersandAmpersandToken, "and"], [ts.SyntaxKind.BarBarToken, "or"],
  [ts.SyntaxKind.LessThanToken, "lt"], [ts.SyntaxKind.LessThanEqualsToken, "lte"],
  [ts.SyntaxKind.GreaterThanToken, "gt"], [ts.SyntaxKind.GreaterThanEqualsToken, "gte"],
]);

function formatRefinementExpression(expression: TemporalExpression): string {
  return generateRuntimeAssertionExpression(expression);
}

function refinementExpressionKey(expression: TemporalExpression): string {
  const alphaNormalize = (value: TemporalExpression, bindings: ReadonlyMap<string, string> = new Map()): TemporalExpression => {
    if (value.kind === "name") return { ...value, name: bindings.get(value.name) ?? value.name };
    if (value.kind === "integer" || value.kind === "boolean") return value;
    if (value.kind === "unary") return { ...value, operand: alphaNormalize(value.operand, bindings) };
    if (value.kind === "binary") return { ...value, left: alphaNormalize(value.left, bindings), right: alphaNormalize(value.right, bindings) };
    if (value.kind === "conditional") return { ...value, condition: alphaNormalize(value.condition, bindings), whenTrue: alphaNormalize(value.whenTrue, bindings), whenFalse: alphaNormalize(value.whenFalse, bindings) };
    if (value.kind === "array") return { ...value, elements: value.elements.map((item) => alphaNormalize(item, bindings)) };
    if (value.kind === "record") return { ...value, ...(value.base ? { base: alphaNormalize(value.base, bindings) } : {}), fields: Object.fromEntries(Object.entries(value.fields).map(([name, field]) => [name, alphaNormalize(field, bindings)])) };
    if (value.kind === "field") return { ...value, receiver: alphaNormalize(value.receiver, bindings) };
    if (value.kind === "lambda") {
      const canonical = `\u0000bound:${bindings.size}`;
      return { ...value, parameter: canonical, body: alphaNormalize(value.body, new Map(bindings).set(value.parameter, canonical)) };
    }
    if (value.kind === "call") return { ...value, arguments: value.arguments.map((item) => alphaNormalize(item, bindings)) };
    return { ...value, receiver: alphaNormalize(value.receiver, bindings), arguments: value.arguments.map((item) => alphaNormalize(item, bindings)) };
  };
  return JSON.stringify(alphaNormalize(expression), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
}

function sameRefinementExpression(left: TemporalExpression, right: TemporalExpression): boolean {
  return refinementExpressionKey(left) === refinementExpressionKey(right);
}

function builtinCollectionKind(checker: ts.TypeChecker | undefined, node: ts.Expression): "Set" | "Map" | undefined {
  if (!checker) return undefined;
  const visit = (type: ts.Type, seen: ReadonlySet<ts.Type> = new Set()): "Set" | "Map" | undefined => {
    if (seen.has(type)) return undefined;
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    const name = symbol?.getName();
    if ((name === "Set" || name === "Map")
      && (symbol?.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile)) return name;
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type ? visit(constraint, new Set([...seen, type])) : undefined;
  };
  return visit(checker.getTypeAtLocation(node));
}

function isDeclarationFileSymbol(checker: ts.TypeChecker | undefined, node: ts.Node, name: string): boolean {
  if (!checker) return false;
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.getName() === name
    && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function replaceRefinementName(expression: TemporalExpression, from: string, to: string): TemporalExpression {
  if (expression.kind === "name") return expression.name === from ? { kind: "name", name: to } : expression;
  if (expression.kind === "integer" || expression.kind === "boolean") return expression;
  if (expression.kind === "unary") return { ...expression, operand: replaceRefinementName(expression.operand, from, to) };
  if (expression.kind === "binary") return { ...expression, left: replaceRefinementName(expression.left, from, to), right: replaceRefinementName(expression.right, from, to) };
  if (expression.kind === "conditional") return { ...expression, condition: replaceRefinementName(expression.condition, from, to), whenTrue: replaceRefinementName(expression.whenTrue, from, to), whenFalse: replaceRefinementName(expression.whenFalse, from, to) };
  if (expression.kind === "array") return { ...expression, elements: expression.elements.map((item) => replaceRefinementName(item, from, to)) };
  if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: replaceRefinementName(expression.base, from, to) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, replaceRefinementName(value, from, to)])) };
  if (expression.kind === "field") return { ...expression, receiver: replaceRefinementName(expression.receiver, from, to) };
  if (expression.kind === "lambda") return expression.parameter === from ? expression : { ...expression, body: replaceRefinementName(expression.body, from, to) };
  if (expression.kind === "call") return { ...expression, arguments: expression.arguments.map((item) => replaceRefinementName(item, from, to)) };
  return { ...expression, receiver: replaceRefinementName(expression.receiver, from, to), arguments: expression.arguments.map((item) => replaceRefinementName(item, from, to)) };
}

function canonicalizeAbstractionExpression(expression: TemporalExpression, abstraction: ReadonlyMap<string, string>): TemporalExpression {
  const expressionPath = (value: TemporalExpression): string[] | undefined => {
    if (value.kind === "name") return [value.name];
    if (value.kind !== "field") return undefined;
    const receiver = expressionPath(value.receiver);
    return receiver ? [...receiver, value.name] : undefined;
  };
  const concretePath = expressionPath(expression)?.join(".");
  if (concretePath) for (const [abstract, value] of abstraction) {
    const parsed = parseAbstractionValue(value);
    if (concretePath === parsed.path) return { kind: "name", name: abstract };
    if ((parsed.kind === "set-from-array" || parsed.kind === "map-from-entries") && concretePath === `${parsed.path}.length`) {
      return { kind: "method", receiver: { kind: "name", name: abstract }, name: "size", arguments: [] };
    }
  }
  if (expression.kind === "integer" || expression.kind === "boolean" || expression.kind === "name") return expression;
  if (expression.kind === "unary") return { ...expression, operand: canonicalizeAbstractionExpression(expression.operand, abstraction) };
  if (expression.kind === "binary") return { ...expression, left: canonicalizeAbstractionExpression(expression.left, abstraction), right: canonicalizeAbstractionExpression(expression.right, abstraction) };
  if (expression.kind === "conditional") return { ...expression, condition: canonicalizeAbstractionExpression(expression.condition, abstraction), whenTrue: canonicalizeAbstractionExpression(expression.whenTrue, abstraction), whenFalse: canonicalizeAbstractionExpression(expression.whenFalse, abstraction) };
  if (expression.kind === "array") return { ...expression, elements: expression.elements.map((item) => canonicalizeAbstractionExpression(item, abstraction)) };
  if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: canonicalizeAbstractionExpression(expression.base, abstraction) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, canonicalizeAbstractionExpression(value, abstraction)])) };
  if (expression.kind === "field") {
    const fieldReceiver = canonicalizeAbstractionExpression(expression.receiver, abstraction);
    if (expression.name === "1" && fieldReceiver.kind === "method" && fieldReceiver.name === "get"
      && fieldReceiver.receiver.kind === "name"
      && parseAbstractionValue(abstraction.get(fieldReceiver.receiver.name) ?? fieldReceiver.receiver.name).kind === "map-from-entries") return fieldReceiver;
    return { ...expression, receiver: fieldReceiver };
  }
  if (expression.kind === "lambda") return { ...expression, body: canonicalizeAbstractionExpression(expression.body, abstraction) };
  if (expression.kind === "call") return { ...expression, arguments: expression.arguments.map((item) => canonicalizeAbstractionExpression(item, abstraction)) };
  const receiver = canonicalizeAbstractionExpression(expression.receiver, abstraction);
  const args = expression.arguments.map((item) => canonicalizeAbstractionExpression(item, abstraction));
  if (expression.name === "exists" && receiver.kind === "name"
    && args.length === 1 && args[0]?.kind === "lambda" && args[0].body.kind === "binary" && args[0].body.operator === "eq") {
    const abstractionKind = parseAbstractionValue(abstraction.get(receiver.name) ?? receiver.name).kind;
    const parameter = args[0].parameter;
    const leftIsParameter = args[0].body.left.kind === "name" && args[0].body.left.name === parameter;
    const rightIsParameter = args[0].body.right.kind === "name" && args[0].body.right.name === parameter;
    if (abstractionKind === "set-from-array" && leftIsParameter !== rightIsParameter) return {
      kind: "method", receiver, name: "contains",
      arguments: [leftIsParameter ? args[0].body.right : args[0].body.left],
    };
    const isKey = (value: TemporalExpression): boolean => value.kind === "field" && value.name === "0"
      && value.receiver.kind === "name" && value.receiver.name === parameter;
    const leftIsKey = isKey(args[0].body.left);
    const rightIsKey = isKey(args[0].body.right);
    if (abstractionKind === "map-from-entries" && leftIsKey !== rightIsKey) return {
      kind: "method", receiver: { kind: "method", receiver, name: "keys", arguments: [] }, name: "contains",
      arguments: [leftIsKey ? args[0].body.right : args[0].body.left],
    };
  }
  if ((expression.name === "forall" || expression.name === "exists") && receiver.kind === "name"
    && parseAbstractionValue(abstraction.get(receiver.name) ?? receiver.name).kind === "map-from-entries"
    && args.length === 1 && args[0]?.kind === "lambda") {
    const parameter = args[0].parameter;
    const rewriteValue = (value: TemporalExpression): TemporalExpression | undefined => {
      if (value.kind === "field" && value.name === "1" && value.receiver.kind === "name" && value.receiver.name === parameter) {
        return { kind: "name", name: parameter };
      }
      if (value.kind === "name") return value.name === parameter ? undefined : value;
      if (value.kind === "integer" || value.kind === "boolean") return value;
      if (value.kind === "unary") { const operand = rewriteValue(value.operand); return operand ? { ...value, operand } : undefined; }
      if (value.kind === "binary") { const left = rewriteValue(value.left), right = rewriteValue(value.right); return left && right ? { ...value, left, right } : undefined; }
      if (value.kind === "conditional") {
        const condition = rewriteValue(value.condition), whenTrue = rewriteValue(value.whenTrue), whenFalse = rewriteValue(value.whenFalse);
        return condition && whenTrue && whenFalse ? { ...value, condition, whenTrue, whenFalse } : undefined;
      }
      if (value.kind === "field") { const nestedReceiver = rewriteValue(value.receiver); return nestedReceiver ? { ...value, receiver: nestedReceiver } : undefined; }
      if (value.kind === "array") { const elements = value.elements.map(rewriteValue); return elements.every((item): item is TemporalExpression => !!item) ? { ...value, elements } : undefined; }
      if (value.kind === "record") return undefined;
      if (value.kind === "lambda") return undefined;
      if (value.kind === "call") { const callArgs = value.arguments.map(rewriteValue); return callArgs.every((item): item is TemporalExpression => !!item) ? { ...value, arguments: callArgs } : undefined; }
      const methodReceiver = rewriteValue(value.receiver), methodArgs = value.arguments.map(rewriteValue);
      return methodReceiver && methodArgs.every((item): item is TemporalExpression => !!item) ? { ...value, receiver: methodReceiver, arguments: methodArgs } : undefined;
    };
    const body = rewriteValue(args[0].body);
    if (body) return {
      kind: "method", receiver: { kind: "method", receiver, name: "values", arguments: [] }, name: expression.name,
      arguments: [{ kind: "lambda", parameter, body }],
    };
  }
  return { ...expression, receiver, arguments: args };
}

function refinementFieldPath(
  target: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
): string[] | undefined {
  const matchesReceiver = (base: ts.Expression): boolean => {
    if (base.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isIdentifier(base)) return false;
    if (base.text === receiver) return true;
    const replacement = substitutions.get(base.text);
    return !!replacement && ts.isIdentifier(replacement) && replacement.text === receiver;
  };
  const path: string[] = [];
  let current = target;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      current = current.expression;
      continue;
    }
    const argument = current.argumentExpression;
    const replacement = ts.isIdentifier(argument) ? substitutions.get(argument.text) : argument;
    if (!replacement || !ts.isStringLiteral(replacement)) return undefined;
    path.unshift(replacement.text);
    current = current.expression;
  }
  return path.length > 0 && matchesReceiver(current) ? path : undefined;
}

function refinementFieldName(
  target: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
): string | undefined {
  const path = refinementFieldPath(target, receiver, substitutions);
  return path?.length === 1 ? path[0] : undefined;
}

function normalizeRefinementExpression(
  node: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
  stateNames: ReadonlySet<string>,
  helpers: ReadonlyMap<string, ts.FunctionDeclaration> = new Map(),
  activeHelpers: ReadonlySet<string> = new Set(),
  symbolicSubstitutions: ReadonlyMap<string, TemporalExpression> = new Map(),
  checker?: ts.TypeChecker,
): TemporalExpression | undefined {
  if (ts.isParenthesizedExpression(node)) return normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
  if (ts.isNonNullExpression(node)) return normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
  if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text)) return { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: node.kind === ts.SyntaxKind.TrueKeyword };
  if (ts.isIdentifier(node)) {
    const symbolic = symbolicSubstitutions.get(node.text);
    if (symbolic) return { kind: "name", name: `\u0000local:${node.text}` };
    const replacement = substitutions.get(node.text);
    return replacement ? normalizeRefinementExpression(replacement, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker) : undefined;
  }
  const field = refinementFieldName(node, receiver, substitutions);
  if (field && stateNames.has(field)) return { kind: "name", name: field };
  if (ts.isPropertyAccessExpression(node)) {
    const base = normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (base && node.name.text === "size") return { kind: "method", receiver: base, name: "size", arguments: [] };
    if (base) return { kind: "field", receiver: base, name: node.name.text };
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isNumericLiteral(node.argumentExpression)) {
    const base = normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (base) return { kind: "field", receiver: base, name: node.argumentExpression.text };
  }
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.ExclamationToken)) {
    const operand = normalizeRefinementExpression(node.operand, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    return operand ? { kind: "unary", operator: node.operator === ts.SyntaxKind.ExclamationToken ? "not" : "negate", operand } : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = temporalBinaryOperators.get(node.operatorToken.kind);
    const left = normalizeRefinementExpression(node.left, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const right = normalizeRefinementExpression(node.right, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    return operator && left && right ? { kind: "binary", operator, left, right } : undefined;
  }
  if (ts.isConditionalExpression(node)) {
    const condition = normalizeRefinementExpression(node.condition, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const whenTrue = normalizeRefinementExpression(node.whenTrue, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const whenFalse = normalizeRefinementExpression(node.whenFalse, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    return condition && whenTrue && whenFalse ? { kind: "conditional", condition, whenTrue, whenFalse } : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    let base: TemporalExpression | undefined;
    const fields: Record<string, TemporalExpression> = {};
    for (let index = 0; index < node.properties.length; index++) {
      const property = node.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
        if (index !== 0 || base) return undefined;
        base = normalizeRefinementExpression(property.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
        if (!base) return undefined;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = normalizeRefinementExpression(property.name, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
        if (!value || Object.hasOwn(fields, property.name.text)) return undefined;
        fields[property.name.text] = value;
        continue;
      }
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
      const value = normalizeRefinementExpression(property.initializer, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      if (!name || !value || Object.hasOwn(fields, name)) return undefined;
      fields[name] = value;
    }
    return { kind: "record", ...(base ? { base } : {}), fields };
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "find" && node.arguments.length === 1
    && isDeclarationFileSymbol(checker, node.expression.name, "find")) {
    const from = node.expression.expression, callback = node.arguments[0];
    const fromType = checker?.getTypeAtLocation(from), fromSymbol = fromType?.getSymbol() ?? fromType?.aliasSymbol;
    const builtinArray = fromSymbol?.getName() === "Array"
      && (fromSymbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
    if (builtinArray && callback && ts.isArrowFunction(callback) && callback.parameters.length === 1
      && ts.isIdentifier(callback.parameters[0]!.name) && !ts.isBlock(callback.body)) {
      const collection = normalizeRefinementExpression(from, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      const parameter = callback.parameters[0]!.name.text;
      const nestedSymbols = new Map(symbolicSubstitutions).set(parameter, { kind: "name", name: parameter } as TemporalExpression);
      const body = normalizeRefinementExpression(callback.body, receiver, substitutions, stateNames, helpers, activeHelpers, nestedSymbols, checker);
      const isKey = (value: TemporalExpression): boolean => value.kind === "field" && value.name === "0"
        && value.receiver.kind === "name" && (value.receiver.name === parameter || value.receiver.name === `\u0000local:${parameter}`);
      const exactKeyPredicate = body?.kind === "binary" && body.operator === "eq" && isKey(body.left) !== isKey(body.right);
      if (collection && body?.kind === "binary" && exactKeyPredicate) {
        const leftIsKey = isKey(body.left);
        return { kind: "method", receiver: collection, name: "get", arguments: [leftIsKey ? body.right : body.left] };
      }
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === "keys" || node.expression.name.text === "values")
    && node.arguments.length === 0
    && builtinCollectionKind(checker, node.expression.expression) === "Map"
    && isDeclarationFileSymbol(checker, node.expression.name, node.expression.name.text)) {
    const collection = normalizeRefinementExpression(node.expression.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (collection) return { kind: "method", receiver: collection, name: node.expression.name.text, arguments: [] };
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === "every" || node.expression.name.text === "some") && node.arguments.length === 1
    && isDeclarationFileSymbol(checker, node.expression.name, node.expression.name.text)) {
    const from = node.expression.expression;
    const callback = node.arguments[0];
    const fromType = checker?.getTypeAtLocation(from);
    const fromSymbol = fromType?.getSymbol() ?? fromType?.aliasSymbol;
    const builtinArray = fromSymbol?.getName() === "Array"
      && (fromSymbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
    if (builtinArray && callback && ts.isArrowFunction(callback) && callback.parameters.length === 1
      && ts.isIdentifier(callback.parameters[0]!.name)) {
      const collection = normalizeRefinementExpression(from, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      const parameter = callback.parameters[0]!.name.text;
      const nestedSymbols = new Map(symbolicSubstitutions).set(parameter, { kind: "name", name: parameter } as TemporalExpression);
      const callbackSubstitutions = new Map(substitutions);
      let callbackExpression: ts.Expression | undefined;
      if (ts.isBlock(callback.body)) {
        const statements = [...callback.body.statements];
        const returned = statements.pop();
        if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer
              || !normalizeRefinementExpression(declaration.initializer, receiver, callbackSubstitutions, stateNames, helpers, activeHelpers, nestedSymbols, checker)) return undefined;
            callbackSubstitutions.set(declaration.name.text, declaration.initializer);
          }
        }
        callbackExpression = returned.expression;
      } else callbackExpression = callback.body;
      const body = callbackExpression
        ? normalizeRefinementExpression(callbackExpression, receiver, callbackSubstitutions, stateNames, helpers, activeHelpers, nestedSymbols, checker)
        : undefined;
      if (collection && body) return {
        kind: "method", receiver: collection, name: node.expression.name.text === "some" ? "exists" : "forall",
        arguments: [{ kind: "lambda", parameter, body: replaceRefinementName(body, `\u0000local:${parameter}`, parameter) }],
      };
    }
    if (ts.isCallExpression(from) && ts.isPropertyAccessExpression(from.expression)
      && ts.isIdentifier(from.expression.expression) && from.expression.expression.text === "Array"
      && from.expression.name.text === "from" && from.arguments.length === 1
      && isDeclarationFileSymbol(checker, from.expression.name, "from")
      && callback && ts.isArrowFunction(callback) && callback.parameters.length === 1
      && ts.isIdentifier(callback.parameters[0]!.name)) {
      const collection = normalizeRefinementExpression(from.arguments[0]!, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
      const supportedCollection = builtinCollectionKind(checker, from.arguments[0]!) === "Set"
        || collection?.kind === "method" && (collection.name === "keys" || collection.name === "values");
      const parameter = callback.parameters[0]!.name.text;
      const nestedSymbols = new Map(symbolicSubstitutions).set(parameter, { kind: "name", name: parameter } as TemporalExpression);
      const callbackSubstitutions = new Map(substitutions);
      let callbackExpression: ts.Expression | undefined;
      if (ts.isBlock(callback.body)) {
        const statements = [...callback.body.statements];
        const returned = statements.pop();
        if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer
              || !normalizeRefinementExpression(declaration.initializer, receiver, callbackSubstitutions, stateNames, helpers, activeHelpers, nestedSymbols, checker)) return undefined;
            callbackSubstitutions.set(declaration.name.text, declaration.initializer);
          }
        }
        callbackExpression = returned.expression;
      } else callbackExpression = callback.body;
      const body = normalizeRefinementExpression(callbackExpression, receiver, callbackSubstitutions, stateNames, helpers, activeHelpers, nestedSymbols, checker);
      if (collection && supportedCollection && body) return {
        kind: "method", receiver: collection, name: node.expression.name.text === "some" ? "exists" : "forall",
        arguments: [{ kind: "lambda", parameter, body: replaceRefinementName(body, `\u0000local:${parameter}`, parameter) }],
      };
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && (node.expression.name.text === "has" || node.expression.name.text === "includes") && node.arguments.length === 1
    && (node.expression.name.text === "has" || isDeclarationFileSymbol(checker, node.expression.name, "includes"))) {
    const collection = normalizeRefinementExpression(node.expression.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const argument = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (collection && argument) {
      const membershipReceiver: TemporalExpression = builtinCollectionKind(checker, node.expression.expression) === "Map"
        ? { kind: "method", receiver: collection, name: "keys", arguments: [] }
        : collection;
      return { kind: "method", receiver: membershipReceiver, name: "contains", arguments: [argument] };
    }
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "get" && node.arguments.length === 1
    && builtinCollectionKind(checker, node.expression.expression) === "Map") {
    const collection = normalizeRefinementExpression(node.expression.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    const argument = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions, checker);
    if (collection && argument) return { kind: "method", receiver: collection, name: "get", arguments: [argument] };
  }
  if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) {
    const name = ts.isIdentifier(node.expression) ? node.expression.text : node.expression.getText();
    const helper = helpers.get(name);
    if (!helper?.body || activeHelpers.has(name) || helper.parameters.length !== node.arguments.length
      || helper.body.statements.length !== 1) return undefined;
    const returned = helper.body.statements[0];
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
    const resolveArgument = (argument: ts.Expression, seen: ReadonlySet<string> = new Set()): ts.Expression | undefined => {
      if (!ts.isIdentifier(argument)) return argument;
      if (seen.has(argument.text)) return undefined;
      const replacement = substitutions.get(argument.text);
      if (!replacement) return argument;
      // Identically named parameters in different helper scopes are not an
      // alias cycle: the replacement is the caller's runtime receiver.
      if (ts.isIdentifier(replacement) && replacement.text === argument.text) return replacement;
      return resolveArgument(replacement, new Set([...seen, argument.text]));
    };
    const nested = new Map<string, ts.Expression>();
    for (let index = 0; index < helper.parameters.length; index++) {
      const parameter = helper.parameters[index]!;
      if (!ts.isIdentifier(parameter.name)) return undefined;
      const argument = resolveArgument(node.arguments[index]!);
      if (!argument) return undefined;
      nested.set(parameter.name.text, argument);
    }
    return normalizeRefinementExpression(returned.expression, receiver, nested, stateNames, helpers, new Set([...activeHelpers, name]), symbolicSubstitutions, checker);
  }
  return undefined;
}

function resolveProgramFunction(
  checker: ts.TypeChecker,
  expression: ts.Identifier | ts.PropertyAccessExpression,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): ts.FunctionDeclaration | undefined {
  let symbol = checker.getSymbolAtLocation(expression)
    ?? (ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.name) : undefined);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol || seen.has(symbol)) return undefined;
  const direct = symbol.declarations?.find(ts.isFunctionDeclaration);
  if (direct) return direct;
  const alias = symbol.declarations?.find((declaration): declaration is ts.VariableDeclaration =>
    ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    && !!declaration.initializer
    && (ts.isIdentifier(declaration.initializer) || ts.isPropertyAccessExpression(declaration.initializer)));
  return alias?.initializer && (ts.isIdentifier(alias.initializer) || ts.isPropertyAccessExpression(alias.initializer))
    ? resolveProgramFunction(checker, alias.initializer, new Set([...seen, symbol]))
    : undefined;
}

function validateRefinementActionBodiesInSource(
  source: ts.SourceFile,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  checker?: ts.TypeChecker,
  program?: ts.Program,
): RefinementActionDiagnostic[] {
  const fileName = source.fileName;
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const classes = new Map(source.statements.filter(ts.isClassDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const stateTypes = new Map(spec.states.map(({ name, type }) => [name, type]));
  const abstraction = parseAbstractionRelations(text, adapterName, manifest.version, stateNames);
  const concreteToAbstract = new Map([...abstraction].map(([abstract, value]) => [parseAbstractionValue(value).path, abstract]));
  const expressionStateNames = new Set([...stateNames, ...[...concreteToAbstract.keys()].map((path) => path.split(".")[0]!).filter(Boolean)]);
  const canonicalize = (expression: TemporalExpression): TemporalExpression => canonicalizeAbstractionExpression(expression, abstraction);
  const actionFieldPath = (node: ts.Expression, receiver: string, substitutions: ReadonlyMap<string, ts.Expression>): string[] | undefined => {
    const path = refinementFieldPath(node, receiver, substitutions);
    if (!path?.[0]) return path;
    for (const [abstract, value] of abstraction) {
      const concretePath = parseAbstractionValue(value).path.split(".");
      if (concretePath.every((part, index) => path[index] === part)) return [abstract, ...path.slice(concretePath.length)];
    }
    return path;
  };
  const diagnostics: RefinementActionDiagnostic[] = [];

  const resolveFunction = (expression: ts.Identifier | ts.PropertyAccessExpression, seen: ReadonlySet<ts.Symbol> = new Set()): ts.FunctionDeclaration | undefined => {
    if (!checker) return ts.isIdentifier(expression) ? functions.get(expression.text) : undefined;
    return resolveProgramFunction(checker, expression, seen);
  };

  const knownSubclassCache = new Map<ts.ClassDeclaration, boolean>();
  const hasDispatchSealingTrust = (runtimeClass: ts.ClassDeclaration): boolean => {
    const exported = runtimeClass.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    if (!exported) return true;
    const classSource = runtimeClass.getSourceFile();
    const leading = classSource.text.slice(runtimeClass.getFullStart(), runtimeClass.getStart(classSource));
    return extractAnnotations(leading, "trust").some((value) => /^dispatch-sealing\s+\S/.test(value.trim()));
  };
  const hasKnownSubclass = (runtimeClass: ts.ClassDeclaration): boolean => {
    const cached = knownSubclassCache.get(runtimeClass);
    if (cached !== undefined) return cached;
    let runtimeSymbol = checker && runtimeClass.name ? checker.getSymbolAtLocation(runtimeClass.name) : undefined;
    if (runtimeSymbol && (runtimeSymbol.flags & ts.SymbolFlags.Alias) !== 0) runtimeSymbol = checker!.getAliasedSymbol(runtimeSymbol);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isClassDeclaration(node) && node !== runtimeClass) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
          for (const inherited of clause.types) {
            if (checker && runtimeSymbol) {
              let inheritedSymbol = checker.getSymbolAtLocation(inherited.expression);
              if (inheritedSymbol && (inheritedSymbol.flags & ts.SymbolFlags.Alias) !== 0) inheritedSymbol = checker.getAliasedSymbol(inheritedSymbol);
              if (inheritedSymbol === runtimeSymbol || inheritedSymbol?.declarations?.includes(runtimeClass)) { found = true; return; }
            } else if (runtimeClass.name && ts.isIdentifier(inherited.expression)
              && inherited.expression.text === runtimeClass.name.text) { found = true; return; }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    const roots = program
      ? program.getSourceFiles().filter((file) => !file.isDeclarationFile)
      : [source];
    for (const root of roots) visit(root);
    knownSubclassCache.set(runtimeClass, found);
    return found;
  };

  const resolveRuntimeClass = (parameter: ts.ParameterDeclaration | undefined): ts.ClassDeclaration | undefined => {
    const type = parameter?.type;
    if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
    if (!checker) {
      const runtimeClass = classes.get(type.typeName.text);
      return runtimeClass && hasDispatchSealingTrust(runtimeClass) && !hasKnownSubclass(runtimeClass) ? runtimeClass : undefined;
    }
    let symbol = checker.getSymbolAtLocation(type.typeName);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    const runtimeClass = symbol?.declarations?.find(ts.isClassDeclaration);
    return runtimeClass && hasDispatchSealingTrust(runtimeClass) && !hasKnownSubclass(runtimeClass) ? runtimeClass : undefined;
  };

  const isBuiltinCollectionReceiver = (node: ts.Expression, kind: "set" | "map"): boolean => {
    if (!checker) return true;
    const expected = kind === "set" ? "Set" : "Map";
    const matches = (type: ts.Type, seen: ReadonlySet<ts.Type> = new Set()): boolean => {
      if (seen.has(type)) return false;
      const symbol = type.getSymbol() ?? type.aliasSymbol;
      if (symbol?.getName() === expected
        && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile)) return true;
      const constraint = checker.getBaseConstraintOfType(type);
      return !!constraint && constraint !== type && matches(constraint, new Set([...seen, type]));
    };
    return matches(checker.getTypeAtLocation(node));
  };
  const isBuiltinArrayReceiver = (node: ts.Expression): boolean => {
    if (!checker) return false;
    const type = checker.getTypeAtLocation(node);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    return symbol?.getName() === "Array"
      && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
  };

  const unwrap = (node: ts.Expression): ts.Expression => ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const earlyReturnGuard = (body: ts.Block, receiver: string): { guard?: TemporalExpression; updates: ts.Block } => {
    const first = body.statements[0];
    if (!first || !ts.isIfStatement(first) || first.elseStatement) return { updates: body };
    const returns = ts.isReturnStatement(first.thenStatement)
      ? !first.thenStatement.expression
      : ts.isBlock(first.thenStatement) && first.thenStatement.statements.length === 1
        && ts.isReturnStatement(first.thenStatement.statements[0]!) && !first.thenStatement.statements[0]!.expression;
    const condition = unwrap(first.expression);
    if (!returns || !ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return { updates: body };
    const guard = normalizeRefinementExpression(unwrap(condition.operand), receiver, new Map(), expressionStateNames);
    return guard ? { guard: canonicalize(guard), updates: ts.factory.createBlock(body.statements.slice(1), true) } : { updates: body };
  };

  type AbruptCompletion = "return" | "throw" | "break" | "continue";
  type ActionCompletion = "normal" | AbruptCompletion | {
    kind: "mixed";
    returnWhen?: TemporalExpression;
    throwWhen?: TemporalExpression;
    breakWhen?: TemporalExpression;
    continueWhen?: TemporalExpression;
    throwValue?: TemporalExpression;
  };
  const completionPredicate = (completion: ActionCompletion, abrupt: AbruptCompletion): TemporalExpression => completion === abrupt
    ? { kind: "boolean", value: true }
    : completion === "normal" || typeof completion === "string" ? { kind: "boolean", value: false }
      : completion[abrupt === "return" ? "returnWhen"
        : abrupt === "throw" ? "throwWhen"
          : abrupt === "break" ? "breakWhen" : "continueWhen"]
        ?? { kind: "boolean", value: false };
  const completionThrowValue = (completion: ActionCompletion): TemporalExpression | undefined =>
    typeof completion === "object" ? completion.throwValue : undefined;
  const isBooleanCompletionPredicate = (expression: TemporalExpression, value: boolean): boolean => expression.kind === "boolean" && expression.value === value;
  const orCompletionPredicates = (left: TemporalExpression, right: TemporalExpression): TemporalExpression => {
    if (isBooleanCompletionPredicate(left, false)) return right;
    if (isBooleanCompletionPredicate(right, false)) return left;
    if (isBooleanCompletionPredicate(left, true) || isBooleanCompletionPredicate(right, true)) return { kind: "boolean", value: true };
    if (right.kind === "conditional" && sameRefinementExpression(left, right.condition)) {
      return orCompletionPredicates(left, right.whenFalse);
    }
    if (left.kind === "conditional" && sameRefinementExpression(right, left.condition)) {
      return orCompletionPredicates(right, left.whenFalse);
    }
    return { kind: "binary", operator: "or", left, right };
  };
  const andCompletionPredicates = (left: TemporalExpression, right: TemporalExpression): TemporalExpression => isBooleanCompletionPredicate(left, false) || isBooleanCompletionPredicate(right, false)
    ? { kind: "boolean", value: false }
    : isBooleanCompletionPredicate(left, true) ? right
      : isBooleanCompletionPredicate(right, true) ? left : { kind: "binary", operator: "and", left, right };
  const notCompletionPredicate = (expression: TemporalExpression): TemporalExpression => expression.kind === "boolean"
    ? { kind: "boolean", value: !expression.value }
    : { kind: "unary", operator: "not", operand: expression };
  const makeCompletion = (
    returnWhen: TemporalExpression,
    throwWhen: TemporalExpression,
    throwValue?: TemporalExpression,
    breakWhen: TemporalExpression = { kind: "boolean", value: false },
    continueWhen: TemporalExpression = { kind: "boolean", value: false },
  ): ActionCompletion => {
    const noReturn = isBooleanCompletionPredicate(returnWhen, false);
    const noThrow = isBooleanCompletionPredicate(throwWhen, false);
    const noBreak = isBooleanCompletionPredicate(breakWhen, false);
    const noContinue = isBooleanCompletionPredicate(continueWhen, false);
    if (noReturn && noThrow && noBreak && noContinue) return "normal";
    if (isBooleanCompletionPredicate(returnWhen, true) && noThrow && noBreak && noContinue) return "return";
    if (isBooleanCompletionPredicate(throwWhen, true) && noReturn && noBreak && noContinue && !throwValue) return "throw";
    if (isBooleanCompletionPredicate(breakWhen, true) && noReturn && noThrow && noContinue) return "break";
    if (isBooleanCompletionPredicate(continueWhen, true) && noReturn && noThrow && noBreak) return "continue";
    return {
      kind: "mixed",
      ...(noReturn ? {} : { returnWhen }),
      ...(noThrow ? {} : { throwWhen }),
      ...(noBreak ? {} : { breakWhen }),
      ...(noContinue ? {} : { continueWhen }),
      ...(throwValue ? { throwValue } : {}),
    };
  };
  const joinCompletionPredicate = (condition: TemporalExpression, whenTrue: TemporalExpression, whenFalse: TemporalExpression): TemporalExpression => {
    if (isBooleanCompletionPredicate(whenTrue, true) && isBooleanCompletionPredicate(whenFalse, false)) return condition;
    if (isBooleanCompletionPredicate(whenTrue, false) && isBooleanCompletionPredicate(whenFalse, true)) return notCompletionPredicate(condition);
    if (sameRefinementExpression(whenTrue, whenFalse)) return whenTrue;
    return { kind: "conditional", condition, whenTrue, whenFalse };
  };
  const joinThrowValue = (
    condition: TemporalExpression,
    whenTrue: ActionCompletion,
    whenFalse: ActionCompletion,
  ): TemporalExpression | undefined => {
    const trueThrows = completionPredicate(whenTrue, "throw");
    const falseThrows = completionPredicate(whenFalse, "throw");
    const trueValue = completionThrowValue(whenTrue);
    const falseValue = completionThrowValue(whenFalse);
    if (isBooleanCompletionPredicate(trueThrows, false)) return falseValue;
    if (isBooleanCompletionPredicate(falseThrows, false)) return trueValue;
    if (!trueValue || !falseValue) return undefined;
    return sameRefinementExpression(trueValue, falseValue)
      ? trueValue
      : joinCompletionPredicate(condition, trueValue, falseValue);
  };
  const sequenceThrowValue = (
    prior: ActionCompletion,
    continued: ActionCompletion,
  ): TemporalExpression | undefined => {
    const priorThrows = completionPredicate(prior, "throw");
    const continuedThrows = completionPredicate(continued, "throw");
    const priorValue = completionThrowValue(prior);
    const continuedValue = completionThrowValue(continued);
    if (isBooleanCompletionPredicate(priorThrows, true)) return priorValue;
    if (isBooleanCompletionPredicate(priorThrows, false)) return continuedValue;
    if (isBooleanCompletionPredicate(continuedThrows, false)) return priorValue;
    if (!priorValue || !continuedValue) return undefined;
    return sameRefinementExpression(priorValue, continuedValue)
      ? priorValue
      : { kind: "conditional", condition: priorThrows, whenTrue: priorValue, whenFalse: continuedValue };
  };
  const collect = (
    body: ts.Block,
    receiver: string,
    runtimeClass: ts.ClassDeclaration | undefined,
    initialSubstitutions: ReadonlyMap<string, ts.Expression>,
    updates: Map<string, TemporalExpression> = new Map(),
    localValues: Map<string, TemporalExpression> = new Map(),
    activeCalls: ReadonlySet<string> = new Set(),
    allowTerminalReturn = true,
    allowTerminalThrow = false,
    allowBreak = false,
    allowContinue = false,
  ): ActionCompletion | undefined => {
    // Each lexical block gets its own immutable-alias environment. Recursive
    // branch collection receives a snapshot, so aliases declared in a nested
    // block cannot leak into its sibling or enclosing continuation.
    const substitutions = new Map(initialSubstitutions);
    const isRuntimeReceiverExpression = (expression: ts.Expression, seen: ReadonlySet<string> = new Set()): boolean => {
      const candidate = unwrap(expression);
      if (candidate.kind === ts.SyntaxKind.ThisKeyword) return receiver === "this";
      if (!ts.isIdentifier(candidate)) return false;
      if (candidate.text === receiver) return true;
      if (seen.has(candidate.text)) return false;
      const replacement = substitutions.get(candidate.text);
      return replacement !== undefined
        && isRuntimeReceiverExpression(replacement, new Set([...seen, candidate.text]));
    };
    const expandLocalSnapshots = (expression: TemporalExpression): TemporalExpression => {
      if (expression.kind === "name" && expression.name.startsWith("\u0000local:")) {
        return localValues.get(expression.name.slice("\u0000local:".length)) ?? expression;
      }
      if (expression.kind === "unary") return { ...expression, operand: expandLocalSnapshots(expression.operand) };
      if (expression.kind === "binary") return { ...expression, left: expandLocalSnapshots(expression.left), right: expandLocalSnapshots(expression.right) };
      if (expression.kind === "conditional") return { ...expression, condition: expandLocalSnapshots(expression.condition), whenTrue: expandLocalSnapshots(expression.whenTrue), whenFalse: expandLocalSnapshots(expression.whenFalse) };
      if (expression.kind === "field") {
        const receiver = expandLocalSnapshots(expression.receiver);
        const project = (value: TemporalExpression): TemporalExpression | undefined => {
          if (value.kind === "record") {
            const own = value.fields[expression.name];
            if (own) return expandLocalSnapshots(own);
            return value.base ? project(value.base) : undefined;
          }
          if (value.kind === "conditional") {
            const whenTrue = project(value.whenTrue);
            const whenFalse = project(value.whenFalse);
            if (!whenTrue || !whenFalse) return undefined;
            return sameRefinementExpression(whenTrue, whenFalse)
              ? whenTrue
              : { kind: "conditional", condition: value.condition, whenTrue, whenFalse };
          }
          return undefined;
        };
        return project(receiver) ?? { ...expression, receiver };
      }
      if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: expandLocalSnapshots(expression.base) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, expandLocalSnapshots(value)])) };
      if (expression.kind === "array") return { ...expression, elements: expression.elements.map(expandLocalSnapshots) };
      return expression;
    };
    const resolveCurrentState = (expression: TemporalExpression): TemporalExpression => {
      const canonical = canonicalize(expression);
      if (!sameRefinementExpression(canonical, expression)) return resolveCurrentState(canonical);
      if (expression.kind === "name") {
        const name = concreteToAbstract.get(expression.name) ?? expression.name;
        return updates.get(name) ?? { kind: "name", name };
      }
      if (expression.kind === "unary") return { ...expression, operand: resolveCurrentState(expression.operand) };
      if (expression.kind === "binary") return { ...expression, left: resolveCurrentState(expression.left), right: resolveCurrentState(expression.right) };
      if (expression.kind === "conditional") return { ...expression, condition: resolveCurrentState(expression.condition), whenTrue: resolveCurrentState(expression.whenTrue), whenFalse: resolveCurrentState(expression.whenFalse) };
      if (expression.kind === "field") return { ...expression, receiver: resolveCurrentState(expression.receiver) };
      if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: resolveCurrentState(expression.base) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, resolveCurrentState(value)])) };
      if (expression.kind === "array") return { ...expression, elements: expression.elements.map(resolveCurrentState) };
      return expression;
    };
    const selectField = (value: TemporalExpression, name: string): TemporalExpression => {
      if (value.kind === "record") {
        const updated = value.fields[name];
        if (updated) return updated;
        if (value.base) return selectField(value.base, name);
      }
      return { kind: "field", receiver: value, name };
    };
    const readPath = (root: string, fields: readonly string[]): TemporalExpression => fields.reduce<TemporalExpression>(
      (value, name) => selectField(value, name),
      updates.get(root) ?? { kind: "name", name: root },
    );
    const writePath = (root: string, fields: readonly string[], value: TemporalExpression): void => {
      if (fields.length === 0) { updates.set(root, value); return; }
      const updateRecord = (base: TemporalExpression, remaining: readonly string[]): TemporalExpression => {
        const [name, ...tail] = remaining;
        if (!name) return value;
        const fieldValue = tail.length === 0 ? value : updateRecord(selectField(base, name), tail);
        if (base.kind === "record" && base.base) return { ...base, fields: { ...base.fields, [name]: fieldValue } };
        return { kind: "record", base, fields: { [name]: fieldValue } };
      };
      const base = updates.get(root) ?? { kind: "name", name: root } as TemporalExpression;
      updates.set(root, updateRecord(base, fields));
    };
    const asBlock = (statement: ts.Statement | undefined): ts.Block => !statement
      ? ts.factory.createBlock([], true)
      : ts.isBlock(statement) ? statement : ts.factory.createBlock([statement], true);
    const substituteFiniteLoopBinding = (
      statement: ts.Statement,
      binding: string,
      replacement: ts.Expression,
    ): ts.Statement | undefined => {
      let unsupported = false;
      const statementStart = statement.getStart(source);
      const replacements: Array<{ start: number; end: number }> = [];
      const pending: ts.Node[] = [statement];
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (ts.isIdentifier(node) && node.text === binding) {
          const parent = node.parent;
          const shadowsBinding = ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent))
            && parent.name === node);
          const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
            || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node)
            || (ts.isLabeledStatement(parent) && parent.label === node)
            || ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node);
          if (shadowsBinding || (ts.isShorthandPropertyAssignment(parent) && parent.name === node)) unsupported = true;
          else if (!isPropertyName) replacements.push({
            start: node.getStart(source) - statementStart,
            end: node.getEnd() - statementStart,
          });
        }
        for (const child of node.getChildren(source)) pending.push(child);
      }
      if (unsupported) return undefined;
      const printedReplacement = ts.createPrinter().printNode(ts.EmitHint.Expression, replacement, source);
      let expandedText = statement.getText(source);
      replacements.sort((left, right) => right.start - left.start);
      for (const location of replacements) {
        expandedText = `${expandedText.slice(0, location.start)}${printedReplacement}${expandedText.slice(location.end)}`;
      }
      const parsed = ts.createSourceFile("__uneffect_finite_loop.ts", expandedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return parsed.statements.length === 1 ? parsed.statements[0] : undefined;
    };
    const expandFiniteLoopIterations = (
      statement: ts.Statement,
      binding: string,
      values: readonly ts.Expression[],
    ): readonly ts.Block[] | undefined => {
      const iterations: ts.Block[] = [];
      for (const value of values) {
        const statements: ts.Statement[] = [];
        for (const item of asBlock(statement).statements) {
          const expanded = substituteFiniteLoopBinding(item, binding, value);
          if (!expanded) return undefined;
          statements.push(expanded);
        }
        iterations.push(ts.factory.createBlock(statements, true));
      }
      return iterations;
    };
    const expandFiniteLoop = (
      statement: ts.Statement,
      binding: string,
      values: readonly ts.Expression[],
    ): ts.Block | undefined => {
      const iterations = expandFiniteLoopIterations(statement, binding, values);
      return iterations ? ts.factory.createBlock(iterations.flatMap((iteration) => [...iteration.statements]), true) : undefined;
    };
    const canonicalBoundedWhile = (
      declarationStatement: ts.VariableStatement,
      loopStatement: ts.Statement,
    ): { binding: string; body: ts.Block; values: readonly ts.Expression[] } | undefined => {
      const declaration = (declarationStatement.declarationList.flags & ts.NodeFlags.Let) !== 0
        && declarationStatement.declarationList.declarations.length === 1
        ? declarationStatement.declarationList.declarations[0] : undefined;
      const binding = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
      const start = declaration?.initializer && ts.isNumericLiteral(declaration.initializer)
        ? Number(declaration.initializer.text) : undefined;
      const condition = ts.isWhileStatement(loopStatement) && ts.isBinaryExpression(loopStatement.expression)
        ? loopStatement.expression : undefined;
      const end = condition && condition.operatorToken.kind === ts.SyntaxKind.LessThanToken
        && ts.isIdentifier(condition.left) && condition.left.text === binding && ts.isNumericLiteral(condition.right)
        ? Number(condition.right.text) : undefined;
      const loopBody = ts.isWhileStatement(loopStatement) && ts.isBlock(loopStatement.statement)
        ? loopStatement.statement : undefined;
      const last = loopBody?.statements.at(-1);
      const increment = last && ts.isExpressionStatement(last) && ts.isPostfixUnaryExpression(last.expression)
        ? last.expression : undefined;
      const incrementsBinding = increment?.operator === ts.SyntaxKind.PlusPlusToken
        && ts.isIdentifier(increment.operand) && increment.operand.text === binding;
      if (!binding || start === undefined || end === undefined || !loopBody || !incrementsBinding
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end - start > 64) return undefined;
      return {
        binding,
        body: ts.factory.createBlock(loopBody.statements.slice(0, -1), true),
        values: Array.from({ length: end - start }, (_, offset) => ts.factory.createNumericLiteral(start + offset)),
      };
    };
    const isUntrackedPrimitiveThrownValue = (expression: ts.Expression): boolean => {
      const value = unwrap(expression);
      return ts.isStringLiteral(value) || value.kind === ts.SyntaxKind.NullKeyword;
    };
    const mergeConditionalUpdates = (
      condition: TemporalExpression,
      whenTrue: ReadonlyMap<string, TemporalExpression>,
      whenFalse: ReadonlyMap<string, TemporalExpression>,
      before: ReadonlyMap<string, TemporalExpression>,
      target: Map<string, TemporalExpression> = updates,
    ): void => {
      target.clear();
      for (const name of stateNames) {
        const initial = { kind: "name", name } as TemporalExpression;
        const original = before.get(name) ?? initial;
        const trueValue = whenTrue.get(name) ?? original;
        const falseValue = whenFalse.get(name) ?? original;
        const merged: TemporalExpression = sameRefinementExpression(trueValue, falseValue)
          ? trueValue
          : { kind: "conditional", condition, whenTrue: trueValue, whenFalse: falseValue };
        if (!sameRefinementExpression(merged, initial)) target.set(name, merged);
      }
    };
    const applyContinuation = (
      completion: ActionCompletion,
      branchUpdates: Map<string, TemporalExpression>,
      continuation: ts.Block,
    ): ActionCompletion | undefined => {
      if (completion === "return" || completion === "throw" || completion === "break" || completion === "continue") return completion;
      if (completion === "normal") return collect(
        continuation, receiver, runtimeClass, substitutions,
        branchUpdates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue,
      );
      const beforeContinuation = new Map(branchUpdates);
      const continuingUpdates = new Map(branchUpdates);
      const continued = collect(
        continuation, receiver, runtimeClass, substitutions,
        continuingUpdates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue,
      );
      if (!continued) return undefined;
      const priorReturn = completionPredicate(completion, "return");
      const priorThrow = completionPredicate(completion, "throw");
      const priorBreak = completionPredicate(completion, "break");
      const priorContinue = completionPredicate(completion, "continue");
      const priorAbrupt = orCompletionPredicates(
        orCompletionPredicates(orCompletionPredicates(priorReturn, priorThrow), priorBreak), priorContinue,
      );
      const normalWhen = notCompletionPredicate(priorAbrupt);
      mergeConditionalUpdates(priorAbrupt, beforeContinuation, continuingUpdates, beforeContinuation, branchUpdates);
      return makeCompletion(
        orCompletionPredicates(priorReturn, andCompletionPredicates(normalWhen, completionPredicate(continued, "return"))),
        orCompletionPredicates(priorThrow, andCompletionPredicates(normalWhen, completionPredicate(continued, "throw"))),
        sequenceThrowValue(completion, continued),
        orCompletionPredicates(priorBreak, andCompletionPredicates(normalWhen, completionPredicate(continued, "break"))),
        orCompletionPredicates(priorContinue, andCompletionPredicates(normalWhen, completionPredicate(continued, "continue"))),
      );
    };
    const collectFiniteLoopIterations = (
      iterations: readonly ts.Block[],
      index: number,
      branchUpdates: Map<string, TemporalExpression>,
    ): ActionCompletion | undefined => {
      const iteration = iterations[index];
      if (!iteration) return "normal";
      const completion = collect(
        iteration, receiver, runtimeClass, substitutions,
        branchUpdates, new Map(localValues), activeCalls,
        allowTerminalReturn, allowTerminalThrow, true, true,
      );
      if (!completion) return undefined;
      const afterContinue = makeCompletion(
        completionPredicate(completion, "return"),
        completionPredicate(completion, "throw"),
        completionThrowValue(completion),
        completionPredicate(completion, "break"),
      );
      if (index + 1 >= iterations.length) return afterContinue;
      if (afterContinue === "return" || afterContinue === "throw" || afterContinue === "break") return afterContinue;
      if (afterContinue === "normal") return collectFiniteLoopIterations(iterations, index + 1, branchUpdates);

      const beforeNext = new Map(branchUpdates);
      const nextUpdates = new Map(branchUpdates);
      const next = collectFiniteLoopIterations(iterations, index + 1, nextUpdates);
      if (!next) return undefined;
      const priorReturn = completionPredicate(afterContinue, "return");
      const priorThrow = completionPredicate(afterContinue, "throw");
      const priorBreak = completionPredicate(afterContinue, "break");
      const priorAbrupt = orCompletionPredicates(orCompletionPredicates(priorReturn, priorThrow), priorBreak);
      const normalWhen = notCompletionPredicate(priorAbrupt);
      mergeConditionalUpdates(priorAbrupt, beforeNext, nextUpdates, beforeNext, branchUpdates);
      return makeCompletion(
        orCompletionPredicates(priorReturn, andCompletionPredicates(normalWhen, completionPredicate(next, "return"))),
        orCompletionPredicates(priorThrow, andCompletionPredicates(normalWhen, completionPredicate(next, "throw"))),
        sequenceThrowValue(afterContinue, next),
        orCompletionPredicates(priorBreak, andCompletionPredicates(normalWhen, completionPredicate(next, "break"))),
        completionPredicate(next, "continue"),
      );
    };
    const consumeLoopTransfers = (
      completion: ActionCompletion,
      branchUpdates: Map<string, TemporalExpression>,
      continuation: ts.Block,
    ): ActionCompletion | undefined => {
      const escaping = makeCompletion(
        completionPredicate(completion, "return"),
        completionPredicate(completion, "throw"),
        completionThrowValue(completion),
      );
      if (escaping === "normal") return collect(
        continuation, receiver, runtimeClass, substitutions,
        branchUpdates, new Map(localValues), activeCalls,
        allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue,
      );
      return applyContinuation(escaping, branchUpdates, continuation);
    };
    const rewriteLabeledBreaks = (statement: ts.LabeledStatement): ts.Block | undefined => {
      if (!ts.isBlock(statement.statement)) return undefined;
      let invalid = false;
      const blockStart = statement.statement.getStart(source);
      const replacements: Array<{ start: number; end: number }> = [];
      const pending: ts.Node[] = [...statement.statement.getChildren(source)];
      while (pending.length > 0) {
        const node = pending.pop()!;
        if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isLabeledStatement(node)
          || ts.isReturnStatement(node)
          || ts.isContinueStatement(node) && !!node.label) {
          invalid = true;
          continue;
        }
        if (ts.isBreakStatement(node) && node.label) {
          if (node.label.text !== statement.label.text) invalid = true;
          else replacements.push({ start: node.getStart(source) - blockStart, end: node.getEnd() - blockStart });
          continue;
        }
        pending.push(...node.getChildren(source));
      }
      if (invalid || replacements.length === 0) return undefined;
      let rewritten = statement.statement.getText(source);
      replacements.sort((left, right) => right.start - left.start);
      for (const replacement of replacements) {
        // The existing return completion implements exactly the local abrupt
        // path. The enclosing labeled-statement handler consumes it instead
        // of propagating it as a function return.
        rewritten = `${rewritten.slice(0, replacement.start)}return;${rewritten.slice(replacement.end)}`;
      }
      const parsed = ts.createSourceFile("__uneffect_labeled_block.ts", rewritten, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      return parsed.statements.length === 1 && ts.isBlock(parsed.statements[0]) ? parsed.statements[0] : undefined;
    };
    for (let statementIndex = 0; statementIndex < body.statements.length; statementIndex++) {
      const statement = body.statements[statementIndex]!;
      const terminalReturn = ts.isReturnStatement(statement);
      if (terminalReturn && !allowTerminalReturn) return undefined;
      if (terminalReturn && !statement.expression) return "return";
      if (terminalReturn && !ts.isCallExpression(statement.expression!)) {
        const returned = normalizeRefinementExpression(
          statement.expression!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
        );
        if (!returned) return undefined;
        // Action refinements compare state transitions, not function result values.
        // Still resolve the expression so unsupported/effectful results are not discarded.
        void expandLocalSnapshots(resolveCurrentState(returned));
        return "return";
      }
      if (ts.isThrowStatement(statement)) {
        if (!allowTerminalThrow) return undefined;
        if (!isUntrackedPrimitiveThrownValue(statement.expression)) {
          const thrown = normalizeRefinementExpression(
            statement.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
          );
          if (!thrown) return undefined;
          return makeCompletion(
            { kind: "boolean", value: false },
            { kind: "boolean", value: true },
            expandLocalSnapshots(resolveCurrentState(thrown)),
          );
        }
        return "throw";
      }
      if (ts.isBreakStatement(statement)) {
        if (!allowBreak || statement.label) return undefined;
        return "break";
      }
      if (ts.isContinueStatement(statement)) {
        if (!allowContinue || statement.label) return undefined;
        return "continue";
      }
      if (ts.isBlock(statement)) {
        const completion = collect(
          statement, receiver, runtimeClass, substitutions,
          updates, new Map(localValues), activeCalls,
          allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue,
        );
        if (!completion) return undefined;
        if (completion === "normal") continue;
        return applyContinuation(
          completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        );
      }
      if (ts.isLabeledStatement(statement)) {
        const labeledBlock = rewriteLabeledBreaks(statement);
        if (!labeledBlock) return undefined;
        const completion = collect(
          labeledBlock, receiver, runtimeClass, substitutions,
          updates, new Map(localValues), activeCalls, true, allowTerminalThrow, allowBreak, allowContinue,
        );
        if (!completion) return undefined;
        // A return here is the rewritten break and is consumed by this label.
        // Throws remain abrupt and only the non-throw paths execute the outer
        // continuation.
        const escapingCompletion = makeCompletion(
          { kind: "boolean", value: false },
          completionPredicate(completion, "throw"),
          completionThrowValue(completion),
          completionPredicate(completion, "break"),
          completionPredicate(completion, "continue"),
        );
        if (escapingCompletion === "normal") continue;
        return applyContinuation(
          escapingCompletion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        );
      }
      if (ts.isVariableStatement(statement) && statementIndex + 1 < body.statements.length) {
        const loop = canonicalBoundedWhile(statement, body.statements[statementIndex + 1]!);
        if (loop && !localValues.has(loop.binding) && !substitutions.has(loop.binding)) {
          const expanded = expandFiniteLoop(
            loop.body,
            loop.binding,
            loop.values,
          );
          if (!expanded) return undefined;
          const completion = collect(
            expanded,
            receiver, runtimeClass, substitutions, updates, new Map(localValues), activeCalls,
            allowTerminalReturn, allowTerminalThrow, true, false,
          );
          return completion ? consumeLoopTransfers(
            completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 2), true),
          ) : undefined;
        }
      }
      if (ts.isWhileStatement(statement)) {
        // This is an exact zero-iteration reduction, not a loop invariant or
        // fixed-point proof. Any non-literal condition remains unsupported.
        if (statement.expression.kind !== ts.SyntaxKind.FalseKeyword) return undefined;
        continue;
      }
      if (ts.isDoStatement(statement)) {
        // `do S while (false)` executes S exactly once. Keep the loop body in
        // its own lexical environment and compose abrupt completion with the
        // outer continuation just like a bare block.
        if (statement.expression.kind !== ts.SyntaxKind.FalseKeyword) return undefined;
        const completion = collect(
          asBlock(statement.statement), receiver, runtimeClass, substitutions,
          updates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow, true,
          true,
        );
        if (!completion) return undefined;
        return consumeLoopTransfers(
          completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        );
      }
      if (ts.isForStatement(statement)) {
        const declaration = statement.initializer && ts.isVariableDeclarationList(statement.initializer)
          && (statement.initializer.flags & ts.NodeFlags.Let) !== 0
          && statement.initializer.declarations.length === 1 ? statement.initializer.declarations[0] : undefined;
        const loopName = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
        const start = declaration?.initializer && ts.isNumericLiteral(declaration.initializer) ? Number(declaration.initializer.text) : undefined;
        const condition = statement.condition && ts.isBinaryExpression(statement.condition) ? statement.condition : undefined;
        const end = condition && condition.operatorToken.kind === ts.SyntaxKind.LessThanToken
          && ts.isIdentifier(condition.left) && condition.left.text === loopName && ts.isNumericLiteral(condition.right)
          ? Number(condition.right.text) : undefined;
        const increment = statement.incrementor;
        const incrementsLoop = increment && ts.isPostfixUnaryExpression(increment)
          && increment.operator === ts.SyntaxKind.PlusPlusToken && ts.isIdentifier(increment.operand) && increment.operand.text === loopName;
        if (!loopName || start === undefined || end === undefined || !incrementsLoop
          || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > 64) return undefined;
        const iterations = expandFiniteLoopIterations(
          statement.statement,
          loopName,
          Array.from({ length: end - start }, (_, offset) => ts.factory.createNumericLiteral(start + offset)),
        );
        if (!iterations) return undefined;
        const completion = collectFiniteLoopIterations(iterations, 0, updates);
        return completion ? consumeLoopTransfers(
          completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        ) : undefined;
      }
      if (ts.isForOfStatement(statement)) {
        const declaration = ts.isVariableDeclarationList(statement.initializer)
          && (statement.initializer.flags & ts.NodeFlags.Const) !== 0
          && statement.initializer.declarations.length === 1 ? statement.initializer.declarations[0] : undefined;
        const loopName = declaration && ts.isIdentifier(declaration.name) && !declaration.initializer
          ? declaration.name.text : undefined;
        const iterable = ts.isAsExpression(statement.expression) ? statement.expression.expression : statement.expression;
        const values = ts.isArrayLiteralExpression(iterable) && iterable.elements.length <= 64
          && iterable.elements.every((element): element is ts.Expression => !ts.isSpreadElement(element)
            && (ts.isNumericLiteral(element) || element.kind === ts.SyntaxKind.TrueKeyword || element.kind === ts.SyntaxKind.FalseKeyword))
          ? [...iterable.elements] : undefined;
        if (statement.awaitModifier || !loopName || !values) return undefined;
        const iterations = expandFiniteLoopIterations(statement.statement, loopName, values);
        if (!iterations) return undefined;
        const completion = collectFiniteLoopIterations(iterations, 0, updates);
        return completion ? consumeLoopTransfers(
          completion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
        ) : undefined;
      }
      if (ts.isTryStatement(statement)) {
        let residualCompletion: ActionCompletion = "normal";
        if (statement.catchClause) {
          const tryCompletion = collect(
            statement.tryBlock, receiver, runtimeClass, substitutions,
            updates, new Map(localValues), activeCalls, true, true, allowBreak, allowContinue,
          );
          if (!tryCompletion) return undefined;
          const throwWhen = completionPredicate(tryCompletion, "throw");
          if (isBooleanCompletionPredicate(throwWhen, false)) return undefined;
          const beforeCatch = new Map(updates);
          const caughtUpdates = new Map(updates);
          const catchLocals = new Map(localValues);
          const catchVariable = statement.catchClause.variableDeclaration?.name;
          const throwValue = completionThrowValue(tryCompletion);
          if (catchVariable && ts.isIdentifier(catchVariable) && throwValue) {
            catchLocals.set(catchVariable.text, throwValue);
          }
          const catchCompletion = collect(
            statement.catchClause.block, receiver, runtimeClass, substitutions,
            caughtUpdates, catchLocals, activeCalls, true, true, allowBreak, allowContinue,
          );
          if (!catchCompletion) return undefined;
          if (isBooleanCompletionPredicate(throwWhen, true)) {
            updates.clear();
            for (const [name, value] of caughtUpdates) updates.set(name, value);
          } else mergeConditionalUpdates(throwWhen, caughtUpdates, beforeCatch, beforeCatch);
          residualCompletion = makeCompletion(
            orCompletionPredicates(
              completionPredicate(tryCompletion, "return"),
              andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "return")),
            ),
            andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "throw")),
            completionThrowValue(catchCompletion),
            orCompletionPredicates(
              completionPredicate(tryCompletion, "break"),
              andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "break")),
            ),
            orCompletionPredicates(
              completionPredicate(tryCompletion, "continue"),
              andCompletionPredicates(throwWhen, completionPredicate(catchCompletion, "continue")),
            ),
          );
        } else {
          const tryCompletion = collect(
            statement.tryBlock, receiver, runtimeClass, substitutions,
            updates, new Map(localValues), activeCalls, true, true, allowBreak, allowContinue,
          );
          if (!tryCompletion) return undefined;
          residualCompletion = tryCompletion;
        }
        if (!statement.finallyBlock) {
          if (residualCompletion === "normal") continue;
        } else {
          const priorReturn = completionPredicate(residualCompletion, "return");
          const priorThrow = completionPredicate(residualCompletion, "throw");
          const priorBreak = completionPredicate(residualCompletion, "break");
          const priorContinue = completionPredicate(residualCompletion, "continue");
          const finallyCompletion = collect(
            statement.finallyBlock, receiver, runtimeClass, substitutions,
            updates, new Map(localValues), activeCalls, true, true, allowBreak, allowContinue,
          );
          if (!finallyCompletion) return undefined;
          const finallyReturn = completionPredicate(finallyCompletion, "return");
          const finallyThrow = completionPredicate(finallyCompletion, "throw");
          const finallyBreak = completionPredicate(finallyCompletion, "break");
          const finallyContinue = completionPredicate(finallyCompletion, "continue");
          const finallyNormal = notCompletionPredicate(orCompletionPredicates(
            orCompletionPredicates(
              orCompletionPredicates(finallyReturn, finallyThrow), finallyBreak,
            ),
            finallyContinue,
          ));
          residualCompletion = makeCompletion(
            orCompletionPredicates(finallyReturn, andCompletionPredicates(finallyNormal, priorReturn)),
            orCompletionPredicates(finallyThrow, andCompletionPredicates(finallyNormal, priorThrow)),
            sequenceThrowValue(finallyCompletion, residualCompletion),
            orCompletionPredicates(finallyBreak, andCompletionPredicates(finallyNormal, priorBreak)),
            orCompletionPredicates(finallyContinue, andCompletionPredicates(finallyNormal, priorContinue)),
          );
          if (residualCompletion === "normal") continue;
        }
        const priorReturn = completionPredicate(residualCompletion, "return");
        const priorThrow = completionPredicate(residualCompletion, "throw");
        const priorBreak = completionPredicate(residualCompletion, "break");
        const priorContinue = completionPredicate(residualCompletion, "continue");
        const priorAbrupt = orCompletionPredicates(
          orCompletionPredicates(orCompletionPredicates(priorReturn, priorThrow), priorBreak), priorContinue,
        );
        if (isBooleanCompletionPredicate(priorAbrupt, true)) return residualCompletion;
        const beforeContinuation = new Map(updates);
        const continuingUpdates = new Map(updates);
        const continued = collect(
          ts.factory.createBlock(body.statements.slice(statementIndex + 1), true), receiver, runtimeClass, substitutions,
          continuingUpdates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow,
          allowBreak, allowContinue,
        );
        if (!continued) return undefined;
        const normalWhen = notCompletionPredicate(priorAbrupt);
        mergeConditionalUpdates(priorAbrupt, beforeContinuation, continuingUpdates, beforeContinuation);
        return makeCompletion(
          orCompletionPredicates(priorReturn, andCompletionPredicates(normalWhen, completionPredicate(continued, "return"))),
          orCompletionPredicates(priorThrow, andCompletionPredicates(normalWhen, completionPredicate(continued, "throw"))),
          sequenceThrowValue(residualCompletion, continued),
          orCompletionPredicates(priorBreak, andCompletionPredicates(normalWhen, completionPredicate(continued, "break"))),
          orCompletionPredicates(priorContinue, andCompletionPredicates(normalWhen, completionPredicate(continued, "continue"))),
        );
      }
      if (ts.isIfStatement(statement)) {
        const normalizedCondition = normalizeRefinementExpression(statement.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
        if (!normalizedCondition) return undefined;
        const condition = expandLocalSnapshots(resolveCurrentState(normalizedCondition));
        const before = new Map(updates);
        const trueBlock = asBlock(statement.thenStatement);
        const falseBlock = asBlock(statement.elseStatement);
        const trueUpdates = new Map(before);
        const falseUpdates = new Map(before);
        let whenTrue = collect(trueBlock, receiver, runtimeClass, substitutions, trueUpdates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue);
        let whenFalse = collect(falseBlock, receiver, runtimeClass, substitutions, falseUpdates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow, allowBreak, allowContinue);
        if (!whenTrue || !whenFalse) return undefined;
        const hasAbruptBranch = whenTrue !== "normal" || whenFalse !== "normal";
        if (hasAbruptBranch) {
          const continuation = ts.factory.createBlock(body.statements.slice(statementIndex + 1), true);
          whenTrue = applyContinuation(whenTrue, trueUpdates, continuation);
          whenFalse = applyContinuation(whenFalse, falseUpdates, continuation);
          if (!whenTrue || !whenFalse) return undefined;
        }
        mergeConditionalUpdates(condition, trueUpdates, falseUpdates, before);
        if (hasAbruptBranch) {
          return makeCompletion(
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "return"), completionPredicate(whenFalse, "return")),
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "throw"), completionPredicate(whenFalse, "throw")),
            joinThrowValue(condition, whenTrue, whenFalse),
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "break"), completionPredicate(whenFalse, "break")),
            joinCompletionPredicate(condition, completionPredicate(whenTrue, "continue"), completionPredicate(whenFalse, "continue")),
          );
        }
        continue;
      }
      if (ts.isSwitchStatement(statement)) {
        const normalizedDiscriminant = normalizeRefinementExpression(
          statement.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
        );
        if (!normalizedDiscriminant) return undefined;
        const discriminant = expandLocalSnapshots(resolveCurrentState(normalizedDiscriminant));
        const clauses = [...statement.caseBlock.clauses];
        const caseMatches: TemporalExpression[] = [];
        const caseKeys = new Set<string>();
        for (const clause of clauses) {
          if (!ts.isCaseClause(clause)) continue;
          const label = normalizeRefinementExpression(
            clause.expression, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues,
          );
          if (!label || label.kind !== "integer" && label.kind !== "boolean") return undefined;
          const key = refinementExpressionKey(label);
          if (caseKeys.has(key)) return undefined;
          caseKeys.add(key);
          caseMatches.push({ kind: "binary", operator: "eq", left: discriminant, right: label });
        }
        if (clauses.filter(ts.isDefaultClause).length > 1) return undefined;
        const before = new Map(updates);
        const branches: Array<{
          condition: TemporalExpression;
          updates: Map<string, TemporalExpression>;
          completion: ActionCompletion;
        }> = [];
        let defaultUpdates: Map<string, TemporalExpression> | undefined;
        let defaultCompletion: ActionCompletion = "normal";
        let caseIndex = 0;
        for (let entry = 0; entry < clauses.length; entry++) {
          const clause = clauses[entry]!;
          const condition = ts.isCaseClause(clause) ? caseMatches[caseIndex++]! : undefined;
          const pathStatements: ts.Statement[] = [];
          let stopped = false;
          for (let clauseIndex = entry; clauseIndex < clauses.length && !stopped; clauseIndex++) {
            const statements = [...clauses[clauseIndex]!.statements];
            const abruptIndex = statements.findIndex((candidate) => ts.isBreakStatement(candidate)
              || ts.isReturnStatement(candidate) || ts.isThrowStatement(candidate));
            if (abruptIndex >= 0) {
              const abrupt = statements[abruptIndex]!;
              if (abruptIndex !== statements.length - 1) return undefined;
              if (ts.isBreakStatement(abrupt)) {
                if (abrupt.label) return undefined;
                pathStatements.push(...statements.slice(0, abruptIndex));
              } else pathStatements.push(...statements);
              stopped = true;
            } else pathStatements.push(...statements);
          }
          const branchUpdates = new Map(before);
          const branch = collect(
            ts.factory.createBlock(pathStatements, true), receiver, runtimeClass, substitutions,
            branchUpdates, new Map(localValues), activeCalls, allowTerminalReturn, allowTerminalThrow,
          );
          if (!branch) return undefined;
          if (condition) branches.push({ condition, updates: branchUpdates, completion: branch });
          else {
            defaultUpdates = branchUpdates;
            defaultCompletion = branch;
          }
        }
        updates.clear();
        for (const name of stateNames) {
          const original = before.get(name) ?? { kind: "name", name } as TemporalExpression;
          let merged = defaultUpdates?.get(name) ?? original;
          for (let index = branches.length - 1; index >= 0; index--) {
            const branch = branches[index]!;
            const value = branch.updates.get(name) ?? original;
            if (!sameRefinementExpression(value, merged)) merged = {
              kind: "conditional", condition: branch.condition, whenTrue: value, whenFalse: merged,
            };
          }
          if (!sameRefinementExpression(merged, { kind: "name", name })) updates.set(name, merged);
        }
        let caseMatched: TemporalExpression = { kind: "boolean", value: false };
        for (const branch of branches) caseMatched = orCompletionPredicates(caseMatched, branch.condition);
        const defaultSelected = notCompletionPredicate(caseMatched);
        let returnWhen = andCompletionPredicates(
          defaultSelected, completionPredicate(defaultCompletion, "return"),
        );
        let throwWhen = andCompletionPredicates(
          defaultSelected, completionPredicate(defaultCompletion, "throw"),
        );
        for (const branch of branches) {
          returnWhen = orCompletionPredicates(returnWhen, andCompletionPredicates(
            branch.condition, completionPredicate(branch.completion, "return"),
          ));
          throwWhen = orCompletionPredicates(throwWhen, andCompletionPredicates(
            branch.condition, completionPredicate(branch.completion, "throw"),
          ));
        }
        if (isBooleanCompletionPredicate(completionPredicate(defaultCompletion, "return"), true)
          && branches.every((branch) => isBooleanCompletionPredicate(completionPredicate(branch.completion, "return"), true))) {
          returnWhen = { kind: "boolean", value: true };
        }
        if (isBooleanCompletionPredicate(completionPredicate(defaultCompletion, "throw"), true)
          && branches.every((branch) => isBooleanCompletionPredicate(completionPredicate(branch.completion, "throw"), true))) {
          throwWhen = { kind: "boolean", value: true };
        }
        let selectedCompletion = defaultCompletion;
        for (let index = branches.length - 1; index >= 0; index--) {
          const branch = branches[index]!;
          selectedCompletion = makeCompletion(
            joinCompletionPredicate(
              branch.condition,
              completionPredicate(branch.completion, "return"),
              completionPredicate(selectedCompletion, "return"),
            ),
            joinCompletionPredicate(
              branch.condition,
              completionPredicate(branch.completion, "throw"),
              completionPredicate(selectedCompletion, "throw"),
            ),
            joinThrowValue(branch.condition, branch.completion, selectedCompletion),
          );
        }
        const switchCompletion = makeCompletion(
          returnWhen,
          throwWhen,
          completionThrowValue(selectedCompletion),
        );
        if (switchCompletion !== "normal") {
          return applyContinuation(
            switchCompletion, updates, ts.factory.createBlock(body.statements.slice(statementIndex + 1), true),
          );
        }
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer
            || localValues.has(declaration.name.text) || substitutions.has(declaration.name.text)) return undefined;
          const resolveReceiverAlias = (expression: ts.Expression, seen: ReadonlySet<string> = new Set()): ts.Expression | undefined => {
            const candidate = unwrap(expression);
            if (candidate.kind === ts.SyntaxKind.ThisKeyword) return receiver === "this" ? candidate : undefined;
            if (!ts.isIdentifier(candidate)) return undefined;
            if (candidate.text === receiver) return candidate;
            if (seen.has(candidate.text)) return undefined;
            const replacement = substitutions.get(candidate.text);
            return replacement ? resolveReceiverAlias(replacement, new Set([...seen, candidate.text])) : undefined;
          };
          const receiverAlias = resolveReceiverAlias(declaration.initializer);
          if (receiverAlias) {
            substitutions.set(declaration.name.text, receiverAlias);
            continue;
          }
          const value = normalizeRefinementExpression(declaration.initializer, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!value) return undefined;
          localValues.set(declaration.name.text, expandLocalSnapshots(resolveCurrentState(value)));
        }
        continue;
      }
      if (!ts.isExpressionStatement(statement) && !terminalReturn) return undefined;
      const node = ts.isReturnStatement(statement) ? statement.expression! : statement.expression;
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression)
        || checker !== undefined && ts.isPropertyAccessExpression(node.expression) && resolveFunction(node.expression) !== undefined)) {
        const helperName = node.expression.getText();
        const helper = resolveFunction(node.expression);
        const callKey = helper ? `function:${helper.getSourceFile().fileName}:${helper.pos}` : `function:${helperName}`;
        if (!helper?.body || activeCalls.has(callKey) || helper.parameters.length !== node.arguments.length
          || helper.parameters.length === 0 || helper.parameters.some((parameter) => !ts.isIdentifier(parameter.name))) return undefined;
        const receiverArgument = node.arguments[0]!;
        const substitutedReceiver = ts.isIdentifier(receiverArgument) ? substitutions.get(receiverArgument.text) : undefined;
        const receiverMatches = receiverArgument.kind === ts.SyntaxKind.ThisKeyword
          || ts.isIdentifier(receiverArgument) && (receiverArgument.text === receiver
            || (substitutedReceiver !== undefined && ts.isIdentifier(substitutedReceiver) && substitutedReceiver.text === receiver));
        if (!receiverMatches) return undefined;
        const helperLocals = new Map<string, TemporalExpression>();
        for (let index = 1; index < helper.parameters.length; index++) {
          const argument = normalizeRefinementExpression(node.arguments[index]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!argument) return undefined;
          helperLocals.set((helper.parameters[index]!.name as ts.Identifier).text, expandLocalSnapshots(resolveCurrentState(argument)));
        }
        const helperReceiver = (helper.parameters[0]!.name as ts.Identifier).text;
        if (!collect(helper.body, helperReceiver, undefined, new Map(), updates, helperLocals, new Set([...activeCalls, callKey]), true)) return undefined;
        if (terminalReturn) return "return";
        continue;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const [target, ...fields] = actionFieldPath(node.expression.expression, receiver, substitutions) ?? [];
        let targetType = target ? stateTypes.get(target) : undefined;
        for (const field of fields) {
          if (!targetType || typeof targetType === "string" || targetType.kind !== "record") { targetType = undefined; break; }
          targetType = targetType.fields[field];
        }
        const relation = target ? abstraction.get(target) : undefined;
        if (target && stateNames.has(target) && targetType && relation
          && parseAbstractionValue(relation).kind === "set-from-array"
          && typeof targetType !== "string" && targetType.kind === "set"
          && fields.length === 0 && node.expression.name.text === "push" && node.arguments.length === 1
          && isBuiltinArrayReceiver(node.expression.expression)) {
          const element = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!element) return undefined;
          writePath(target, [], {
            kind: "method", receiver: readPath(target, []), name: "union",
            arguments: [{ kind: "call", name: "Set", arguments: [expandLocalSnapshots(resolveCurrentState(element))] }],
          });
          continue;
        }
        if (target && stateNames.has(target) && targetType && relation
          && parseAbstractionValue(relation).kind === "map-from-entries"
          && typeof targetType !== "string" && targetType.kind === "map"
          && fields.length === 0 && node.expression.name.text === "push" && node.arguments.length === 1
          && isBuiltinArrayReceiver(node.expression.expression)
          && ts.isArrayLiteralExpression(node.arguments[0]!) && node.arguments[0]!.elements.length === 2) {
          const key = normalizeRefinementExpression(node.arguments[0]!.elements[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          const value = normalizeRefinementExpression(node.arguments[0]!.elements[1]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!key || !value) return undefined;
          const resolvedKey = expandLocalSnapshots(resolveCurrentState(key));
          const current = readPath(target, []);
          const putReceiver = current.kind === "method" && current.name === "remove" && current.arguments.length === 1
            && sameRefinementExpression(current.arguments[0]!, resolvedKey) ? current.receiver : current;
          writePath(target, [], {
            kind: "method", receiver: putReceiver, name: "put",
            arguments: [resolvedKey, expandLocalSnapshots(resolveCurrentState(value))],
          });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "clear" && node.arguments.length === 0
          && typeof targetType !== "string" && (targetType.kind === "set" || targetType.kind === "map")
          && isBuiltinCollectionReceiver(node.expression.expression, targetType.kind)) {
          writePath(target, fields, targetType.kind === "set"
            ? { kind: "call", name: "Set", arguments: [] }
            : { kind: "call", name: "Map", arguments: [{ kind: "array", elements: [] }] });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "delete" && node.arguments.length === 1
          && typeof targetType !== "string" && (targetType.kind === "set" || targetType.kind === "map")
          && isBuiltinCollectionReceiver(node.expression.expression, targetType.kind)) {
          const item = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!item) return undefined;
          const argument = expandLocalSnapshots(resolveCurrentState(item));
          writePath(target, fields, targetType.kind === "set"
            ? { kind: "method", receiver: readPath(target, fields), name: "exclude", arguments: [{ kind: "call", name: "Set", arguments: [argument] }] }
            : { kind: "method", receiver: readPath(target, fields), name: "remove", arguments: [argument] });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "add"
          && typeof targetType !== "string" && targetType.kind === "set" && node.arguments.length === 1
          && isBuiltinCollectionReceiver(node.expression.expression, "set")) {
          const element = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!element) return undefined;
          writePath(target, fields, {
            kind: "method", receiver: readPath(target, fields), name: "union",
            arguments: [{ kind: "call", name: "Set", arguments: [expandLocalSnapshots(resolveCurrentState(element))] }],
          });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "set"
          && typeof targetType !== "string" && targetType.kind === "map" && node.arguments.length === 2
          && isBuiltinCollectionReceiver(node.expression.expression, "map")) {
          const key = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          const value = normalizeRefinementExpression(node.arguments[1]!, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
          if (!key || !value) return undefined;
          writePath(target, fields, {
            kind: "method", receiver: readPath(target, fields), name: "put",
            arguments: [expandLocalSnapshots(resolveCurrentState(key)), expandLocalSnapshots(resolveCurrentState(value))],
          });
          continue;
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && isRuntimeReceiverExpression(node.expression.expression) && runtimeClass) {
        const methodName = node.expression.name.text;
        const method = runtimeClass.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName);
        if (!method?.body || method.parameters.length !== node.arguments.length) return undefined;
        const nestedSubstitutions = new Map<string, ts.Expression>();
        method.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name)) nestedSubstitutions.set(parameter.name.text, node.arguments[index]!);
        });
        const callKey = `method:${runtimeClass.name?.text ?? "<anonymous>"}.${methodName}`;
        if (activeCalls.has(callKey) || !collect(method.body, "this", runtimeClass, nestedSubstitutions, updates, new Map(localValues), new Set([...activeCalls, callKey]), true)) return undefined;
        if (terminalReturn) return "return";
        continue;
      }
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
        if (node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken) return undefined;
        const [target, ...fields] = actionFieldPath(node.operand, receiver, substitutions) ?? [];
        if (!target || !stateNames.has(target)) return undefined;
        writePath(target, fields, { kind: "binary", operator: node.operator === ts.SyntaxKind.PlusPlusToken ? "add" : "subtract", left: readPath(target, fields), right: { kind: "integer", value: "1" } });
        continue;
      }
      if (ts.isBinaryExpression(node)) {
        const rawLeftPath = refinementFieldPath(node.left, receiver, substitutions)?.join(".");
        const computedArrayRelation = rawLeftPath
          ? [...abstraction].find(([, value]) => {
              const parsed = parseAbstractionValue(value);
              return parsed.kind === "set-from-array" && (rawLeftPath === parsed.path || rawLeftPath === `${parsed.path}.length`)
                || parsed.kind === "map-from-entries" && (rawLeftPath === parsed.path || rawLeftPath === `${parsed.path}.length`);
            })
          : undefined;
        if (computedArrayRelation) {
          const [abstract, relation] = computedArrayRelation;
          const parsedRelation = parseAbstractionValue(relation);
          const concretePath = parsedRelation.path;
          if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
          if (rawLeftPath === `${concretePath}.length`) {
            if (!ts.isNumericLiteral(node.right) || node.right.text !== "0") return undefined;
            writePath(abstract, [], parsedRelation.kind === "set-from-array"
              ? { kind: "call", name: "Set", arguments: [] }
              : { kind: "call", name: "Map", arguments: [{ kind: "array", elements: [] }] });
            continue;
          }
          if (!checker || !ts.isCallExpression(node.right) || !ts.isPropertyAccessExpression(node.right.expression)
            || node.right.expression.name.text !== "filter" || node.right.arguments.length !== 1
            || !isDeclarationFileSymbol(checker, node.right.expression.name, "filter")
            || !isBuiltinArrayReceiver(node.right.expression.expression)
            || refinementFieldPath(node.right.expression.expression, receiver, substitutions)?.join(".") !== concretePath) return undefined;
          const callback = node.right.arguments[0];
          if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length !== 1
            || !ts.isIdentifier(callback.parameters[0]!.name)) return undefined;
          const callbackExpression = ts.isBlock(callback.body)
            ? callback.body.statements.length === 1 && ts.isReturnStatement(callback.body.statements[0]!)
              && callback.body.statements[0]!.expression ? unwrap(callback.body.statements[0]!.expression!) : undefined
            : unwrap(callback.body);
          if (!callbackExpression || !ts.isBinaryExpression(callbackExpression)
            || callbackExpression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return undefined;
          const parameter = callback.parameters[0]!.name.text;
          const matchesElement = (expression: ts.Expression): boolean => parsedRelation.kind === "set-from-array"
            ? ts.isIdentifier(expression) && expression.text === parameter
            : ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)
              && expression.expression.text === parameter && !!expression.argumentExpression
              && ts.isNumericLiteral(expression.argumentExpression) && expression.argumentExpression.text === "0";
          const leftMatches = matchesElement(callbackExpression.left);
          const rightMatches = matchesElement(callbackExpression.right);
          if (leftMatches === rightMatches) return undefined;
          const excludedNode = leftMatches ? callbackExpression.right : callbackExpression.left;
          const excluded = normalizeRefinementExpression(excludedNode, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues, checker);
          if (!excluded) return undefined;
          const argument = expandLocalSnapshots(resolveCurrentState(excluded));
          writePath(abstract, [], parsedRelation.kind === "set-from-array" ? {
            kind: "method", receiver: readPath(abstract, []), name: "exclude",
            arguments: [{ kind: "call", name: "Set", arguments: [argument] }],
          } : { kind: "method", receiver: readPath(abstract, []), name: "remove", arguments: [argument] });
          continue;
        }
        const [target, ...fields] = actionFieldPath(node.left, receiver, substitutions) ?? [];
        if (!target || !stateNames.has(target)) return undefined;
        const right = normalizeRefinementExpression(node.right, receiver, substitutions, expressionStateNames, new Map(), new Set(), localValues);
        if (!right) return undefined;
        const resolvedRight = expandLocalSnapshots(resolveCurrentState(right));
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) writePath(target, fields, resolvedRight);
        else if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) {
          writePath(target, fields, { kind: "binary", operator: node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? "add" : "subtract", left: readPath(target, fields), right: resolvedRight });
        } else return undefined;
        continue;
      }
      return undefined;
    }
    return "normal";
  };

  for (const action of spec.actions) {
    const exportName = manifest.actions[action.name];
    if (!exportName) {
      diagnostics.push({ code: "missing-action-binding", adapterName, modelName: action.name, message: `action ${action.name} has no ${adapterName} refinement binding to verify` });
      continue;
    }
    const implementation = functions.get(exportName);
    const runtimeParameter = implementation?.parameters[0];
    const receiver = runtimeParameter && ts.isIdentifier(runtimeParameter.name) ? runtimeParameter.name.text : undefined;
    const guardedBody = implementation?.body && receiver ? earlyReturnGuard(implementation.body, receiver) : undefined;
    const actualGuard = guardedBody?.guard;
    if (action.guard && !actualGuard) {
      diagnostics.push({ code: "missing-action-guard", adapterName, modelName: action.name, exportName, expected: formatRefinementExpression(action.guard.expressionAst), actual: "<missing>", message: `${exportName} does not enforce model action guard ${action.guard.expression}` });
    } else if (!action.guard && actualGuard) {
      diagnostics.push({ code: "unexpected-action-guard", adapterName, modelName: action.name, exportName, expected: "<none>", actual: formatRefinementExpression(actualGuard), message: `${exportName} enforces an early-return guard absent from model action ${action.name}` });
    } else if (action.guard && actualGuard && !sameRefinementExpression(action.guard.expressionAst, actualGuard)) {
      diagnostics.push({ code: "action-guard-mismatch", adapterName, modelName: action.name, exportName, expected: formatRefinementExpression(action.guard.expressionAst), actual: formatRefinementExpression(actualGuard), message: `${exportName} enforces ${formatRefinementExpression(actualGuard)}, expected ${action.guard.expression}` });
    }
    const updates = new Map<string, TemporalExpression>();
    const completion = guardedBody && receiver ? collect(guardedBody.updates, receiver, resolveRuntimeClass(runtimeParameter), new Map(), updates) : undefined;
    if (!completion) {
      diagnostics.push({ code: "unsupported-action-body", adapterName, modelName: action.name, exportName, message: `${exportName} uses an action body outside the supported scalar refinement fragment` });
      continue;
    }
    const expected = new Map(action.assignments.map(({ target, expressionAst }) => [target, expressionAst]));
    for (const state of spec.states) {
      const expectedExpression = expected.get(state.name) ?? { kind: "name", name: state.name } as const;
      const actualExpression = updates.get(state.name) ?? { kind: "name", name: state.name } as const;
      if (sameRefinementExpression(expectedExpression, actualExpression)) continue;
      const diagnostic: RefinementActionDiagnostic = {
        code: "action-update-mismatch", adapterName, modelName: action.name, exportName, target: state.name,
        expected: formatRefinementExpression(expectedExpression), actual: formatRefinementExpression(actualExpression),
        message: `${exportName} updates ${state.name} as ${formatRefinementExpression(actualExpression)}, expected ${formatRefinementExpression(expectedExpression)}`,
      };
      refinementMismatchExpressions.set(diagnostic, { expected: expectedExpression, actual: actualExpression });
      diagnostics.push(diagnostic);
    }
  }
  const modelActions = new Set(spec.actions.map(({ name }) => name));
  for (const [modelName, exportName] of Object.entries(manifest.actions)) {
    if (modelActions.has(modelName)) continue;
    diagnostics.push({ code: "unknown-action-binding", adapterName, modelName, exportName, message: `action refinement ${exportName} refers to unknown model action ${modelName}` });
  }
  return diagnostics;
}

/** Proves a deliberately small, zero-runtime scalar update fragment against model actions. */
export function validateRefinementActionBodies(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementActionDiagnostic[] {
  return validateRefinementActionBodiesInSource(
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), text, adapterName, spec,
  );
}

/** Uses TypeScript symbol identity to reject collection-like subclasses and user-defined lookalikes. */
export function validateRefinementActionBodiesInProgram(
  program: ts.Program,
  fileName: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementActionDiagnostic[] {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript program does not contain refinement source ${fileName}`);
  return validateRefinementActionBodiesInSource(source, source.text, adapterName, spec, program.getTypeChecker(), program);
}

function collectProgramHelperFunctions(source: ts.SourceFile, checker: ts.TypeChecker): Map<string, ts.FunctionDeclaration> {
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const ambiguous = new Set<string>();
  const scanned = new Set<ts.FunctionDeclaration>();
  const scan = (root: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression))) {
        const helper = resolveProgramFunction(checker, node.expression);
        if (helper) {
          const name = ts.isIdentifier(node.expression) ? node.expression.text : node.expression.getText();
          const existing = functions.get(name);
          if (existing && existing !== helper) { functions.delete(name); ambiguous.add(name); }
          else if (!ambiguous.has(name)) functions.set(name, helper);
          if (!scanned.has(helper)) { scanned.add(helper); if (helper.body) scan(helper.body); }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  scan(source);
  return functions;
}

function validateRefinementInvariantBodiesInSource(
  source: ts.SourceFile,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  checker?: ts.TypeChecker,
): RefinementInvariantDiagnostic[] {
  const fileName = source.fileName;
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = checker
    ? collectProgramHelperFunctions(source, checker)
    : new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const abstraction = parseAbstractionRelations(text, adapterName, manifest.version, stateNames);
  const concreteToAbstract = new Map([...abstraction].map(([abstract, value]) => [parseAbstractionValue(value).path, abstract]));
  const expressionStateNames = new Set([...stateNames, ...[...concreteToAbstract.keys()].map((path) => path.split(".")[0]!).filter(Boolean)]);
  const canonicalize = (expression: TemporalExpression): TemporalExpression => canonicalizeAbstractionExpression(expression, abstraction);
  const diagnostics: RefinementInvariantDiagnostic[] = [];
  for (const property of spec.properties) {
    const exportName = manifest.invariants[property.name];
    if (!exportName) {
      diagnostics.push({ code: "missing-invariant-binding", adapterName, modelName: property.name, message: `invariant ${property.name} has no ${adapterName} refinement binding to verify` });
      continue;
    }
    const implementation = functions.get(exportName);
    const runtimeParameter = implementation?.parameters[0];
    const receiver = runtimeParameter && ts.isIdentifier(runtimeParameter.name) ? runtimeParameter.name.text : undefined;
    const statements = implementation?.body ? [...implementation.body.statements] : [];
    const returned = statements.pop();
    const substitutions = new Map<string, ts.Expression>();
    let supportedLocals = true;
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        supportedLocals = false;
        break;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer
          || !normalizeRefinementExpression(declaration.initializer, receiver ?? "", substitutions, expressionStateNames, functions, new Set(), new Map(), checker)) {
          supportedLocals = false;
          break;
        }
        substitutions.set(declaration.name.text, declaration.initializer);
      }
      if (!supportedLocals) break;
    }
    const normalized = receiver && supportedLocals && returned && ts.isReturnStatement(returned) && returned.expression
      ? normalizeRefinementExpression(returned.expression, receiver, substitutions, expressionStateNames, functions, new Set(), new Map(), checker)
      : undefined;
    const actual = normalized ? canonicalize(normalized) : undefined;
    if (!actual) {
      diagnostics.push({ code: "unsupported-invariant-body", adapterName, modelName: property.name, exportName, message: `${exportName} is not a single supported scalar return predicate` });
      continue;
    }
    if (sameRefinementExpression(property.expressionAst, actual)) continue;
    const diagnostic: RefinementInvariantDiagnostic = {
      code: "invariant-expression-mismatch", adapterName, modelName: property.name, exportName,
      expected: formatRefinementExpression(property.expressionAst), actual: formatRefinementExpression(actual),
      message: `${exportName} returns ${formatRefinementExpression(actual)}, expected ${formatRefinementExpression(property.expressionAst)}`,
    };
    refinementMismatchExpressions.set(diagnostic, { expected: property.expressionAst, actual });
    diagnostics.push(diagnostic);
  }
  const modelProperties = new Set(spec.properties.map(({ name }) => name));
  for (const [modelName, exportName] of Object.entries(manifest.invariants)) {
    if (modelProperties.has(modelName)) continue;
    diagnostics.push({ code: "unknown-invariant-binding", adapterName, modelName, exportName, message: `invariant refinement ${exportName} refers to unknown temporal property ${modelName}` });
  }
  return diagnostics;
}

/** Proves a single-return, side-effect-free scalar predicate against temporal safety properties. */
export function validateRefinementInvariantBodies(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementInvariantDiagnostic[] {
  return validateRefinementInvariantBodiesInSource(
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), text, adapterName, spec,
  );
}

/** Resolves imported pure invariant helpers through a TypeScript Program. */
export function validateRefinementInvariantBodiesInProgram(
  program: ts.Program,
  fileName: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementInvariantDiagnostic[] {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript program does not contain refinement source ${fileName}`);
  return validateRefinementInvariantBodiesInSource(source, source.text, adapterName, spec, program.getTypeChecker());
}

async function dischargeExpressionMismatchesWithZ3<T extends { code: string; expected?: string; actual?: string }>(
  diagnostics: readonly T[],
  mismatchCode: string,
  spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<T>>> {
  const discharged: Array<Z3RefinementDiagnostic<T>> = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== mismatchCode || !diagnostic.expected || !diagnostic.actual) {
      discharged.push(diagnostic);
      continue;
    }
    const expressions = refinementMismatchExpressions.get(diagnostic);
    const result = await checkTemporalExpressionEquivalenceWithZ3(spec,
      expressions?.expected ?? parseTemporalExpression(diagnostic.expected),
      expressions?.actual ?? parseTemporalExpression(diagnostic.actual));
    if (result.status === "equivalent") continue;
    discharged.push({
      ...diagnostic,
      backend: "z3",
      equivalence: result.status,
      ...(result.status === "unknown" ? { reason: result.reason } : {}),
    });
  }
  return discharged;
}

/** Keeps exact action expressions on the fast path, then proves scalar guard and update mismatches with Z3. */
export async function validateRefinementActionBodiesWithZ3(
  fileName: string, text: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementActionDiagnostic>>> {
  const guards = await dischargeExpressionMismatchesWithZ3(
    validateRefinementActionBodies(fileName, text, adapterName, spec), "action-guard-mismatch", spec,
  );
  return dischargeExpressionMismatchesWithZ3(guards, "action-update-mismatch", spec);
}

/** Combines TypeChecker-backed builtin identity checks with Z3 guard and scalar-update equivalence. */
export async function validateRefinementActionBodiesInProgramWithZ3(
  program: ts.Program, fileName: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementActionDiagnostic>>> {
  const guards = await dischargeExpressionMismatchesWithZ3(
    validateRefinementActionBodiesInProgram(program, fileName, adapterName, spec), "action-guard-mismatch", spec,
  );
  return dischargeExpressionMismatchesWithZ3(guards, "action-update-mismatch", spec);
}

/** Proves normalized single-return invariant predicates by logical rather than syntactic equivalence. */
export async function validateRefinementInvariantBodiesWithZ3(
  fileName: string, text: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementInvariantDiagnostic>>> {
  return dischargeExpressionMismatchesWithZ3(validateRefinementInvariantBodies(fileName, text, adapterName, spec), "invariant-expression-mismatch", spec);
}

/** Combines Program-resolved invariant helpers with Z3 predicate equivalence. */
export async function validateRefinementInvariantBodiesInProgramWithZ3(
  program: ts.Program, fileName: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementInvariantDiagnostic>>> {
  return dischargeExpressionMismatchesWithZ3(
    validateRefinementInvariantBodiesInProgram(program, fileName, adapterName, spec), "invariant-expression-mismatch", spec,
  );
}

function typescriptTemporalShapeMismatch(
  checker: ts.TypeChecker,
  actual: ts.Type,
  expected: TemporalValueType,
  location: ts.Node,
  path: readonly string[] = [],
): readonly string[] | undefined {
  if ((actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return path;
  if (typeof expected === "string") {
    const flag = expected === "int" ? ts.TypeFlags.Number : ts.TypeFlags.Boolean;
    if ((actual.flags & flag) !== 0) return undefined;
    if (actual.isIntersection() && actual.types.some((part) => (part.flags & flag) !== 0)) return undefined;
    return path;
  }
  if (expected.kind === "set" || expected.kind === "map") {
    const expectedName = expected.kind === "set" ? "Set" : "Map";
    const resolveBuiltin = (type: ts.Type, seen: ReadonlySet<ts.Type> = new Set()): readonly ts.Type[] | undefined => {
      if (seen.has(type)) return undefined;
      const symbol = type.getSymbol() ?? type.aliasSymbol;
      if (symbol?.getName() === expectedName
        && (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile)) {
        return (type.flags & ts.TypeFlags.Object) !== 0
          ? checker.getTypeArguments(type as ts.TypeReference)
          : [];
      }
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint && constraint !== type ? resolveBuiltin(constraint, new Set([...seen, type])) : undefined;
    };
    const arguments_ = resolveBuiltin(actual);
    if (!arguments_) return path;
    if (expected.kind === "set") {
      if (expected.element === "never") return undefined;
      const element = arguments_[0];
      return element ? typescriptTemporalShapeMismatch(checker, element, expected.element, location, [...path, "<element>"]) : path;
    }
    const [key, value] = arguments_;
    const keyMismatch = expected.key === "never" || !key ? undefined : typescriptTemporalShapeMismatch(checker, key, expected.key, location, [...path, "<key>"]);
    if (keyMismatch) return keyMismatch;
    if (expected.value === "never") return undefined;
    return value ? typescriptTemporalShapeMismatch(checker, value, expected.value, location, [...path, "<value>"]) : path;
  }
  if ((actual.flags & ts.TypeFlags.Object) === 0 && !actual.isIntersection()) return path;
  for (const [name, fieldType] of Object.entries(expected.fields)) {
    const property = actual.getProperty(name);
    if (!property) return [...path, name];
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
    const mismatch = typescriptTemporalShapeMismatch(checker, checker.getTypeOfSymbolAtLocation(property, declaration), fieldType, declaration, [...path, name]);
    if (mismatch) return mismatch;
  }
  return undefined;
}

function validateRefinementStateProjectionInSource(
  source: ts.SourceFile,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
  checker?: ts.TypeChecker,
): RefinementStateProjectionDiagnostic[] {
  const fileName = source.fileName;
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = checker
    ? collectProgramHelperFunctions(source, checker)
    : new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const classes = new Map(source.statements.filter(ts.isClassDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const stateTypes = new Map(spec.states.map(({ name, type }) => [name, type]));
  const abstraction = parseAbstractionRelations(text, adapterName, manifest.version, stateNames);
  const concreteToAbstract = new Map([...abstraction].map(([abstract, value]) => [parseAbstractionValue(value).path, abstract]));
  const identity = () => new Map(spec.states.map(({ name }) => [name, { kind: "name", name } as TemporalExpression]));

  const extract = (
    implementation: ts.FunctionDeclaration,
    role: "create" | "observe",
    activeHelpers: ReadonlySet<string> = new Set(),
  ): Map<string, TemporalExpression> | undefined => {
    const implementationName = implementation.name?.text;
    if (!implementationName || activeHelpers.has(implementationName)) return undefined;
    const nextActiveHelpers = new Set([...activeHelpers, implementationName]);
    const parameter = implementation.parameters[0];
    const receiver = parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
    if (!receiver || !implementation.body || implementation.body.statements.length === 0) return undefined;
    const aliases = new Map<string, string>();
    const statements = [...implementation.body.statements];
    const returned = statements.pop();
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
    for (const statement of statements) {
      if (role !== "observe" || !ts.isVariableStatement(statement)
        || (statement.declarationList.flags & ts.NodeFlags.Const) === 0 || statement.declarationList.declarations.length !== 1) return undefined;
      const declaration = statement.declarationList.declarations[0];
      if (!declaration?.initializer || !ts.isIdentifier(declaration.initializer) || declaration.initializer.text !== receiver || !ts.isObjectBindingPattern(declaration.name)) return undefined;
      for (const element of declaration.name.elements) {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) return undefined;
        const field = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
        if (!stateNames.has(field)) return undefined;
        aliases.set(element.name.text, field);
      }
    }
    const accessPath = (node: ts.Expression): string[] | undefined => {
      if (ts.isIdentifier(node)) {
        if (node.text === receiver) return [];
        const alias = aliases.get(node.text);
        return alias ? [alias] : undefined;
      }
      if (!ts.isPropertyAccessExpression(node)) return undefined;
      const base = accessPath(node.expression);
      if (!base) return undefined;
      const combined = [...base, node.name.text];
      if (role === "observe") for (const [abstract, value] of abstraction) {
        const parsed = parseAbstractionValue(value);
        if (parsed.kind !== "identity") continue;
        const concretePath = parsed.path.split(".");
        if (combined.length >= concretePath.length && concretePath.every((part, index) => combined[index] === part)) {
          return [abstract, ...combined.slice(concretePath.length)];
        }
      }
      return combined;
    };
    const pathExpression = (path: readonly string[]): TemporalExpression | undefined => {
      const [root, ...fields] = path;
      if (!root || !stateNames.has(root)) return undefined;
      return fields.reduce<TemporalExpression>((value, name) => ({ kind: "field", receiver: value, name }), { kind: "name", name: root });
    };
    const normalizeProjectionExpression = (node: ts.Expression): TemporalExpression | undefined => {
      if (role === "observe" && checker && ts.isNewExpression(node)
        && ts.isIdentifier(node.expression) && (node.expression.text === "Set" || node.expression.text === "Map")
        && node.arguments?.length === 1 && isDeclarationFileSymbol(checker, node.expression, node.expression.text)) {
        const concrete = refinementFieldPath(node.arguments[0]!, receiver, new Map())?.join(".");
        for (const [abstract, value] of abstraction) {
          const parsed = parseAbstractionValue(value);
          const expected = parsed.kind === "set-from-array" ? "Set" : parsed.kind === "map-from-entries" ? "Map" : undefined;
          if (expected === node.expression.text && parsed.path === concrete) return { kind: "name", name: abstract };
        }
      }
      const path = accessPath(node);
      if (path) return pathExpression(path);
      if (!ts.isObjectLiteralExpression(node)) {
        const roots = [...concreteToAbstract.keys()].map((value) => value.split(".")[0]!).filter(Boolean);
        const normalized = normalizeRefinementExpression(node, receiver, new Map(), new Set([...stateNames, ...roots]));
        return normalized ? canonicalizeAbstractionExpression(normalized, abstraction) : undefined;
      }
      const fields: Record<string, TemporalExpression> = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) return undefined;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
        const value = normalizeProjectionExpression(property.initializer);
        if (!name || !value || Object.hasOwn(fields, name)) return undefined;
        fields[name] = value;
      }
      return { kind: "record", fields };
    };
    const expandedIdentity = (type: TemporalValueType, path: readonly string[]): TemporalExpression | undefined => {
      if (typeof type === "string" || type.kind !== "record") return pathExpression(path);
      const fields: Record<string, TemporalExpression> = {};
      for (const [name, fieldType] of Object.entries(type.fields)) {
        const value = expandedIdentity(fieldType, [...path, name]);
        if (!value) return undefined;
        fields[name] = value;
      }
      return { kind: "record", fields };
    };
    const expression = returned.expression;
    if (ts.isIdentifier(expression) && expression.text === receiver) return identity();
    if (ts.isCallExpression(expression)
      && (ts.isIdentifier(expression.expression) || ts.isPropertyAccessExpression(expression.expression))
      && expression.arguments.length === 1 && ts.isIdentifier(expression.arguments[0]!)
      && expression.arguments[0]!.text === receiver) {
      const helperName = ts.isIdentifier(expression.expression) ? expression.expression.text : expression.expression.getText();
      const helper = functions.get(helperName);
      if (!helper?.body || helper.parameters.length !== 1 || !ts.isIdentifier(helper.parameters[0]!.name)) return undefined;
      return extract(helper, role, nextActiveHelpers);
    }
    if (role === "create" && ts.isCallExpression(expression)
      && ts.isPropertyAccessExpression(expression.expression)
      && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "Object"
      && expression.expression.name.text === "assign" && expression.arguments.length === 2
      && ts.isNewExpression(expression.arguments[0]!) && ts.isIdentifier(expression.arguments[0]!.expression)
      && ts.isIdentifier(expression.arguments[1]!) && expression.arguments[1]!.text === receiver) {
      const runtimeClass = classes.get(expression.arguments[0]!.expression.text);
      const transparentConstruction = runtimeClass && !runtimeClass.heritageClauses?.length
        && runtimeClass.members.every((member) => !ts.isConstructorDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member));
      if (!transparentConstruction) return undefined;
      return identity();
    }
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const projection = new Map<string, TemporalExpression>();
    if (role === "create" && abstraction.size > 0) {
      const initializerAt = (object: ts.ObjectLiteralExpression, path: readonly string[]): ts.Expression | undefined => {
        const [head, ...tail] = path;
        const property = head && object.properties.find((candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate)
          && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name))
          && candidate.name.text === head);
        if (!property) return undefined;
        if (tail.length === 0) return property.initializer;
        return ts.isObjectLiteralExpression(property.initializer) ? initializerAt(property.initializer, tail) : undefined;
      };
      for (const { name, type } of spec.states) {
        const relation = abstraction.get(name);
        const parsed = relation ? parseAbstractionValue(relation) : { kind: "identity" as const, path: name };
        const initializer = initializerAt(expression, parsed.path.split("."));
        let value: TemporalExpression | undefined;
        if ((parsed.kind === "set-from-array" || parsed.kind === "map-from-entries") && checker && initializer && ts.isCallExpression(initializer)
          && ts.isPropertyAccessExpression(initializer.expression)
          && ts.isIdentifier(initializer.expression.expression) && initializer.expression.expression.text === "Array"
          && initializer.expression.name.text === "from" && initializer.arguments.length === 1
          && isDeclarationFileSymbol(checker, initializer.expression.name, "from")) {
          const source = accessPath(initializer.arguments[0]!);
          if (source?.length === 1 && source[0] === name) value = { kind: "name", name };
        } else if (initializer) value = normalizeProjectionExpression(initializer);
        const expanded = expandedIdentity(type, [name]);
        if (value && expanded && sameRefinementExpression(value, expanded)) value = { kind: "name", name };
        if (!value) return undefined;
        projection.set(name, value);
      }
      return projection;
    }
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (!ts.isIdentifier(property.expression) || property.expression.text !== receiver) return undefined;
        for (const [name, value] of identity()) projection.set(name, value);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const field = aliases.get(property.name.text);
        if (!field || !stateNames.has(property.name.text)) return undefined;
        projection.set(property.name.text, { kind: "name", name: field });
        continue;
      }
      if (!ts.isPropertyAssignment(property)) return undefined;
      const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
      const field = propertyName && role === "create" ? concreteToAbstract.get(propertyName) ?? propertyName : propertyName;
      if (!field || !stateNames.has(field)) return undefined;
      const alias = ts.isIdentifier(property.initializer) ? aliases.get(property.initializer.text) : undefined;
      let value = alias
        ? { kind: "name", name: alias } as TemporalExpression
        : normalizeProjectionExpression(property.initializer);
      if (!value) return undefined;
      const type = stateTypes.get(field);
      const expanded = type ? expandedIdentity(type, [field]) : undefined;
      if (expanded && sameRefinementExpression(value, expanded)) value = { kind: "name", name: field };
      projection.set(field, value);
    }
    return projection;
  };

  const diagnostics: RefinementStateProjectionDiagnostic[] = [];
  const expectedStateType: TemporalValueType = { kind: "record", fields: Object.fromEntries(spec.states.map(({ name, type }) => [name, type])) };
  const concreteStateMismatch = (actual: ts.Type, location: ts.Node): readonly string[] | undefined => {
    if ((actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0) return [];
    if ((actual.flags & ts.TypeFlags.Object) === 0 && !actual.isIntersection()) return [];
    for (const { name, type } of spec.states) {
      const relation = abstraction.get(name);
      const parsed = relation ? parseAbstractionValue(relation) : { kind: "identity" as const, path: name };
      let current = actual;
      let declaration: ts.Node = location;
      for (const part of parsed.path.split(".")) {
        const property = current.getProperty(part);
        if (!property) return [name];
        declaration = property.valueDeclaration ?? property.declarations?.[0] ?? declaration;
        current = checker!.getTypeOfSymbolAtLocation(property, declaration);
      }
      let mismatch: readonly string[] | undefined;
      if (parsed.kind === "set-from-array") {
        if (typeof type === "string" || type.kind !== "set") mismatch = [name];
        else {
          const symbol = current.getSymbol() ?? current.aliasSymbol;
          const builtinArray = symbol?.getName() === "Array"
            && (symbol.declarations ?? []).some((candidate) => candidate.getSourceFile().isDeclarationFile);
          const element = builtinArray && (current.flags & ts.TypeFlags.Object) !== 0
            ? checker!.getTypeArguments(current as ts.TypeReference)[0]
            : undefined;
          mismatch = element && type.element !== "never"
            ? typescriptTemporalShapeMismatch(checker!, element, type.element, declaration, [name, "<element>"])
            : element ? undefined : [name];
        }
      } else if (parsed.kind === "map-from-entries") {
        if (typeof type === "string" || type.kind !== "map") mismatch = [name];
        else {
          const symbol = current.getSymbol() ?? current.aliasSymbol;
          const builtinArray = symbol?.getName() === "Array"
            && (symbol.declarations ?? []).some((candidate) => candidate.getSourceFile().isDeclarationFile);
          const element = builtinArray && (current.flags & ts.TypeFlags.Object) !== 0
            ? checker!.getTypeArguments(current as ts.TypeReference)[0]
            : undefined;
          const tupleArguments = element && checker!.isTupleType(element)
            ? checker!.getTypeArguments(element as ts.TypeReference)
            : undefined;
          const [key, value] = tupleArguments ?? [];
          mismatch = !key || !value || tupleArguments?.length !== 2 ? [name]
            : type.key !== "never" && typescriptTemporalShapeMismatch(checker!, key, type.key, declaration, [name, "<key>"])
              || type.value !== "never" && typescriptTemporalShapeMismatch(checker!, value, type.value, declaration, [name, "<value>"])
              || undefined;
        }
      } else mismatch = typescriptTemporalShapeMismatch(checker!, current, type, declaration, [name]);
      if (mismatch) return mismatch;
    }
    return undefined;
  };
  for (const role of ["create", "observe"] as const) {
    const exportName = manifest[role];
    const implementation = functions.get(exportName);
    if (checker && implementation) {
      const parameter = implementation.parameters[0];
      const parameterMismatch = parameter
        ? role === "create"
          ? typescriptTemporalShapeMismatch(checker, checker.getTypeAtLocation(parameter), expectedStateType, parameter)
          : concreteStateMismatch(checker.getTypeAtLocation(parameter), parameter)
        : [];
      const signature = checker.getSignatureFromDeclaration(implementation);
      const returnMismatch = signature
        ? role === "observe"
          ? typescriptTemporalShapeMismatch(checker, checker.getReturnTypeOfSignature(signature), expectedStateType, implementation)
          : concreteStateMismatch(checker.getReturnTypeOfSignature(signature), implementation)
        : [];
      const mismatch = parameterMismatch ?? returnMismatch;
      if (mismatch) {
        diagnostics.push({
          code: `${role}-type-mismatch`, adapterName, role, exportName,
          ...(mismatch[0] ? { field: mismatch[0] } : {}),
          expected: formatTemporalValueType(expectedStateType),
          actual: parameterMismatch ? (parameter ? checker.typeToString(checker.getTypeAtLocation(parameter)) : "<missing>") : (signature ? checker.typeToString(checker.getReturnTypeOfSignature(signature)) : "<missing>"),
          message: `${exportName} ${parameterMismatch ? "parameter" : "return"} type does not match temporal state${mismatch.length ? ` at ${mismatch.join(".")}` : ""}`,
        });
        continue;
      }
    }
    const projection = implementation ? extract(implementation, role) : undefined;
    if (!projection) {
      diagnostics.push({ code: `unsupported-${role}-body`, adapterName, role, exportName, message: `${exportName} is outside the supported state-projection fragment` });
      continue;
    }
    for (const { name } of spec.states) {
      const actual = projection.get(name);
      if (actual?.kind === "name" && actual.name === name) continue;
      diagnostics.push({
        code: `${role}-state-mismatch`, adapterName, role, exportName, field: name, expected: name,
        actual: actual ? formatRefinementExpression(actual) : "<missing>",
        message: `${exportName} projects ${name} as ${actual ? formatRefinementExpression(actual) : "<missing>"}, expected ${name}`,
      });
    }
  }
  return diagnostics;
}

/** Proves that create and observe each preserve every model state field by name. */
export function validateRefinementStateProjection(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementStateProjectionDiagnostic[] {
  return validateRefinementStateProjectionInSource(
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), text, adapterName, spec,
  );
}

/** Resolves imported create/observe wrappers through TypeScript symbol identity. */
export function validateRefinementStateProjectionInProgram(
  program: ts.Program,
  fileName: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementStateProjectionDiagnostic[] {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`TypeScript program does not contain refinement source ${fileName}`);
  return validateRefinementStateProjectionInSource(source, source.text, adapterName, spec, program.getTypeChecker());
}

function callable(exports: Record<string, unknown>, name: string): (...args: any[]) => any {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`refinement binding export ${name} is not callable`);
  return value as (...args: any[]) => any;
}

/** Resolves an extracted manifest against already-loaded module exports for test/replay tooling. */
export function createAnnotatedRefinementAdapter<State extends object = ModelState, Runtime = unknown>(
  fileName: string,
  text: string,
  exports: Record<string, unknown>,
  adapterName: string,
): ModelRefinementAdapter<Runtime, State> {
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  return {
    schema: "uneffect-refinement-adapter/v1", name: manifest.adapterName, version: manifest.version,
    abstractions: manifest.abstractions,
    create: callable(exports, manifest.create), observe: callable(exports, manifest.observe),
    actions: Object.fromEntries(Object.entries(manifest.actions).map(([name, binding]) => [name, callable(exports, binding)])),
    invariants: Object.fromEntries(Object.entries(manifest.invariants).map(([name, binding]) => [name, callable(exports, binding)])),
  } as ModelRefinementAdapter<Runtime, State>;
}

/** Emits a reviewable module that references implementation exports without runtime wrappers. */
export function generateRefinementAdapterModule(fileName: string, text: string, moduleSpecifier: string, adapterName: string): string {
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const record = (entries: Record<string, string>) => `{ ${Object.entries(entries).map(([name, binding]) => `${JSON.stringify(name)}: implementation.${binding}`).join(", ")} }`;
  return `import * as implementation from ${JSON.stringify(moduleSpecifier)}\n\nexport const ${adapterName}RefinementAdapter = {\n  schema: "uneffect-refinement-adapter/v1",\n  name: ${JSON.stringify(adapterName)},\n  version: ${JSON.stringify(manifest.version)},\n  abstractions: ${JSON.stringify(manifest.abstractions)},\n  create: implementation.${manifest.create},\n  observe: implementation.${manifest.observe},\n  actions: ${record(manifest.actions)},\n  invariants: ${record(manifest.invariants)},\n} as const\n`;
}
