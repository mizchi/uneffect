import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { ModelRefinementAdapter, ModelState } from "./model-replay.js";
import type { TemporalSpec } from "./spec-ir.js";
import type { TemporalBinaryOperator, TemporalExpression, TemporalValueType } from "./temporal-expressions.js";
import { generateRuntimeAssertionExpression, parseTemporalExpression } from "./temporal-expressions.js";
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

export type Z3RefinementDiagnostic<T> = T & {
  backend?: "z3";
  equivalence?: "different" | "unknown";
  reason?: string;
};

export type RefinementStateProjectionDiagnosticCode = "unsupported-create-body" | "unsupported-observe-body" | "create-state-mismatch" | "observe-state-mismatch";

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
    create: singleton("create"), observe: singleton("observe"), actions: named("action"), invariants: named("invariant"),
  };
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
  return JSON.stringify(expression, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    : value);
}

function sameRefinementExpression(left: TemporalExpression, right: TemporalExpression): boolean {
  return refinementExpressionKey(left) === refinementExpressionKey(right);
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
): TemporalExpression | undefined {
  if (ts.isParenthesizedExpression(node)) return normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
  if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text)) return { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: node.kind === ts.SyntaxKind.TrueKeyword };
  if (ts.isIdentifier(node)) {
    const symbolic = symbolicSubstitutions.get(node.text);
    if (symbolic) return { kind: "name", name: `\u0000local:${node.text}` };
    const replacement = substitutions.get(node.text);
    return replacement ? normalizeRefinementExpression(replacement, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions) : undefined;
  }
  const field = refinementFieldName(node, receiver, substitutions);
  if (field && stateNames.has(field)) return { kind: "name", name: field };
  if (ts.isPropertyAccessExpression(node)) {
    const base = normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
    if (base) return { kind: "field", receiver: base, name: node.name.text };
  }
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.ExclamationToken)) {
    const operand = normalizeRefinementExpression(node.operand, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
    return operand ? { kind: "unary", operator: node.operator === ts.SyntaxKind.ExclamationToken ? "not" : "negate", operand } : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = temporalBinaryOperators.get(node.operatorToken.kind);
    const left = normalizeRefinementExpression(node.left, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
    const right = normalizeRefinementExpression(node.right, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
    return operator && left && right ? { kind: "binary", operator, left, right } : undefined;
  }
  if (ts.isConditionalExpression(node)) {
    const condition = normalizeRefinementExpression(node.condition, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
    const whenTrue = normalizeRefinementExpression(node.whenTrue, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
    const whenFalse = normalizeRefinementExpression(node.whenFalse, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
    return condition && whenTrue && whenFalse ? { kind: "conditional", condition, whenTrue, whenFalse } : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    let base: TemporalExpression | undefined;
    const fields: Record<string, TemporalExpression> = {};
    for (let index = 0; index < node.properties.length; index++) {
      const property = node.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
        if (index !== 0 || base) return undefined;
        base = normalizeRefinementExpression(property.expression, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
        if (!base) return undefined;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const value = normalizeRefinementExpression(property.name, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
        if (!value || Object.hasOwn(fields, property.name.text)) return undefined;
        fields[property.name.text] = value;
        continue;
      }
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
      const value = normalizeRefinementExpression(property.initializer, receiver, substitutions, stateNames, helpers, activeHelpers, symbolicSubstitutions);
      if (!name || !value || Object.hasOwn(fields, name)) return undefined;
      fields[name] = value;
    }
    return { kind: "record", ...(base ? { base } : {}), fields };
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    const helper = helpers.get(name);
    if (!helper?.body || activeHelpers.has(name) || helper.parameters.length !== node.arguments.length
      || helper.body.statements.length !== 1) return undefined;
    const returned = helper.body.statements[0];
    if (!returned || !ts.isReturnStatement(returned) || !returned.expression) return undefined;
    const resolveArgument = (argument: ts.Expression, seen: ReadonlySet<string> = new Set()): ts.Expression | undefined => {
      if (!ts.isIdentifier(argument)) return argument;
      if (seen.has(argument.text)) return undefined;
      const replacement = substitutions.get(argument.text);
      return replacement ? resolveArgument(replacement, new Set([...seen, argument.text])) : argument;
    };
    const nested = new Map<string, ts.Expression>();
    for (let index = 0; index < helper.parameters.length; index++) {
      const parameter = helper.parameters[index]!;
      if (!ts.isIdentifier(parameter.name)) return undefined;
      const argument = resolveArgument(node.arguments[index]!);
      if (!argument) return undefined;
      nested.set(parameter.name.text, argument);
    }
    return normalizeRefinementExpression(returned.expression, receiver, nested, stateNames, helpers, new Set([...activeHelpers, name]), symbolicSubstitutions);
  }
  return undefined;
}

/** Proves a deliberately small, zero-runtime scalar update fragment against model actions. */
export function validateRefinementActionBodies(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementActionDiagnostic[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const classes = new Map(source.statements.filter(ts.isClassDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const stateTypes = new Map(spec.states.map(({ name, type }) => [name, type]));
  const diagnostics: RefinementActionDiagnostic[] = [];

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
    const guard = normalizeRefinementExpression(unwrap(condition.operand), receiver, new Map(), stateNames);
    return guard ? { guard, updates: ts.factory.createBlock(body.statements.slice(1), true) } : { updates: body };
  };

  const collect = (
    body: ts.Block,
    receiver: string,
    runtimeClass: ts.ClassDeclaration | undefined,
    substitutions: ReadonlyMap<string, ts.Expression>,
    updates: Map<string, TemporalExpression> = new Map(),
    localValues: Map<string, TemporalExpression> = new Map(),
    activeCalls: ReadonlySet<string> = new Set(),
    allowTerminalReturn = true,
  ): Map<string, TemporalExpression> | undefined => {
    const expandLocalSnapshots = (expression: TemporalExpression): TemporalExpression => {
      if (expression.kind === "name" && expression.name.startsWith("\u0000local:")) {
        return localValues.get(expression.name.slice("\u0000local:".length)) ?? expression;
      }
      if (expression.kind === "unary") return { ...expression, operand: expandLocalSnapshots(expression.operand) };
      if (expression.kind === "binary") return { ...expression, left: expandLocalSnapshots(expression.left), right: expandLocalSnapshots(expression.right) };
      if (expression.kind === "conditional") return { ...expression, condition: expandLocalSnapshots(expression.condition), whenTrue: expandLocalSnapshots(expression.whenTrue), whenFalse: expandLocalSnapshots(expression.whenFalse) };
      if (expression.kind === "field") return { ...expression, receiver: expandLocalSnapshots(expression.receiver) };
      if (expression.kind === "record") return { ...expression, ...(expression.base ? { base: expandLocalSnapshots(expression.base) } : {}), fields: Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, expandLocalSnapshots(value)])) };
      if (expression.kind === "array") return { ...expression, elements: expression.elements.map(expandLocalSnapshots) };
      return expression;
    };
    const resolveCurrentState = (expression: TemporalExpression): TemporalExpression => {
      if (expression.kind === "name") return updates.get(expression.name) ?? expression;
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
    for (let statementIndex = 0; statementIndex < body.statements.length; statementIndex++) {
      const statement = body.statements[statementIndex]!;
      const terminalReturn = ts.isReturnStatement(statement);
      if (terminalReturn && (!allowTerminalReturn || statementIndex !== body.statements.length - 1)) return undefined;
      if (terminalReturn && !statement.expression) return updates;
      if (terminalReturn && !ts.isCallExpression(statement.expression!)) return undefined;
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
        for (let value = start; value < end; value++) {
          const iterationSubstitutions = new Map(substitutions);
          iterationSubstitutions.set(loopName, ts.factory.createNumericLiteral(value));
          if (!collect(asBlock(statement.statement), receiver, runtimeClass, iterationSubstitutions, updates, new Map(localValues), activeCalls, false)) return undefined;
        }
        continue;
      }
      if (ts.isIfStatement(statement)) {
        const normalizedCondition = normalizeRefinementExpression(statement.expression, receiver, substitutions, stateNames, new Map(), new Set(), localValues);
        if (!normalizedCondition) return undefined;
        const condition = expandLocalSnapshots(resolveCurrentState(normalizedCondition));
        const before = new Map(updates);
        const whenTrue = collect(asBlock(statement.thenStatement), receiver, runtimeClass, substitutions, new Map(before), new Map(localValues), activeCalls, false);
        const whenFalse = collect(asBlock(statement.elseStatement), receiver, runtimeClass, substitutions, new Map(before), new Map(localValues), activeCalls, false);
        if (!whenTrue || !whenFalse) return undefined;
        updates.clear();
        for (const name of stateNames) {
          const original = { kind: "name", name } as TemporalExpression;
          const trueValue = whenTrue.get(name) ?? original;
          const falseValue = whenFalse.get(name) ?? original;
          const merged: TemporalExpression = sameRefinementExpression(trueValue, falseValue)
            ? trueValue
            : { kind: "conditional", condition, whenTrue: trueValue, whenFalse: falseValue };
          if (!sameRefinementExpression(merged, original)) updates.set(name, merged);
        }
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer || localValues.has(declaration.name.text)) return undefined;
          const value = normalizeRefinementExpression(declaration.initializer, receiver, substitutions, stateNames, new Map(), new Set(), localValues);
          if (!value) return undefined;
          localValues.set(declaration.name.text, expandLocalSnapshots(resolveCurrentState(value)));
        }
        continue;
      }
      if (!ts.isExpressionStatement(statement) && !terminalReturn) return undefined;
      const node = ts.isReturnStatement(statement) ? statement.expression! : statement.expression;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const helperName = node.expression.text;
        const helper = functions.get(helperName);
        const callKey = `function:${helperName}`;
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
          const argument = normalizeRefinementExpression(node.arguments[index]!, receiver, substitutions, stateNames, new Map(), new Set(), localValues);
          if (!argument) return undefined;
          helperLocals.set((helper.parameters[index]!.name as ts.Identifier).text, expandLocalSnapshots(resolveCurrentState(argument)));
        }
        const helperReceiver = (helper.parameters[0]!.name as ts.Identifier).text;
        if (!collect(helper.body, helperReceiver, undefined, new Map(), updates, helperLocals, new Set([...activeCalls, callKey]), true)) return undefined;
        if (terminalReturn) return updates;
        continue;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const [target, ...fields] = refinementFieldPath(node.expression.expression, receiver, substitutions) ?? [];
        let targetType = target ? stateTypes.get(target) : undefined;
        for (const field of fields) {
          if (!targetType || typeof targetType === "string" || targetType.kind !== "record") { targetType = undefined; break; }
          targetType = targetType.fields[field];
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "add"
          && typeof targetType !== "string" && targetType.kind === "set" && node.arguments.length === 1) {
          const element = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, stateNames, new Map(), new Set(), localValues);
          if (!element) return undefined;
          writePath(target, fields, {
            kind: "method", receiver: readPath(target, fields), name: "union",
            arguments: [{ kind: "call", name: "Set", arguments: [expandLocalSnapshots(resolveCurrentState(element))] }],
          });
          continue;
        }
        if (target && stateNames.has(target) && targetType && node.expression.name.text === "set"
          && typeof targetType !== "string" && targetType.kind === "map" && node.arguments.length === 2) {
          const key = normalizeRefinementExpression(node.arguments[0]!, receiver, substitutions, stateNames, new Map(), new Set(), localValues);
          const value = normalizeRefinementExpression(node.arguments[1]!, receiver, substitutions, stateNames, new Map(), new Set(), localValues);
          if (!key || !value) return undefined;
          writePath(target, fields, {
            kind: "method", receiver: readPath(target, fields), name: "put",
            arguments: [expandLocalSnapshots(resolveCurrentState(key)), expandLocalSnapshots(resolveCurrentState(value))],
          });
          continue;
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === receiver && runtimeClass) {
        const methodName = node.expression.name.text;
        const method = runtimeClass.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName);
        if (!method?.body || method.parameters.length !== node.arguments.length) return undefined;
        const nestedSubstitutions = new Map<string, ts.Expression>();
        method.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name)) nestedSubstitutions.set(parameter.name.text, node.arguments[index]!);
        });
        const callKey = `method:${runtimeClass.name?.text ?? "<anonymous>"}.${methodName}`;
        if (activeCalls.has(callKey) || !collect(method.body, "this", runtimeClass, nestedSubstitutions, updates, new Map(localValues), new Set([...activeCalls, callKey]), true)) return undefined;
        if (terminalReturn) return updates;
        continue;
      }
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
        if (node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken) return undefined;
        const [target, ...fields] = refinementFieldPath(node.operand, receiver, substitutions) ?? [];
        if (!target || !stateNames.has(target)) return undefined;
        writePath(target, fields, { kind: "binary", operator: node.operator === ts.SyntaxKind.PlusPlusToken ? "add" : "subtract", left: readPath(target, fields), right: { kind: "integer", value: "1" } });
        continue;
      }
      if (ts.isBinaryExpression(node)) {
        const [target, ...fields] = refinementFieldPath(node.left, receiver, substitutions) ?? [];
        if (!target || !stateNames.has(target)) return undefined;
        const right = normalizeRefinementExpression(node.right, receiver, substitutions, stateNames, new Map(), new Set(), localValues);
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
    return updates;
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
    const runtimeType = runtimeParameter?.type && ts.isTypeReferenceNode(runtimeParameter.type) && ts.isIdentifier(runtimeParameter.type.typeName) ? runtimeParameter.type.typeName.text : undefined;
    const guardedBody = implementation?.body && receiver ? earlyReturnGuard(implementation.body, receiver) : undefined;
    const actualGuard = guardedBody?.guard;
    if (action.guard && !actualGuard) {
      diagnostics.push({ code: "missing-action-guard", adapterName, modelName: action.name, exportName, expected: formatRefinementExpression(action.guard.expressionAst), actual: "<missing>", message: `${exportName} does not enforce model action guard ${action.guard.expression}` });
    } else if (!action.guard && actualGuard) {
      diagnostics.push({ code: "unexpected-action-guard", adapterName, modelName: action.name, exportName, expected: "<none>", actual: formatRefinementExpression(actualGuard), message: `${exportName} enforces an early-return guard absent from model action ${action.name}` });
    } else if (action.guard && actualGuard && !sameRefinementExpression(action.guard.expressionAst, actualGuard)) {
      diagnostics.push({ code: "action-guard-mismatch", adapterName, modelName: action.name, exportName, expected: formatRefinementExpression(action.guard.expressionAst), actual: formatRefinementExpression(actualGuard), message: `${exportName} enforces ${formatRefinementExpression(actualGuard)}, expected ${action.guard.expression}` });
    }
    const updates = guardedBody && receiver ? collect(guardedBody.updates, receiver, runtimeType ? classes.get(runtimeType) : undefined, new Map()) : undefined;
    if (!updates) {
      diagnostics.push({ code: "unsupported-action-body", adapterName, modelName: action.name, exportName, message: `${exportName} uses an action body outside the supported scalar refinement fragment` });
      continue;
    }
    const expected = new Map(action.assignments.map(({ target, expressionAst }) => [target, expressionAst]));
    for (const state of spec.states) {
      const expectedExpression = expected.get(state.name) ?? { kind: "name", name: state.name } as const;
      const actualExpression = updates.get(state.name) ?? { kind: "name", name: state.name } as const;
      if (sameRefinementExpression(expectedExpression, actualExpression)) continue;
      diagnostics.push({
        code: "action-update-mismatch", adapterName, modelName: action.name, exportName, target: state.name,
        expected: formatRefinementExpression(expectedExpression), actual: formatRefinementExpression(actualExpression),
        message: `${exportName} updates ${state.name} as ${formatRefinementExpression(actualExpression)}, expected ${formatRefinementExpression(expectedExpression)}`,
      });
    }
  }
  const modelActions = new Set(spec.actions.map(({ name }) => name));
  for (const [modelName, exportName] of Object.entries(manifest.actions)) {
    if (modelActions.has(modelName)) continue;
    diagnostics.push({ code: "unknown-action-binding", adapterName, modelName, exportName, message: `action refinement ${exportName} refers to unknown model action ${modelName}` });
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
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
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
          || !normalizeRefinementExpression(declaration.initializer, receiver ?? "", substitutions, stateNames, functions)) {
          supportedLocals = false;
          break;
        }
        substitutions.set(declaration.name.text, declaration.initializer);
      }
      if (!supportedLocals) break;
    }
    const actual = receiver && supportedLocals && returned && ts.isReturnStatement(returned) && returned.expression
      ? normalizeRefinementExpression(returned.expression, receiver, substitutions, stateNames, functions)
      : undefined;
    if (!actual) {
      diagnostics.push({ code: "unsupported-invariant-body", adapterName, modelName: property.name, exportName, message: `${exportName} is not a single supported scalar return predicate` });
      continue;
    }
    if (sameRefinementExpression(property.expressionAst, actual)) continue;
    diagnostics.push({
      code: "invariant-expression-mismatch", adapterName, modelName: property.name, exportName,
      expected: formatRefinementExpression(property.expressionAst), actual: formatRefinementExpression(actual),
      message: `${exportName} returns ${formatRefinementExpression(actual)}, expected ${formatRefinementExpression(property.expressionAst)}`,
    });
  }
  const modelProperties = new Set(spec.properties.map(({ name }) => name));
  for (const [modelName, exportName] of Object.entries(manifest.invariants)) {
    if (modelProperties.has(modelName)) continue;
    diagnostics.push({ code: "unknown-invariant-binding", adapterName, modelName, exportName, message: `invariant refinement ${exportName} refers to unknown temporal property ${modelName}` });
  }
  return diagnostics;
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
    const result = await checkTemporalExpressionEquivalenceWithZ3(
      spec,
      parseTemporalExpression(diagnostic.expected),
      parseTemporalExpression(diagnostic.actual),
    );
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

