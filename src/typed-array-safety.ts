import ts from "typescript";
import { posix } from "node:path";
import { extractAnnotations } from "./annotations.js";
import { logicToSmt, parseLogicExpression } from "./invariant-ir.js";
import { executeZ3, type Z3ExecutionOptions } from "./z3.js";
import { resolveStableRegion } from "./region-alias.js";
import { symbolIdentityKey } from "./binding-identity.js";
import { resolveAssumptionRecord, type AssumptionRegistry } from "./assumption-registry.js";

export interface TypedArrayObligation {
  functionName: string;
  kind: "max-length" | "u8-write" | "u32-write" | "index-bounds" | "dataview-bounds" | "dataview-backing-bounds" | "dataview-value" | "shift-count" | "bulk-copy-bounds" | "bulk-copy-values" | "constant-table-values" | "constant-table-index";
  result: "verified" | "trusted" | "counterexample" | "unknown";
  goal: string;
  trustReason?: string;
  assumptionId?: string;
  trustOwner?: string;
  trustExpiresOn?: string;
  trustReviewDigest?: string;
  span: { start: number; end: number };
}
export interface TypedArrayDiagnostic {
  fileName: string;
  functionName: string;
  kind: TypedArrayObligation["kind"];
  message: string;
  span: { start: number; end: number };
}
export interface TypedArraySafetyStatistics { solverQueries: number }
export interface TypedArraySafetyResult { obligations: TypedArrayObligation[]; diagnostics: TypedArrayDiagnostic[]; statistics: TypedArraySafetyStatistics }
export interface TypedArrayProgramSafetyResult extends TypedArraySafetyResult { files: Record<string, TypedArraySafetyResult> }

async function prove(parameters: readonly ts.ParameterDeclaration[], assumptions: string[], goal: string, z3?: Z3ExecutionOptions): Promise<"verified" | "counterexample" | "unknown"> {
  try {
    const names = new Set(parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    for (const expression of [...assumptions, goal]) for (const match of expression.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!["true", "false"].includes(match[0])) names.add(match[0]);
    }
    const lines = ["(set-logic ALL)", ...[...names].map((name) => `(declare-const ${name} Int)`), ...assumptions.map((item) => `(assert ${logicToSmt(parseLogicExpression(item))})`), `(assert (not ${logicToSmt(parseLogicExpression(goal))}))`];
    const status = (await executeZ3(lines.join("\n"), z3)).status;
    return status === "unsat" ? "verified" : status === "sat" ? "counterexample" : "unknown";
  } catch {
    return "unknown";
  }
}

function typeAssumptions(parameters: readonly ts.ParameterDeclaration[], source: ts.SourceFile): string[] {
  return parameters.flatMap((parameter) => {
    if (!ts.isIdentifier(parameter.name)) return [];
    const type = parameter.type?.getText(source), name = parameter.name.text;
    if (type === "Nat") return [`${name} >= 0`];
    if (type === "U8") return [`${name} >= 0`, `${name} <= 255`];
    return [];
  });
}

function boundedMaximum(type: ts.TypeNode | undefined, source: ts.SourceFile, constants: ReadonlyMap<string, number>): { maximum: number; constructor: "Uint8Array" | "Uint32Array" } | undefined {
  if (!type || !ts.isTypeReferenceNode(type) || type.typeArguments?.length !== 1) return undefined;
  const name = type.typeName.getText(source);
  if (name !== "BoundedUint8Array" && name !== "BoundedUint32Array") return undefined;
  const argument = type.typeArguments[0];
  const maximum = argument && ts.isLiteralTypeNode(argument) && ts.isNumericLiteral(argument.literal) ? Number(argument.literal.text)
    : argument && ts.isTypeQueryNode(argument) && ts.isIdentifier(argument.exprName) ? constants.get(argument.exprName.text) : undefined;
  return maximum === undefined ? undefined : { maximum, constructor: name === "BoundedUint8Array" ? "Uint8Array" : "Uint32Array" };
}

function boundedTypeMaximum(type: string, constants: ReadonlyMap<string, number>): number | undefined {
  const match = /^BoundedUint(?:8|32)Array<\s*(\d+)\s*>$/.exec(type);
  if (match) return Number(match[1]);
  const query = /^BoundedUint(?:8|32)Array<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>$/.exec(type);
  return query ? constants.get(query[1]!) : undefined;
}
function boundedDataViewMaximum(type: string, constants: ReadonlyMap<string, number>): number | undefined {
  const literal = /^BoundedDataView<\s*(\d+)\s*>$/.exec(type);
  if (literal) return Number(literal[1]);
  const query = /^BoundedDataView<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>$/.exec(type);
  return query ? constants.get(query[1]!) : undefined;
}
function fixedArrayBufferBytes(type: string, constants: ReadonlyMap<string, number>): number | undefined {
  const literal = /^FixedArrayBuffer<\s*(\d+)\s*>$/.exec(type);
  if (literal) return Number(literal[1]);
  const query = /^FixedArrayBuffer<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>$/.exec(type);
  return query ? constants.get(query[1]!) : undefined;
}
function boundedDataViewReturnMaximum(type: ts.TypeNode | undefined, source: ts.SourceFile, constants: ReadonlyMap<string, number>): number | undefined {
  return type ? boundedDataViewMaximum(type.getText(source), constants) : undefined;
}
interface DataViewMethod {
  width: number;
  value?: { minimum: number; maximum: number; kind: "u8-write" | "u32-write" | "dataview-value" };
}
const DATA_VIEW_METHODS = new Map<string, DataViewMethod>([
  ["getInt8", { width: 1 }], ["getUint8", { width: 1 }],
  ["getInt16", { width: 2 }], ["getUint16", { width: 2 }],
  ["getInt32", { width: 4 }], ["getUint32", { width: 4 }], ["getFloat32", { width: 4 }],
  ["getBigInt64", { width: 8 }], ["getBigUint64", { width: 8 }], ["getFloat64", { width: 8 }],
  ["setInt8", { width: 1, value: { minimum: -0x80, maximum: 0x7f, kind: "dataview-value" } }],
  ["setUint8", { width: 1, value: { minimum: 0, maximum: 0xff, kind: "u8-write" } }],
  ["setInt16", { width: 2, value: { minimum: -0x8000, maximum: 0x7fff, kind: "dataview-value" } }],
  ["setUint16", { width: 2, value: { minimum: 0, maximum: 0xffff, kind: "dataview-value" } }],
  ["setInt32", { width: 4, value: { minimum: -0x8000_0000, maximum: 0x7fff_ffff, kind: "dataview-value" } }],
  ["setUint32", { width: 4, value: { minimum: 0, maximum: 0xffff_ffff, kind: "u32-write" } }],
  ["setFloat32", { width: 4 }], ["setBigInt64", { width: 8 }], ["setBigUint64", { width: 8 }], ["setFloat64", { width: 8 }],
]);
function typedArrayElement(type: string): "u8" | "u32" | undefined {
  if (/^(?:Bounded)?Uint8Array(?:<.*>)?$/.test(type)) return "u8";
  if (/^(?:Bounded)?Uint32Array(?:<.*>)?$/.test(type)) return "u32";
  return undefined;
}

