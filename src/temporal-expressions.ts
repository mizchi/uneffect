import ts from "typescript";

export type TemporalExpression =
  | { kind: "name"; name: string }
  | { kind: "integer"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "lambda"; parameter: string; body: TemporalExpression }
  | { kind: "call"; name: "Set"; arguments: TemporalExpression[] }
  | { kind: "method"; receiver: TemporalExpression; name: "contains" | "union" | "forall" | "size"; arguments: TemporalExpression[] }
  | { kind: "unary"; operator: "not" | "negate"; operand: TemporalExpression }
  | { kind: "binary"; operator: TemporalBinaryOperator; left: TemporalExpression; right: TemporalExpression };

export type TemporalBinaryOperator =
  | "eq" | "neq" | "and" | "or"
  | "lt" | "lte" | "gt" | "gte"
  | "add" | "subtract" | "multiply" | "divide" | "modulo";
export type TemporalScalarType = "int" | "bool" | "never";
export type TemporalValueType = "int" | "bool" | { kind: "set"; element: TemporalScalarType };

export function temporalTypesCompatible(left: TemporalValueType, right: TemporalValueType): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.kind === right.kind && (left.element === right.element || left.element === "never" || right.element === "never");
}

export function formatTemporalValueType(type: TemporalValueType): string {
  return typeof type === "string" ? type : `Set[${type.element === "never" ? "int" : type.element}]`;
}

export function typeCheckTemporalExpression(
  expression: TemporalExpression,
  symbols: ReadonlyMap<string, TemporalValueType>,
): TemporalValueType {
  if (expression.kind === "name") {
    const type = symbols.get(expression.name);
    if (!type) throw new Error(`unknown temporal symbol \`${expression.name}\``);
    return type;
  }
  if (expression.kind === "integer") return "int";
  if (expression.kind === "boolean") return "bool";
  if (expression.kind === "lambda") throw new Error("temporal lambda is only valid as a finite quantifier predicate");
  if (expression.kind === "call") {
    const elements = expression.arguments.map((item) => typeCheckTemporalExpression(item, symbols));
    if (elements.some((item) => typeof item !== "string")) throw new Error("temporal Set elements must be scalar values");
    const element: TemporalScalarType = (elements[0] as "int" | "bool" | undefined) ?? "never";
    if (elements.some((item) => item !== element)) throw new Error("temporal Set requires the same element type");
    return { kind: "set", element };
  }
  if (expression.kind === "method") {
    const receiver = typeCheckTemporalExpression(expression.receiver, symbols);
    if (typeof receiver === "string" || receiver.kind !== "set") throw new Error(`temporal ${expression.name} requires a Set receiver`);
    if (expression.name === "size") {
      if (expression.arguments.length !== 0) throw new Error("temporal size does not accept arguments");
      return "int";
    }
    if (expression.name === "contains") {
      if (expression.arguments.length !== 1) throw new Error("temporal contains requires one matching element");
      const element = typeCheckTemporalExpression(expression.arguments[0]!, symbols);
      if (typeof element !== "string" || (receiver.element !== "never" && receiver.element !== element)) throw new Error("temporal contains requires one matching element");
      return "bool";
    }
    if (expression.name === "union") {
      if (expression.arguments.length !== 1) throw new Error("temporal union requires one matching Set");
      if (!temporalTypesCompatible(receiver, typeCheckTemporalExpression(expression.arguments[0]!, symbols))) throw new Error("temporal union requires one matching Set");
      return receiver;
    }
    const predicate = expression.arguments[0];
    if (expression.arguments.length !== 1 || !predicate || predicate.kind !== "lambda") throw new Error("temporal forall requires one arrow predicate");
    const scoped = new Map(symbols);
    scoped.set(predicate.parameter, receiver.element === "never" ? "int" : receiver.element);
    if (typeCheckTemporalExpression(predicate.body, scoped) !== "bool") throw new Error("temporal forall requires a boolean predicate");
    return "bool";
  }
  if (expression.kind === "unary") {
    const operand = typeCheckTemporalExpression(expression.operand, symbols);
    const expected = expression.operator === "not" ? "bool" : "int";
    if (operand !== expected) throw new Error(`temporal ${expression.operator} requires a ${expected} operand`);
    return expected;
  }
  const left = typeCheckTemporalExpression(expression.left, symbols);
  const right = typeCheckTemporalExpression(expression.right, symbols);
  if (expression.operator === "and" || expression.operator === "or") {
    if (left !== "bool" || right !== "bool") throw new Error(`temporal ${expression.operator} requires boolean operands`);
    return "bool";
  }
  if (expression.operator === "eq" || expression.operator === "neq") {
    if (!temporalTypesCompatible(left, right)) throw new Error("temporal equality requires operands of the same type");
    return "bool";
  }
  if (["lt", "lte", "gt", "gte"].includes(expression.operator)) {
    if (left !== "int" || right !== "int") throw new Error(`temporal ${expression.operator} requires integer operands`);
    return "bool";
  }
  if (left !== "int" || right !== "int") throw new Error(`temporal ${expression.operator} requires integer operands`);
  return "int";
}