/** Keeps scalar update checking syntactic, while proving mismatched boolean action guards with Z3. */
export async function validateRefinementActionBodiesWithZ3(
  fileName: string, text: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementActionDiagnostic>>> {
  return dischargeExpressionMismatchesWithZ3(validateRefinementActionBodies(fileName, text, adapterName, spec), "action-guard-mismatch", spec);
}

/** Proves normalized single-return invariant predicates by logical rather than syntactic equivalence. */
export async function validateRefinementInvariantBodiesWithZ3(
  fileName: string, text: string, adapterName: string, spec: TemporalSpec,
): Promise<Array<Z3RefinementDiagnostic<RefinementInvariantDiagnostic>>> {
  return dischargeExpressionMismatchesWithZ3(validateRefinementInvariantBodies(fileName, text, adapterName, spec), "invariant-expression-mismatch", spec);
}

/** Proves that create and observe each preserve every model state field by name. */
export function validateRefinementStateProjection(
  fileName: string,
  text: string,
  adapterName: string,
  spec: TemporalSpec,
): RefinementStateProjectionDiagnostic[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const classes = new Map(source.statements.filter(ts.isClassDeclaration).flatMap((node) => node.name ? [[node.name.text, node] as const] : []));
  const stateNames = new Set(spec.states.map(({ name }) => name));
  const stateTypes = new Map(spec.states.map(({ name, type }) => [name, type]));
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
      return base ? [...base, node.name.text] : undefined;
    };
    const pathExpression = (path: readonly string[]): TemporalExpression | undefined => {
      const [root, ...fields] = path;
      if (!root || !stateNames.has(root)) return undefined;
      return fields.reduce<TemporalExpression>((value, name) => ({ kind: "field", receiver: value, name }), { kind: "name", name: root });
    };
    const normalizeProjectionExpression = (node: ts.Expression): TemporalExpression | undefined => {
      const path = accessPath(node);
      if (path) return pathExpression(path);
      if (!ts.isObjectLiteralExpression(node)) return normalizeRefinementExpression(node, receiver, new Map(), stateNames);
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
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
      && expression.arguments.length === 1 && ts.isIdentifier(expression.arguments[0]!)
      && expression.arguments[0]!.text === receiver) {
      const helper = functions.get(expression.expression.text);
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
      const field = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
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
  for (const role of ["create", "observe"] as const) {
    const exportName = manifest[role];
    const implementation = functions.get(exportName);
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
    create: callable(exports, manifest.create), observe: callable(exports, manifest.observe),
    actions: Object.fromEntries(Object.entries(manifest.actions).map(([name, binding]) => [name, callable(exports, binding)])),
    invariants: Object.fromEntries(Object.entries(manifest.invariants).map(([name, binding]) => [name, callable(exports, binding)])),
  } as ModelRefinementAdapter<Runtime, State>;
}

/** Emits a reviewable module that references implementation exports without runtime wrappers. */
export function generateRefinementAdapterModule(fileName: string, text: string, moduleSpecifier: string, adapterName: string): string {
  const manifest = buildRefinementBindingManifest(fileName, text, adapterName);
  const record = (entries: Record<string, string>) => `{ ${Object.entries(entries).map(([name, binding]) => `${JSON.stringify(name)}: implementation.${binding}`).join(", ")} }`;
  return `import * as implementation from ${JSON.stringify(moduleSpecifier)}\n\nexport const ${adapterName}RefinementAdapter = {\n  schema: "uneffect-refinement-adapter/v1",\n  name: ${JSON.stringify(adapterName)},\n  version: ${JSON.stringify(manifest.version)},\n  create: implementation.${manifest.create},\n  observe: implementation.${manifest.observe},\n  actions: ${record(manifest.actions)},\n  invariants: ${record(manifest.invariants)},\n} as const\n`;
}