interface NumericRange { minimum: number; maximum: number; integer: boolean }
interface ConstantTable { length: number; domain: "u8" | "u32"; valid: boolean }
interface TypedArraySemantics {
  integerCasts: ReadonlyMap<number, "floor" | "ceil" | "round" | "trunc">;
  integerOperations?: ReadonlyMap<number, "imul" | "clz32" | "fround">;
  /** Declaration start -> inherited DataView type, or null for an unsafe alias. */
  dataViewAliases?: ReadonlyMap<number, string | null>;
  /** Identifier source start -> declaration identity. */
  bindingKeys?: ReadonlyMap<number, string>;
  /** Module constant spelling -> declaration identity. */
  constantKeys?: ReadonlyMap<string, string>;
}

function bindingKey(identifier: ts.Identifier, semantics?: TypedArraySemantics): string {
  return semantics?.bindingKeys?.get(identifier.getStart()) ?? identifier.text;
}

interface TypedArrayTrust {
  assumptionId?: string;
  reason: string;
  owner?: string;
  expiresOn?: string;
  reviewDigest?: string;
}

function typedArrayTrust(text: string, kind?: TypedArrayObligation["kind"], registry?: AssumptionRegistry): TypedArrayTrust | undefined {
  const value = extractAnnotations(text, "trust").find((item) => {
    const match = /^typed-array(?::([a-z0-9-]+))?\s+(.+)$/i.exec(item);
    return match && (!match[1] || match[1] === kind);
  });
  const match = value && /^typed-array(?::[a-z0-9-]+)?\s+(.+)$/i.exec(value);
  if (!match) return undefined;
  const authenticated = resolveAssumptionRecord(registry, match[1]!.trim(), "typed-array");
  if (authenticated) return {
    assumptionId: authenticated.id,
    reason: authenticated.reason,
    owner: authenticated.owner,
    ...(authenticated.expiresOn ? { expiresOn: authenticated.expiresOn } : {}),
    reviewDigest: authenticated.reviewDigest,
  };
  return undefined;
}

function enclosingStatement(node: ts.Node, owner: ts.FunctionDeclaration): ts.Statement | undefined {
  for (let current: ts.Node | undefined = node; current && current !== owner; current = current.parent) {
    if (ts.isStatement(current)) return current;
  }
  return undefined;
}