function convert(node: ts.Expression): TemporalExpression {
  if (ts.isParenthesizedExpression(node)) return convert(node.expression);
  if (ts.isIdentifier(node)) return { kind: "name", name: node.text };
  if (ts.isNumericLiteral(node) && /^\d+$/.test(node.text)) return { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (ts.isArrowFunction(node) && node.parameters.length === 1 && ts.isIdentifier(node.parameters[0]!.name) && !ts.isBlock(node.body)) {
    return { kind: "lambda", parameter: node.parameters[0]!.name.text, body: convert(node.body) };
  }
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === "Set") return { kind: "call", name: "Set", arguments: node.arguments.map(convert) };
    if (ts.isPropertyAccessExpression(node.expression) && ["contains", "union", "forall", "size"].includes(node.expression.name.text)) {
      return { kind: "method", receiver: convert(node.expression.expression), name: node.expression.name.text as "contains" | "union" | "forall" | "size", arguments: node.arguments.map(convert) };
    }
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) return { kind: "unary", operator: "not", operand: convert(node.operand) };
    if (node.operator === ts.SyntaxKind.MinusToken) return { kind: "unary", operator: "negate", operand: convert(node.operand) };
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) {
      throw new Error("temporal expressions require strict equality (`===` or `!==`)");
    }
    const operators = new Map<ts.SyntaxKind, TemporalBinaryOperator>([
      [ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "neq"],
      [ts.SyntaxKind.AmpersandAmpersandToken, "and"], [ts.SyntaxKind.BarBarToken, "or"],
      [ts.SyntaxKind.LessThanToken, "lt"], [ts.SyntaxKind.LessThanEqualsToken, "lte"],
      [ts.SyntaxKind.GreaterThanToken, "gt"], [ts.SyntaxKind.GreaterThanEqualsToken, "gte"],
      [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "subtract"],
      [ts.SyntaxKind.AsteriskToken, "multiply"], [ts.SyntaxKind.SlashToken, "divide"],
      [ts.SyntaxKind.PercentToken, "modulo"],
    ]);
    const operator = operators.get(node.operatorToken.kind);
    if (operator) return { kind: "binary", operator, left: convert(node.left), right: convert(node.right) };
  }
  throw new Error(`unsupported temporal expression: ${node.getText()}`);
}

export function parseTemporalExpression(source: string): TemporalExpression {
  const file = ts.createSourceFile("temporal.ts", `const __value = (${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) throw new Error(`invalid temporal expression: ${source}`);
  const statement = file.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) throw new Error(`invalid temporal expression: ${source}`);
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) throw new Error(`invalid temporal expression: ${source}`);
  return convert(initializer);
}

const quintBinary: Record<TemporalBinaryOperator, string> = {
  eq: "==", neq: "!=", and: "and", or: "or", lt: "<", lte: "<=", gt: ">", gte: ">=",
  add: "+", subtract: "-", multiply: "*", divide: "/", modulo: "%",
};
const runtimeBinary: Record<TemporalBinaryOperator, string> = {
  eq: "===", neq: "!==", and: "&&", or: "||", lt: "<", lte: "<=", gt: ">", gte: ">=",
  add: "+", subtract: "-", multiply: "*", divide: "/", modulo: "%",
};

function precedence(expression: TemporalExpression): number {
  if (expression.kind !== "binary") return 100;
  if (expression.operator === "or") return 1;
  if (expression.operator === "and") return 2;
  if (["eq", "neq"].includes(expression.operator)) return 3;
  if (["lt", "lte", "gt", "gte"].includes(expression.operator)) return 4;
  if (["add", "subtract"].includes(expression.operator)) return 5;
  return 6;
}

function emit(expression: TemporalExpression, backend: "quint" | "runtime", parent = 0): string {
  if (expression.kind === "name") return expression.name;
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "lambda") return `${expression.parameter} => ${emit(expression.body, backend)}`;
  if (expression.kind === "call") {
    const items = expression.arguments.map((item) => emit(item, backend)).join(", ");
    return backend === "quint" ? `Set(${items})` : `new Set([${items}])`;
  }
  if (expression.kind === "method") {
    const receiver = emit(expression.receiver, backend, 100);
    if (backend === "quint") return `${receiver}.${expression.name}(${expression.arguments.map((item) => emit(item, backend)).join(", ")})`;
    if (expression.name === "size") return `${receiver}.size`;
    if (expression.name === "contains") return `${receiver}.has(${emit(expression.arguments[0]!, backend)})`;
    if (expression.name === "union") return `new Set([...${receiver}, ...${emit(expression.arguments[0]!, backend)}])`;
    return `Array.from(${receiver}).every(${emit(expression.arguments[0]!, backend)})`;
  }
  if (expression.kind === "unary") {
    const operand = emit(expression.operand, backend, 100);
    return expression.operator === "not" ? (backend === "quint" ? `not(${operand})` : `!${operand}`) : `-${operand}`;
  }
  const own = precedence(expression);
  const operator = (backend === "quint" ? quintBinary : runtimeBinary)[expression.operator];
  const value = `${emit(expression.left, backend, own)} ${operator} ${emit(expression.right, backend, own + 1)}`;
  return own < parent ? `(${value})` : value;
}

export function generateQuintExpression(expression: TemporalExpression): string { return emit(expression, "quint"); }
export function generateRuntimeAssertionExpression(expression: TemporalExpression): string { return emit(expression, "runtime"); }
export function generateRuntimeAssertionStatement(expression: TemporalExpression, message = "Uneffect temporal assertion failed"): string {
  return `if (!(${generateRuntimeAssertionExpression(expression)})) throw new Error(${JSON.stringify(message)});`;
}
