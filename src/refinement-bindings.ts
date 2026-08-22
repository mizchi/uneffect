import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { ModelRefinementAdapter, ModelState } from "./model-replay.js";
import type { TemporalSpec } from "./spec-ir.js";
import type { TemporalBinaryOperator, TemporalExpression } from "./temporal-expressions.js";

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

export type RefinementActionDiagnosticCode = "missing-action-binding" | "unknown-action-binding" | "unsupported-action-body" | "action-update-mismatch";

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
  if (expression.kind === "name") return expression.name;
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") return `${expression.operator === "not" ? "!" : "-"}${formatRefinementExpression(expression.operand)}`;
  if (expression.kind === "binary") {
    const operator = ({ add: "+", subtract: "-", multiply: "*", divide: "/", modulo: "%", eq: "===", neq: "!==", and: "&&", or: "||", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const)[expression.operator];
    return `${formatRefinementExpression(expression.left)} ${operator} ${formatRefinementExpression(expression.right)}`;
  }
  return `<${expression.kind}>`;
}

function refinementFieldName(
  target: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
): string | undefined {
  if (ts.isPropertyAccessExpression(target)
    && ((ts.isIdentifier(target.expression) && target.expression.text === receiver) || target.expression.kind === ts.SyntaxKind.ThisKeyword)) return target.name.text;
  if (ts.isElementAccessExpression(target)
    && ((ts.isIdentifier(target.expression) && target.expression.text === receiver) || target.expression.kind === ts.SyntaxKind.ThisKeyword)) {
    const argument = target.argumentExpression;
    const replacement = ts.isIdentifier(argument) ? substitutions.get(argument.text) : argument;
    return replacement && ts.isStringLiteral(replacement) ? replacement.text : undefined;
  }
  return undefined;
}

function normalizeRefinementExpression(
  node: ts.Expression,
  receiver: string,
  substitutions: ReadonlyMap<string, ts.Expression>,
  stateNames: ReadonlySet<string>,
): TemporalExpression | undefined {
  if (ts.isParenthesizedExpression(node)) return normalizeRefinementExpression(node.expression, receiver, substitutions, stateNames);
  if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text)) return { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: node.kind === ts.SyntaxKind.TrueKeyword };
  if (ts.isIdentifier(node)) {
    const replacement = substitutions.get(node.text);
    return replacement ? normalizeRefinementExpression(replacement, receiver, substitutions, stateNames) : stateNames.has(node.text) ? { kind: "name", name: node.text } : undefined;
  }
  const field = refinementFieldName(node, receiver, substitutions);
  if (field && stateNames.has(field)) return { kind: "name", name: field };
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.ExclamationToken)) {
    const operand = normalizeRefinementExpression(node.operand, receiver, substitutions, stateNames);
    return operand ? { kind: "unary", operator: node.operator === ts.SyntaxKind.ExclamationToken ? "not" : "negate", operand } : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const operator = temporalBinaryOperators.get(node.operatorToken.kind);
    const left = normalizeRefinementExpression(node.left, receiver, substitutions, stateNames);
    const right = normalizeRefinementExpression(node.right, receiver, substitutions, stateNames);
    return operator && left && right ? { kind: "binary", operator, left, right } : undefined;
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
  const diagnostics: RefinementActionDiagnostic[] = [];

  const collect = (
    body: ts.Block,
    receiver: string,
    runtimeClass: ts.ClassDeclaration | undefined,
    substitutions: ReadonlyMap<string, ts.Expression>,
  ): Map<string, TemporalExpression> | undefined => {
    const updates = new Map<string, TemporalExpression>();
    for (const statement of body.statements) {
      if (!ts.isExpressionStatement(statement)) return undefined;
      const node = statement.expression;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === receiver && runtimeClass) {
        const methodName = node.expression.name.text;
        const method = runtimeClass.members.find((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName);
        if (!method?.body || method.parameters.length !== node.arguments.length) return undefined;
        const nestedSubstitutions = new Map<string, ts.Expression>();
        method.parameters.forEach((parameter, index) => {
          if (ts.isIdentifier(parameter.name)) nestedSubstitutions.set(parameter.name.text, node.arguments[index]!);
        });
        const nested = collect(method.body, "this", runtimeClass, nestedSubstitutions);
        if (!nested) return undefined;
        for (const [target, value] of nested) {
          if (updates.has(target)) return undefined;
          updates.set(target, value);
        }
        continue;
      }
      if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
        if (node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken) return undefined;
        const target = refinementFieldName(node.operand, receiver, substitutions);
        if (!target || !stateNames.has(target) || updates.has(target)) return undefined;
        updates.set(target, { kind: "binary", operator: node.operator === ts.SyntaxKind.PlusPlusToken ? "add" : "subtract", left: { kind: "name", name: target }, right: { kind: "integer", value: "1" } });
        continue;
      }
      if (ts.isBinaryExpression(node)) {
        const target = refinementFieldName(node.left, receiver, substitutions);
        if (!target || !stateNames.has(target) || updates.has(target)) return undefined;
        const right = normalizeRefinementExpression(node.right, receiver, substitutions, stateNames);
        if (!right) return undefined;
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) updates.set(target, right);
        else if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || node.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) {
          updates.set(target, { kind: "binary", operator: node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? "add" : "subtract", left: { kind: "name", name: target }, right });
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
    const updates = implementation?.body && receiver ? collect(implementation.body, receiver, runtimeType ? classes.get(runtimeType) : undefined, new Map()) : undefined;
    if (!updates) {
      diagnostics.push({ code: "unsupported-action-body", adapterName, modelName: action.name, exportName, message: `${exportName} uses an action body outside the supported scalar refinement fragment` });
      continue;
    }
    const expected = new Map(action.assignments.map(({ target, expressionAst }) => [target, expressionAst]));
    for (const state of spec.states) {
      const expectedExpression = expected.get(state.name) ?? { kind: "name", name: state.name } as const;
      const actualExpression = updates.get(state.name) ?? { kind: "name", name: state.name } as const;
      if (JSON.stringify(expectedExpression) === JSON.stringify(actualExpression)) continue;
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
    const statement = implementation?.body?.statements.length === 1 ? implementation.body.statements[0] : undefined;
    const actual = receiver && statement && ts.isReturnStatement(statement) && statement.expression
      ? normalizeRefinementExpression(statement.expression, receiver, new Map(), stateNames)
      : undefined;
    if (!actual) {
      diagnostics.push({ code: "unsupported-invariant-body", adapterName, modelName: property.name, exportName, message: `${exportName} is not a single supported scalar return predicate` });
      continue;
    }
    if (JSON.stringify(property.expressionAst) === JSON.stringify(actual)) continue;
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