function contractParameterRanges(parameters: readonly ts.ParameterDeclaration[], source: ts.SourceFile, assumptions: readonly string[]): Map<string, NumericRange> {
  const ranges = new Map<string, NumericRange>();
  for (const parameter of parameters) if (ts.isIdentifier(parameter.name)) {
    const type = parameter.type?.getText(source);
    if (type === "Int") ranges.set(parameter.name.text, { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, integer: true });
    if (type === "Nat") ranges.set(parameter.name.text, { minimum: 0, maximum: Number.POSITIVE_INFINITY, integer: true });
    if (type === "U8") ranges.set(parameter.name.text, { minimum: 0, maximum: 0xff, integer: true });
    if (type === "U32") ranges.set(parameter.name.text, { minimum: 0, maximum: 0xffff_ffff, integer: true });
  }
  const parameterNames = new Set(parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
  const update = (name: string, operator: string, value: number): void => {
    if (!parameterNames.has(name)) return;
    const current = ranges.get(name);
    if (!current?.integer) return;
    if (operator === "<=") current.maximum = Math.min(current.maximum, value);
    if (operator === "<") current.maximum = Math.min(current.maximum, value - 1);
    if (operator === ">=") current.minimum = Math.max(current.minimum, value);
    if (operator === ">") current.minimum = Math.max(current.minimum, value + 1);
  };
  const number = "-?(?:0[xX][0-9a-fA-F]+|[0-9]+)";
  for (const assumption of assumptions) {
    for (const match of assumption.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*(<=|<|>=|>)\\s*(${number})\\b`, "g"))) {
      update(match[1]!, match[2]!, Number(match[3]));
    }
    for (const match of assumption.matchAll(new RegExp(`(^|[^\\w$])(${number})\\s*(<=|<|>=|>)\\s*([A-Za-z_$][\\w$]*)\\b`, "g"))) {
      const reversed = new Map([["<=", ">="], ["<", ">"], [">=", "<="], [">", "<"]]).get(match[3]!);
      update(match[4]!, reversed!, Number(match[2]));
    }
  }
  return ranges;
}

function tableReferenceName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) return `${expression.expression.text}.${expression.name.text}`;
  return undefined;
}

function constantTableDeclaration(declaration: ts.VariableDeclaration, source: ts.SourceFile): { expression: ts.Expression; domain: "u8" | "u32" } | undefined {
  let expression = declaration.initializer;
  let contract = declaration.type?.getText(source);
  if (expression && ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && (expression.expression.text === "u8Table" || expression.expression.text === "u32Table") && expression.arguments[0]) {
    const domain = expression.expression.text === "u8Table" ? "u8" : "u32";
    let argument = expression.arguments[0];
    while (ts.isAsExpression(argument) || ts.isParenthesizedExpression(argument)) argument = argument.expression;
    return ts.isArrayLiteralExpression(argument) || ts.isCallExpression(argument) ? { expression: argument, domain } : undefined;
  }
  if (expression && ts.isSatisfiesExpression(expression)) {
    contract = expression.type.getText(source);
    expression = expression.expression;
  }
  while (expression && (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression))) expression = expression.expression;
  if (!expression || !contract || (!ts.isArrayLiteralExpression(expression) && !ts.isCallExpression(expression))) return undefined;
  const compact = contract.replace(/\s+/g, "");
  const match = /^(?:readonly(?:U8|U32)\[\]|ReadonlyArray<(?:U8|U32)>)$/.exec(compact);
  if (!match) return undefined;
  return { expression, domain: compact.includes("U8") ? "u8" : "u32" };
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)
    ? unwrapTransparentExpression(expression.expression) : expression;
}

function constantNumber(expression: ts.Expression, constants: ReadonlyMap<string, number>): number | undefined {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return constantNumber(expression.expression, constants);
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (ts.isIdentifier(expression)) return constants.get(expression.text);
  if (ts.isPrefixUnaryExpression(expression)) {
    const value = constantNumber(expression.operand, constants);
    if (value === undefined) return undefined;
    if (expression.operator === ts.SyntaxKind.MinusToken) return -value;
    if (expression.operator === ts.SyntaxKind.PlusToken) return value;
    if (expression.operator === ts.SyntaxKind.TildeToken) return ~value;
  }
  if (!ts.isBinaryExpression(expression)) return undefined;
  const left = constantNumber(expression.left, constants), right = constantNumber(expression.right, constants);
  if (left === undefined || right === undefined) return undefined;
  const operations = new Map<ts.SyntaxKind, (a: number, b: number) => number>([
    [ts.SyntaxKind.PlusToken, (a, b) => a + b], [ts.SyntaxKind.MinusToken, (a, b) => a - b], [ts.SyntaxKind.AsteriskToken, (a, b) => a * b],
    [ts.SyntaxKind.SlashToken, (a, b) => a / b], [ts.SyntaxKind.PercentToken, (a, b) => a % b], [ts.SyntaxKind.LessThanLessThanToken, (a, b) => a << b],
    [ts.SyntaxKind.GreaterThanGreaterThanToken, (a, b) => a >> b], [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, (a, b) => a >>> b],
    [ts.SyntaxKind.AmpersandToken, (a, b) => a & b], [ts.SyntaxKind.BarToken, (a, b) => a | b], [ts.SyntaxKind.CaretToken, (a, b) => a ^ b],
  ]);
  return operations.get(expression.operatorToken.kind)?.(left, right);
}

function collectConstants(source: ts.SourceFile): Map<string, number> {
  const constants = new Map<string, number>([["U8_BITS", 8], ["U8_MAX", 0xff], ["U32_BITS", 32], ["U32_MAX", 0xffff_ffff], ["I32_MIN", -0x8000_0000], ["I32_MAX", 0x7fff_ffff], ["F32_BITS", 32]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of source.statements) if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || constants.has(declaration.name.text)) continue;
      const value = constantNumber(declaration.initializer, constants);
      if (value !== undefined && Number.isFinite(value)) { constants.set(declaration.name.text, value); changed = true; }
    }
  }
  return constants;
}

function hasShadowedBindings(functionNode: ts.FunctionDeclaration): boolean {
  const names = new Set<string>();
  let shadowed = false;
  const addName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (names.has(name.text)) shadowed = true;
      names.add(name.text);
    } else for (const element of name.elements) if (ts.isBindingElement(element)) addName(element.name);
  };
  functionNode.parameters.forEach((parameter) => addName(parameter.name));
  const visit = (node: ts.Node): void => {
    if (node !== functionNode.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) addName(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) addName(node.name);
    ts.forEachChild(node, visit);
  };
  if (functionNode.body) visit(functionNode.body);
  return shadowed;
}

function collectConstantTables(source: ts.SourceFile, constants: ReadonlyMap<string, number>, seed: ReadonlyMap<string, ConstantTable> = new Map()): Map<string, ConstantTable> {
  const tables = new Map<string, ConstantTable>(seed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of source.statements) if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const table = constantTableDeclaration(declaration, source);
      if (!table) continue;
      const upper = table.domain === "u8" ? 255 : 0xffff_ffff;
      let length = 0, valid = true, unresolved = false;
      if (ts.isArrayLiteralExpression(table.expression)) {
        for (const element of table.expression.elements) {
          if (ts.isSpreadElement(element)) {
            const reference = tableReferenceName(element.expression), spread = reference ? tables.get(reference) : undefined;
            if (!spread) { unresolved = true; break; }
            length += spread.length;
            valid &&= spread.valid && spread.domain === table.domain;
          } else {
            const value = constantNumber(element, constants);
            length++;
            valid &&= value !== undefined && Number.isInteger(value) && value >= 0 && value <= upper;
          }
        }
      } else {
        const call = ts.isCallExpression(table.expression) ? table.expression : undefined;
        const arrayFrom = call && ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
          && call.expression.expression.text === "Array" && call.expression.name.text === "from";
        const sourceArgument = call?.arguments[0], callback = call?.arguments[1];
        const lengthProperty = sourceArgument && ts.isObjectLiteralExpression(sourceArgument)
          ? sourceArgument.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText(source) === "length") : undefined;
        const generatedLength = lengthProperty ? constantNumber(lengthProperty.initializer, constants) : undefined;
        const indexParameter = callback && ts.isArrowFunction(callback) && callback.parameters[1] && ts.isIdentifier(callback.parameters[1].name)
          ? callback.parameters[1].name.text : undefined;
        if (!arrayFrom || generatedLength === undefined || !Number.isSafeInteger(generatedLength) || generatedLength < 0 || generatedLength > 10_000
          || !callback || !ts.isArrowFunction(callback) || !indexParameter || !ts.isExpression(callback.body)) {
          unresolved = true;
        } else {
          length = generatedLength;
          for (let index = 0; index < length; index++) {
            const value = constantNumber(callback.body, new Map(constants).set(indexParameter, index));
            valid &&= value !== undefined && Number.isInteger(value) && value >= 0 && value <= upper;
          }
        }
      }
      if (unresolved) continue;
      const previous = tables.get(declaration.name.text);
      if (!previous || previous.length !== length || previous.domain !== table.domain || previous.valid !== valid) {
        tables.set(declaration.name.text, { length, domain: table.domain, valid });
        changed = true;
      }
    }
  }
  return tables;
}

function expressionRange(expression: ts.Expression, parameterTypes: ReadonlyMap<string, string>, constants: ReadonlyMap<string, number>, tables: ReadonlyMap<string, ConstantTable>, locals: ReadonlyMap<string, NumericRange> = new Map(), semantics?: TypedArraySemantics): NumericRange | undefined {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) return expressionRange(expression.expression, parameterTypes, constants, tables, locals, semantics);
  if (ts.isNumericLiteral(expression)) { const value = Number(expression.text); return { minimum: value, maximum: value, integer: Number.isInteger(value) }; }
  if (ts.isIdentifier(expression)) {
    const key = bindingKey(expression, semantics);
    const constant = !semantics?.bindingKeys || semantics.constantKeys?.get(expression.text) === key
      ? constants.get(expression.text) : undefined;
    if (constant !== undefined) return { minimum: constant, maximum: constant, integer: Number.isInteger(constant) };
    const local = locals.get(key);
    if (local) return local;
    const type = parameterTypes.get(key);
    return type === "U8" ? { minimum: 0, maximum: 255, integer: true } : type === "U32" ? { minimum: 0, maximum: 0xffff_ffff, integer: true } : type === "Nat" ? { minimum: 0, maximum: Number.POSITIVE_INFINITY, integer: true } : undefined;
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "length") {
    const reference = tableReferenceName(expression.expression);
    const table = reference ? tables.get(reference) : undefined;
    if (table) return { minimum: table.length, maximum: table.length, integer: true };
    if (!ts.isIdentifier(expression.expression)) return undefined;
    const maximum = boundedTypeMaximum(parameterTypes.get(bindingKey(expression.expression, semantics)) ?? "", constants);
    return maximum === undefined ? undefined : { minimum: 0, maximum, integer: true };
  }
  if (ts.isElementAccessExpression(expression)) {
    const reference = tableReferenceName(expression.expression);
    const table = reference ? tables.get(reference) : undefined;
    if (table?.valid) return table.domain === "u8" ? { minimum: 0, maximum: 255, integer: true } : { minimum: 0, maximum: 0xffff_ffff, integer: true };
  }
  const semanticCast = ts.isCallExpression(expression) ? semantics?.integerCasts.get(expression.getStart()) : undefined;
  const sourceCast = ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.expression.getText() === "Math" && !parameterTypes.has("Math")
    && ["floor", "ceil", "round", "trunc"].includes(expression.expression.name.text)
    ? expression.expression.name.text as "floor" | "ceil" | "round" | "trunc" : undefined;
  const integerCast = semantics ? semanticCast : sourceCast;
  if (ts.isCallExpression(expression) && integerCast && expression.arguments.length === 1) {
    const input = expressionRange(expression.arguments[0]!, parameterTypes, constants, tables, locals, semantics);
    if (!input) return undefined;
    const operation = Math[integerCast];
    return { minimum: operation(input.minimum), maximum: operation(input.maximum), integer: true };
  }
  const semanticIntegerOperation = ts.isCallExpression(expression) ? semantics?.integerOperations?.get(expression.getStart()) : undefined;
  const sourceIntegerOperation = ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.expression.getText() === "Math" && !parameterTypes.has("Math")
    && ["imul", "clz32", "fround"].includes(expression.expression.name.text)
    ? expression.expression.name.text as "imul" | "clz32" | "fround" : undefined;
  const integerOperation = semantics ? semanticIntegerOperation : sourceIntegerOperation;
  if (ts.isCallExpression(expression) && integerOperation === "imul" && expression.arguments.length === 2) {
    return { minimum: -0x8000_0000, maximum: 0x7fff_ffff, integer: true };
  }
  if (ts.isCallExpression(expression) && integerOperation === "clz32" && expression.arguments.length === 1) {
    return { minimum: 0, maximum: 32, integer: true };
  }
  if (ts.isCallExpression(expression) && integerOperation === "fround" && expression.arguments.length === 1) {
    const input = expressionRange(expression.arguments[0]!, parameterTypes, constants, tables, locals, semantics);
    if (!input || !Number.isFinite(input.minimum) || !Number.isFinite(input.maximum)
      || Math.abs(input.minimum) > 3.4028234663852886e38 || Math.abs(input.maximum) > 3.4028234663852886e38) return undefined;
    return {
      minimum: Math.fround(input.minimum), maximum: Math.fround(input.maximum),
      integer: input.integer && Math.max(Math.abs(input.minimum), Math.abs(input.maximum)) <= 0x1_000000,
    };
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.arguments.length === 1) {
    if (expression.expression.text === "u8") return { minimum: 0, maximum: 255, integer: true };
    if (["u32", "toU32"].includes(expression.expression.text)) return { minimum: 0, maximum: 0xffff_ffff, integer: true };
    if (expression.expression.text === "i32") return { minimum: -0x8000_0000, maximum: 0x7fff_ffff, integer: true };
  }
  if (!ts.isBinaryExpression(expression)) return undefined;
  const rightLiteral = constantNumber(expression.right, constants);
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandToken && ts.isPrefixUnaryExpression(expression.right)
    && expression.right.operator === ts.SyntaxKind.TildeToken) {
    const maskSource = constantNumber(expression.right.operand, constants), alignment = (maskSource ?? -1) + 1, left = expressionRange(expression.left, parameterTypes, constants, tables, locals, semantics);
    if (left && left.minimum >= 0 && left.maximum <= 0x7fff_ffff && alignment > 0 && Number.isInteger(Math.log2(alignment))) {
      return { minimum: 0, maximum: Math.floor(left.maximum / alignment) * alignment, integer: true };
    }
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken && rightLiteral !== undefined && Number.isInteger(rightLiteral) && rightLiteral >= 0 && rightLiteral <= 31) {
    return { minimum: 0, maximum: 2 ** (32 - rightLiteral) - 1, integer: true };
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandToken && rightLiteral !== undefined && Number.isInteger(rightLiteral) && rightLiteral >= 0 && rightLiteral <= 0x7fff_ffff) {
    return { minimum: 0, maximum: rightLiteral, integer: true };
  }
  if ([ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken].includes(expression.operatorToken.kind)) {
    return { minimum: -0x8000_0000, maximum: 0x7fff_ffff, integer: true };
  }
  const left = expressionRange(expression.left, parameterTypes, constants, tables, locals, semantics), right = expressionRange(expression.right, parameterTypes, constants, tables, locals, semantics);
  if (!left || !right) return undefined;
  if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return { minimum: left.minimum + right.minimum, maximum: left.maximum + right.maximum, integer: left.integer && right.integer };
  if (expression.operatorToken.kind === ts.SyntaxKind.MinusToken) return { minimum: left.minimum - right.maximum, maximum: left.maximum - right.minimum, integer: left.integer && right.integer };
  return undefined;
}

function enclosingLoopAssumptions(current: ts.Node, owner: ts.FunctionDeclaration, source: ts.SourceFile): string[] {
  const facts: string[] = [];
  for (let parent = current.parent; parent && parent !== owner; parent = parent.parent) {
    if (!ts.isForStatement(parent)) continue;
    if (parent.condition) facts.push(parent.condition.getText(source));
    const declaration = parent.initializer && ts.isVariableDeclarationList(parent.initializer) ? parent.initializer.declarations[0] : undefined;
    if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const incrementor = parent.incrementor;
    if ((incrementor && (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) && incrementor.operator === ts.SyntaxKind.PlusPlusToken)
      || (incrementor && ts.isBinaryExpression(incrementor) && incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
      facts.push(`${declaration.name.text} >= ${declaration.initializer.getText(source)}`);
    }
  }
  return facts;
}

async function verifyTypedArraySafetyWithTables(fileName: string, text: string, importedTables: ReadonlyMap<string, ConstantTable>, semantics?: TypedArraySemantics, z3?: Z3ExecutionOptions, assumptionRegistry?: AssumptionRegistry): Promise<TypedArraySafetyResult> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), obligations: TypedArrayObligation[] = [], diagnostics: TypedArrayDiagnostic[] = [];
  let solverQueries = 0;
  const constants = collectConstants(source);
  const tables = collectConstantTables(source, constants, importedTables);
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const table = constantTableDeclaration(declaration, source);
    if (!table) continue;
    const metadata = tables.get(declaration.name.text);
    if (!metadata) continue;
    const valid = metadata.valid;
    const span = { start: declaration.getStart(source), end: declaration.getEnd() };
    const goal = `${declaration.name.text} elements are ${table.domain.toUpperCase()}`;
    obligations.push({ functionName: "<module>", kind: "constant-table-values", result: valid ? "verified" : "counterexample", goal, span });
    if (!valid) diagnostics.push({ fileName, functionName: "<module>", kind: "constant-table-values", span, message: `constant-table-values constraint may fail: ${goal}` });
  }
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    const functionName = node.name.text, leading = source.text.slice(node.getFullStart(), node.getStart(source));
    const shadowedBindings = hasShadowedBindings(node);
    const functionTrust = typedArrayTrust(leading, undefined, assumptionRegistry);
    const tableLengths = new Map([...tables].map(([name, table]) => [`${name}.length`, String(table.length)]));
    const assumptions = [...extractAnnotations(leading, "requires"), ...typeAssumptions(node.parameters, source)]
      .map((assumption) => [...tableLengths].reduce((text, [name, length]) => text.replaceAll(name, length), assumption));
    const bounded = boundedMaximum(node.type, source, constants), parameterTypes = new Map(node.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [[bindingKey(parameter.name, semantics), parameter.type?.getText(source) ?? ""] as const] : []));
    const boundedView = boundedDataViewReturnMaximum(node.type, source, constants);
    const localRanges = contractParameterRanges(node.parameters, source, assumptions);
    let localChanged = true;
    while (localChanged) {
      localChanged = false;
      const collectLocal = (current: ts.Node): void => {
        if (current !== node.body && ts.isFunctionLike(current)) return;
        if (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current.parent)
          && (current.parent.flags & ts.NodeFlags.Const) && ts.isIdentifier(current.name) && current.initializer && !localRanges.has(bindingKey(current.name, semantics))) {
          const range = expressionRange(current.initializer, parameterTypes, constants, tables, localRanges, semantics);
          if (range) { localRanges.set(bindingKey(current.name, semantics), range); localChanged = true; }
        }
        ts.forEachChild(current, collectLocal);
      };
      collectLocal(node.body);
    }
    const dataViewTypes = new Map([...parameterTypes].filter(([, type]) => boundedDataViewMaximum(type, constants) !== undefined));
    const fixedBufferTypes = new Map([...parameterTypes].filter(([, type]) => fixedArrayBufferBytes(type, constants) !== undefined));
    const typedArrayTypes = new Map([...parameterTypes].filter(([, type]) => typedArrayElement(type) !== undefined));
    let aliasChanged = true;
    while (aliasChanged) {
      aliasChanged = false;
      const collectAlias = (current: ts.Node): void => {
        if (current !== node.body && ts.isFunctionLike(current)) return;
        if (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current.parent)
          && (current.parent.flags & ts.NodeFlags.Const) && ts.isIdentifier(current.name)) {
          const explicit = current.type?.getText(source);
          const semanticAlias = semantics?.dataViewAliases?.get(current.getStart(source));
          let constructedView: string | undefined;
          if (current.initializer && ts.isNewExpression(current.initializer)
            && current.initializer.expression.getText(source) === "DataView" && current.initializer.arguments?.[0]) {
            const [buffer, offset, length] = current.initializer.arguments;
            const bufferMaximum = buffer && ts.isIdentifier(buffer) ? fixedArrayBufferBytes(fixedBufferTypes.get(bindingKey(buffer, semantics)) ?? "", constants) : undefined;
            const offsetConstant = offset ? constantNumber(offset, constants) : 0;
            const lengthConstant = length ? constantNumber(length, constants)
              : bufferMaximum !== undefined && offsetConstant !== undefined ? bufferMaximum - offsetConstant : undefined;
            if (lengthConstant !== undefined && Number.isSafeInteger(lengthConstant) && lengthConstant >= 0) constructedView = `BoundedDataView<${lengthConstant}>`;
          }
          const inherited = semanticAlias === null ? "__uneffect_unknown_dataview_alias__"
            : semanticAlias ?? constructedView ?? (current.initializer && ts.isIdentifier(current.initializer) ? dataViewTypes.get(bindingKey(current.initializer, semantics)) : undefined);
          const type = semanticAlias === null ? inherited
            : explicit && boundedDataViewMaximum(explicit, constants) !== undefined ? explicit : inherited;
          const currentKey = bindingKey(current.name, semantics);
          if (type && !dataViewTypes.has(currentKey)) { dataViewTypes.set(currentKey, type); aliasChanged = true; }
          const inheritedBuffer = current.initializer && ts.isIdentifier(current.initializer) ? fixedBufferTypes.get(bindingKey(current.initializer, semantics)) : undefined;
          const bufferType = explicit && fixedArrayBufferBytes(explicit, constants) !== undefined ? explicit : inheritedBuffer;
          if (bufferType && !fixedBufferTypes.has(currentKey)) { fixedBufferTypes.set(currentKey, bufferType); aliasChanged = true; }
          let windowType: string | undefined;
          let attemptedWindow = false;
          if (current.initializer && ts.isCallExpression(current.initializer)
            && ts.isPropertyAccessExpression(current.initializer.expression)
            && ["subarray", "slice"].includes(current.initializer.expression.name.text)
            && ts.isIdentifier(current.initializer.expression.expression)) {
            const receiverType = typedArrayTypes.get(bindingKey(current.initializer.expression.expression, semantics)) ?? "";
            const maximum = boundedTypeMaximum(receiverType, constants);
            attemptedWindow = maximum !== undefined;
            const start = current.initializer.arguments[0] ? constantNumber(current.initializer.arguments[0]!, constants) : 0;
            const end = current.initializer.arguments[1] ? constantNumber(current.initializer.arguments[1]!, constants) : maximum;
            const element = typedArrayElement(receiverType);
            if (maximum !== undefined && start !== undefined && end !== undefined
              && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end <= maximum && element) {
              windowType = `BoundedUint${element === "u8" ? "8" : "32"}Array<${end - start}>`;
            }
          }
          const inheritedArray = current.initializer && ts.isIdentifier(current.initializer) ? typedArrayTypes.get(bindingKey(current.initializer, semantics)) : undefined;
          const arrayType = explicit && typedArrayElement(explicit) !== undefined ? explicit
            : windowType ?? (attemptedWindow ? "__uneffect_unknown_typed_array_window__" : inheritedArray);
          if (arrayType && !typedArrayTypes.has(currentKey)) { typedArrayTypes.set(currentKey, arrayType); aliasChanged = true; }
        }
        ts.forEachChild(current, collectAlias);
      };
      collectAlias(node.body);
    }
    const candidates: Array<{ kind: TypedArrayObligation["kind"]; goal: string; node: ts.Node; value?: ts.Expression; lower?: number; upper?: number; assumptions?: string[]; requiresInteger?: boolean; knownResult?: "verified" | "counterexample" | "unknown" }> = [];
    const visit = (current: ts.Node): void => {
      if (current !== node && ts.isFunctionLike(current)) return;
      const returned = ts.isReturnStatement(current) && current.expression
        ? unwrapTransparentExpression(current.expression) : undefined;
      if (bounded && returned && ts.isNewExpression(returned)
        && returned.expression.getText(source) === bounded.constructor && returned.arguments?.length === 1) {
        const length = returned.arguments[0]!;
        candidates.push({ kind: "max-length", goal: `${length.getText(source)} >= 0 && ${length.getText(source)} <= ${bounded.maximum}`, node: length, value: length, upper: bounded.maximum });
      }
      const construction = returned && ts.isNewExpression(returned) && returned.expression.getText(source) === "DataView" && returned.arguments?.[0]
        ? returned
        : ts.isNewExpression(current) && current.expression.getText(source) === "DataView" && current.arguments?.[0] ? current : undefined;
      const trackedLocalView = construction && ts.isVariableDeclaration(construction.parent)
        && construction.parent.initializer === construction && ts.isIdentifier(construction.parent.name)
        && dataViewTypes.has(bindingKey(construction.parent.name, semantics));
      if (construction && (trackedLocalView || returned === construction && boundedView !== undefined)) {
        const argumentsList = construction.arguments!;
        const buffer = argumentsList[0]!;
        const bufferMaximum = ts.isIdentifier(buffer) ? fixedArrayBufferBytes(fixedBufferTypes.get(bindingKey(buffer, semantics)) ?? "", constants) : undefined;
        const offset = argumentsList[1];
        const length = argumentsList[2];
        const offsetText = offset?.getText(source) ?? "0";
        const offsetConstant = offset ? constantNumber(offset, constants) : 0;
        if (bufferMaximum === undefined) {
          candidates.push({ kind: "dataview-backing-bounds", goal: "false", node: buffer, knownResult: "counterexample" });
        } else if (length) {
          const lengthText = length.getText(source);
          const lengthConstant = constantNumber(length, constants);
          candidates.push({
            kind: "dataview-backing-bounds",
            goal: `${offsetText} >= 0 && ${lengthText} >= 0 && ${offsetText} + ${lengthText} <= ${bufferMaximum}`,
            node: construction,
            ...(offsetConstant !== undefined && lengthConstant !== undefined ? {
              knownResult: offsetConstant >= 0 && lengthConstant >= 0 && offsetConstant + lengthConstant <= bufferMaximum ? "verified" as const : "counterexample" as const,
            } : {}),
          });
          if (returned === construction && boundedView !== undefined) candidates.push({ kind: "max-length", goal: `${lengthText} >= 0 && ${lengthText} <= ${boundedView}`, node: length, value: length, upper: boundedView, requiresInteger: true });
        } else {
          candidates.push({
            kind: "dataview-backing-bounds", goal: `${offsetText} >= 0 && ${offsetText} <= ${bufferMaximum}`, node: construction,
            ...(offsetConstant !== undefined ? { knownResult: offsetConstant >= 0 && offsetConstant <= bufferMaximum ? "verified" as const : "counterexample" as const } : {}),
          });
          if (returned === construction && boundedView !== undefined) candidates.push({
            kind: "max-length", goal: `${bufferMaximum} - ${offsetText} <= ${boundedView}`, node: construction,
            ...(offsetConstant !== undefined ? { knownResult: bufferMaximum - offsetConstant <= boundedView ? "verified" as const : "counterexample" as const } : {}),
          });
        }
      }
      if (ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isElementAccessExpression(current.left)) {
        const target = current.left.expression;
        const type = ts.isIdentifier(target) ? typedArrayTypes.get(bindingKey(target, semantics)) ?? "" : "";
        const kind = type === "Uint8Array" || type.startsWith("BoundedUint8Array<") ? "u8-write" : type === "Uint32Array" || type.startsWith("BoundedUint32Array<") ? "u32-write" : undefined;
        if (kind) {
          const value = current.operatorToken.kind === ts.SyntaxKind.EqualsToken ? current.right.getText(source) : current.getText(source);
          const upper = kind === "u8-write" ? 255 : 0xffff_ffff;
          candidates.push({ kind, goal: `${value} >= 0 && ${value} <= ${upper}`, node: current, value: current.operatorToken.kind === ts.SyntaxKind.EqualsToken ? current.right : undefined, upper, requiresInteger: true });
        }
      }
      if (ts.isElementAccessExpression(current) && current.argumentExpression) {
        const reference = tableReferenceName(current.expression);
        const identifier = ts.isIdentifier(current.expression) ? current.expression : undefined;
        const type = identifier ? typedArrayTypes.get(bindingKey(identifier, semantics)) ?? "" : "", targetMaximum = boundedTypeMaximum(type, constants);
        if (type === "__uneffect_unknown_typed_array_window__") {
          candidates.push({ kind: "index-bounds", goal: "statically bounded typed-array window", node: current.argumentExpression, knownResult: "unknown" });
        }
        if (targetMaximum !== undefined) {
          const index = current.argumentExpression;
          candidates.push({ kind: "index-bounds", goal: `${index.getText(source)} >= 0 && ${index.getText(source)} < ${targetMaximum}`, node: index, value: index, upper: targetMaximum - 1, assumptions: enclosingLoopAssumptions(current, node, source) });
        }
        const table = reference ? tables.get(reference) : undefined;
        if (table) {
          const index = current.argumentExpression;
          candidates.push({ kind: "constant-table-index", goal: `${index.getText(source)} >= 0 && ${index.getText(source)} < ${table.length}`, node: index, value: index, upper: table.length - 1, assumptions: enclosingLoopAssumptions(current, node, source) });
        }
      }
      if (ts.isBinaryExpression(current) && [ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken].includes(current.operatorToken.kind)) {
        candidates.push({ kind: "shift-count", goal: `${current.right.getText(source)} >= 0 && ${current.right.getText(source)} <= 31`, node: current.right, value: current.right, upper: 31 });
      }
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
        && ts.isIdentifier(current.expression.expression) && current.arguments[0]) {
        const method = DATA_VIEW_METHODS.get(current.expression.name.text);
        const receiverType = dataViewTypes.get(bindingKey(current.expression.expression, semantics)) ?? "";
        const maximum = boundedDataViewMaximum(receiverType, constants);
        if (method && receiverType === "__uneffect_unknown_dataview_alias__") {
          candidates.push({ kind: "dataview-bounds", goal: "stable DataView alias", node: current.expression.expression, knownResult: "unknown" });
        }
        if (method && maximum !== undefined) {
          const offset = current.arguments[0]!;
          candidates.push({
            kind: "dataview-bounds", goal: `${offset.getText(source)} >= 0 && ${offset.getText(source)} + ${method.width} <= ${maximum}`,
            node: offset, value: offset, upper: maximum - method.width, requiresInteger: true,
          });
          const value = current.arguments[1];
          if (method.value && value) candidates.push({
            kind: method.value.kind,
            goal: `${value.getText(source)} >= ${method.value.minimum} && ${value.getText(source)} <= ${method.value.maximum}`,
            node: value, value, lower: method.value.minimum, upper: method.value.maximum, requiresInteger: true,
          });
        }
      }
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === "set"
        && ts.isIdentifier(current.expression.expression) && current.arguments[0]) {
        const targetType = typedArrayTypes.get(bindingKey(current.expression.expression, semantics)) ?? "", targetMaximum = boundedTypeMaximum(targetType, constants);
        if (targetMaximum !== undefined) {
          const sourceExpression = current.arguments[0]!, sourceType = ts.isIdentifier(sourceExpression) ? typedArrayTypes.get(bindingKey(sourceExpression, semantics)) ?? "" : "";
          const sourceMaximum = boundedTypeMaximum(sourceType, constants), offset = current.arguments[1];
          const offsetText = offset?.getText(source) ?? "0";
          const sourceLength = sourceMaximum ?? `${sourceExpression.getText(source)}.length`;
          candidates.push({
            kind: "bulk-copy-bounds",
            goal: `${offsetText} >= 0 && ${offsetText} + ${sourceLength} <= ${targetMaximum}`,
            node: current,
            ...(sourceMaximum !== undefined && offset ? { value: offset, upper: targetMaximum - sourceMaximum } : {}),
          });
          const targetElement = typedArrayElement(targetType), sourceElement = typedArrayElement(sourceType);
          if (targetElement && sourceElement && targetElement !== sourceElement) candidates.push({ kind: "bulk-copy-values", goal: "false", node: current });
        }
      }
      if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
        && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)
        && ts.isElementAccessExpression(current.operand)) {
        const target = current.operand.expression.getText(source), parameter = node.parameters.find((item) => ts.isIdentifier(item.name) && item.name.text === target);
        const type = parameter?.type?.getText(source) ?? "";
        const kind = type === "Uint8Array" || type.startsWith("BoundedUint8Array<") ? "u8-write" : type === "Uint32Array" || type.startsWith("BoundedUint32Array<") ? "u32-write" : undefined;
        if (kind) candidates.push({ kind, goal: `${current.getText(source)} >= 0 && ${current.getText(source)} <= ${kind === "u8-write" ? 255 : 0xffff_ffff}`, node: current });
      }
      ts.forEachChild(current, visit);
    };
    visit(node.body);
    for (const candidate of candidates) {
      const range = candidate.value ? expressionRange(candidate.value, parameterTypes, constants, tables, localRanges, semantics) : undefined;
      const invalidInteger = candidate.requiresInteger && range?.integer === false;
      const staticallyInside = range && candidate.upper !== undefined && range.minimum >= (candidate.lower ?? 0) && range.maximum <= candidate.upper && (!candidate.requiresInteger || range.integer);
      if (!candidate.knownResult && !invalidInteger && !staticallyInside) solverQueries++;
      const rawProofResult = candidate.knownResult ?? (invalidInteger ? "counterexample" : staticallyInside ? "verified" : await prove(node.parameters, [...assumptions, ...(candidate.assumptions ?? [])], candidate.goal, z3));
      const unresolvedShadowing = shadowedBindings && !semantics?.bindingKeys;
      const proofResult = unresolvedShadowing && rawProofResult === "verified" ? "unknown" : rawProofResult;
      const statement = enclosingStatement(candidate.node, node);
      const statementLeading = statement ? source.text.slice(statement.getFullStart(), statement.getStart(source)) : "";
      const trust = typedArrayTrust(statementLeading, candidate.kind, assumptionRegistry) ?? functionTrust;
      const result = proofResult !== "verified" && trust ? "trusted" : proofResult;
      const spanNode = result === "trusted" && statement ? statement : candidate.node;
      const span = { start: spanNode.getStart(source), end: spanNode.getEnd() };
      obligations.push({
        functionName, kind: candidate.kind, result, goal: candidate.goal, span,
        ...(result === "trusted" ? {
          ...(trust!.assumptionId ? { assumptionId: trust!.assumptionId } : {}),
          trustReason: trust!.reason,
          ...(trust!.owner ? { trustOwner: trust!.owner } : {}),
          ...(trust!.expiresOn ? { trustExpiresOn: trust!.expiresOn } : {}),
          ...(trust!.reviewDigest ? { trustReviewDigest: trust!.reviewDigest } : {}),
        } : {}),
      });
      if (result !== "verified" && result !== "trusted") diagnostics.push({ fileName, functionName, kind: candidate.kind, span, message: result === "counterexample" ? `${candidate.kind} constraint may fail: ${candidate.goal}` : unresolvedShadowing ? `${candidate.kind} constraint could not be proved because this legacy numeric scope contains same-spelled bindings` : `${candidate.kind} constraint could not be proved` });
    }
  }
  return { obligations, diagnostics, statistics: { solverQueries } };
}

export async function verifyTypedArraySafety(fileName: string, text: string, z3?: Z3ExecutionOptions, assumptionRegistry?: AssumptionRegistry): Promise<TypedArraySafetyResult> {
  return verifyTypedArraySafetyWithTables(fileName, text, new Map(), undefined, z3, assumptionRegistry);
}

/** Strict builtin recognition for callers that already own a TypeScript Program. */
export async function verifyTypedArraySafetyInTypeScriptProgram(program: ts.Program, source: ts.SourceFile, z3?: Z3ExecutionOptions, assumptionRegistry?: AssumptionRegistry): Promise<TypedArraySafetyResult> {
  const checker = program.getTypeChecker();
  const methods = new Set(["floor", "ceil", "round", "trunc"] as const);
  type IntegerCast = "floor" | "ceil" | "round" | "trunc";
  const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const builtinMethod = (expression: ts.Expression): IntegerCast | undefined => {
    if (!ts.isPropertyAccessExpression(expression) || !methods.has(expression.name.text as IntegerCast)) return undefined;
    const symbol = symbolAt(expression.name);
    return symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
      ? expression.name.text as IntegerCast : undefined;
  };
  const unwrap = (expression: ts.Expression): ts.Expression => ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)
    ? unwrap(expression.expression) : expression;
  const isImmutableProperty = (declaration: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean => {
    const object = declaration.parent;
    return ts.isObjectLiteralExpression(object) && ts.isAsExpression(object.parent) && object.parent.type.getText() === "const";
  };
  const declarationInitializer = (declaration: ts.Declaration): ts.Expression | undefined => {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const)) return declaration.initializer;
    if (ts.isPropertyAssignment(declaration) && isImmutableProperty(declaration)) return declaration.initializer;
    if (ts.isShorthandPropertyAssignment(declaration) && isImmutableProperty(declaration)) return declaration.name;
    return undefined;
  };
  const resolveCast = (input: ts.Expression, seen = new Set<ts.Symbol>()): IntegerCast | undefined => {
    const expression = unwrap(input);
    const direct = builtinMethod(expression);
    if (direct) return direct;
    const lookup = ts.isPropertyAccessExpression(expression) ? expression.name : ts.isIdentifier(expression) ? expression : undefined;
    const symbol = lookup ? symbolAt(lookup) : undefined;
    if (!symbol || seen.has(symbol)) return undefined;
    const nextSeen = new Set(seen).add(symbol);
    const resolved = new Set<IntegerCast>();
    for (const declaration of symbol.declarations ?? []) {
      const initializer = declarationInitializer(declaration);
      if (initializer) {
        const method = resolveCast(initializer, nextSeen);
        if (method) resolved.add(method);
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
        && ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) {
        const root = symbolAt(declaration.parent.parent.initializer);
        const builtinRoot = root?.declarations?.some((item) => program.isSourceFileDefaultLibrary(item.getSourceFile())) ?? false;
        const method = (declaration.propertyName ?? declaration.name).getText() as IntegerCast;
        if (builtinRoot && methods.has(method)) resolved.add(method);
      }
      if (ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent)) {
        const owner = declaration.parent;
        const index = owner.parameters.indexOf(declaration);
        const calls: Array<IntegerCast | undefined> = [];
        for (const file of program.getSourceFiles()) {
          const findCalls = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && checker.getResolvedSignature(node)?.declaration === owner) {
              const argument = node.arguments[index];
              const method = argument ? resolveCast(argument, nextSeen) : undefined;
              calls.push(method);
            }
            ts.forEachChild(node, findCalls);
          };
          findCalls(file);
        }
        if (calls[0] !== undefined && calls.every((method) => method === calls[0])) resolved.add(calls[0]);
      }
    }
    return resolved.size === 1 ? [...resolved][0] : undefined;
  };
  const integerCasts = new Map<number, IntegerCast>();
  const integerOperations = new Map<number, "imul" | "clz32" | "fround">();
  const bindingKeys = new Map<number, string>();
  const constantKeys = new Map<string, string>();
  for (const statement of source.statements) if (ts.isVariableStatement(statement)
    && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
      const key = symbolIdentityKey(symbolAt(declaration.name));
      if (key) constantKeys.set(declaration.name.text, key);
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const key = symbolIdentityKey(symbolAt(node));
      if (key) bindingKeys.set(node.getStart(source), key);
    }
    if (ts.isCallExpression(node)) {
      const method = resolveCast(node.expression);
      if (method) integerCasts.set(node.getStart(source), method);
      if (ts.isPropertyAccessExpression(node.expression)
        && (node.expression.name.text === "imul" || node.expression.name.text === "clz32" || node.expression.name.text === "fround")) {
        const symbol = symbolAt(node.expression.name);
        if (symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))) {
          integerOperations.set(node.getStart(source), node.expression.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const dataViewAliases = new Map<number, string | null>();
  const collectFunctionAliases = (owner: ts.FunctionLikeDeclaration): void => {
    if (!owner.body || !ts.isBlock(owner.body)) return;
    const parameterTypes = new Map(owner.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name)
      ? [[parameter.name.text, parameter.type?.getText(source) ?? ""] as const] : []));
    const reviewedUses: ts.Expression[] = [];
    const collectReviewedUses = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) return;
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const builtinReceiver = ts.isPropertyAccessExpression(parent) && parent.expression === node
          && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
          && DATA_VIEW_METHODS.has(parent.name.text);
        const immutableAliasInitializer = ts.isVariableDeclaration(parent) && parent.initializer === node
          && ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Const) !== 0;
        if (builtinReceiver || immutableAliasInitializer) reviewedUses.push(node);
      }
      ts.forEachChild(node, collectReviewedUses);
    };
    collectReviewedUses(owner.body);
    const collectAliases = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
        const type = checker.getTypeAtLocation(node.name);
        if (type.getProperty("getUint8")) {
          const resolution = resolveStableRegion(checker, node.name, {
            scope: owner.body!, permittedUse: node.name, permittedUses: reviewedUses,
          });
          if (resolution.status === "resolved") {
            const root = /^[A-Za-z_$][\w$]*/u.exec(resolution.region)?.[0];
            const inherited = root ? parameterTypes.get(root) : undefined;
            if (inherited && boundedDataViewMaximum(inherited, collectConstants(source)) !== undefined) {
              dataViewAliases.set(node.getStart(source), resolution.runtimeDescriptorUnchecked ? null : inherited);
            }
          } else {
            dataViewAliases.set(node.getStart(source), null);
          }
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(owner.body);
  };
  const collectFunctions = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) collectFunctionAliases(node);
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(source);
  return verifyTypedArraySafetyWithTables(source.fileName, source.text, new Map(), { integerCasts, integerOperations, dataViewAliases, bindingKeys, constantKeys }, z3, assumptionRegistry);
}

function resolveProgramModule(from: string, specifier: string, files: Readonly<Record<string, string>>): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(from), specifier));
  } else {
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const subpath = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
    const packageRoot = `/node_modules/${packageName}`;
    const manifestText = files[`${packageRoot}/package.json`];
    if (!manifestText) return undefined;
    try {
      const manifest = JSON.parse(manifestText) as { exports?: unknown; types?: unknown; main?: unknown };
      const selectTarget = (value: unknown): string | undefined => {
        if (typeof value === "string") return value;
        if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
        const conditions = value as Record<string, unknown>;
        for (const condition of ["types", "import", "default", "require"]) {
          const selected = selectTarget(conditions[condition]);
          if (selected) return selected;
        }
        return undefined;
      };
      const exports = manifest.exports;
      const exportTarget = subpath
        ? exports && typeof exports === "object" && !Array.isArray(exports) ? (exports as Record<string, unknown>)[`./${subpath}`] : undefined
        : exports && typeof exports === "object" && !Array.isArray(exports) && Object.hasOwn(exports, ".") ? (exports as Record<string, unknown>)["."] : exports;
      const target = selectTarget(exportTarget) ?? (!subpath ? selectTarget(manifest.types) ?? selectTarget(manifest.main) : undefined);
      if (!target || !target.startsWith("./")) return undefined;
      base = posix.normalize(posix.join(packageRoot, target));
    } catch {
      return undefined;
    }
  }
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`];
  return candidates.find((candidate) => Object.hasOwn(files, candidate));
}

export async function verifyTypedArraySafetyInProgram(files: Record<string, string>, z3?: Z3ExecutionOptions, assumptionRegistry?: AssumptionRegistry): Promise<TypedArrayProgramSafetyResult> {
  const sources = new Map(Object.entries(files).map(([fileName, text]) => [fileName, ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)]));
  const localTables = new Map<string, Map<string, ConstantTable>>();
  const exportedTables = new Map<string, Map<string, ConstantTable>>();
  for (const [fileName, source] of sources) {
    const tables = collectConstantTables(source, collectConstants(source));
    localTables.set(fileName, tables);
    const exported = new Map<string, ConstantTable>();
    for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
        const table = tables.get(declaration.name.text);
        if (table) exported.set(declaration.name.text, table);
      }
    }
    exportedTables.set(fileName, exported);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [fileName, source] of sources) for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveProgramModule(fileName, statement.moduleSpecifier.text, files);
      if (!target) continue;
      const targetExports = exportedTables.get(target)!;
      const current = exportedTables.get(fileName)!;
      if (!statement.exportClause) {
        for (const [name, table] of targetExports) if (!current.has(name)) { current.set(name, table); changed = true; }
      } else if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) {
        const table = targetExports.get(element.propertyName?.text ?? element.name.text);
        if (table && !current.has(element.name.text)) { current.set(element.name.text, table); changed = true; }
      }
    }
  }
  const results: Record<string, TypedArraySafetyResult> = {};
  for (const [fileName, source] of sources) {
    const imports = new Map<string, ConstantTable>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveProgramModule(fileName, statement.moduleSpecifier.text, files);
      if (!target) continue;
      const bindings = statement.importClause.namedBindings;
      if (ts.isNamespaceImport(bindings)) {
        for (const [name, table] of exportedTables.get(target) ?? []) imports.set(`${bindings.name.text}.${name}`, table);
      } else {
        for (const element of bindings.elements) {
          const table = exportedTables.get(target)?.get(element.propertyName?.text ?? element.name.text);
          if (table) imports.set(element.name.text, table);
        }
      }
    }
    results[fileName] = await verifyTypedArraySafetyWithTables(fileName, files[fileName]!, imports, undefined, z3, assumptionRegistry);
  }
  return {
    files: results,
    obligations: Object.values(results).flatMap((result) => result.obligations),
    diagnostics: Object.values(results).flatMap((result) => result.diagnostics),
    statistics: { solverQueries: Object.values(results).reduce((total, result) => total + result.statistics.solverQueries, 0) },
  };
}
