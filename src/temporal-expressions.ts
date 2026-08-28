import ts from "typescript";

export type TemporalExpression =
  | { kind: "name"; name: string }
  | { kind: "integer"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "array"; elements: TemporalExpression[] }
  | { kind: "record"; base?: TemporalExpression; fields: Readonly<Record<string, TemporalExpression>> }
  | { kind: "field"; receiver: TemporalExpression; name: string }
  | { kind: "lambda"; parameter: string; body: TemporalExpression }
  | { kind: "call"; name: "Set" | "Map"; arguments: TemporalExpression[] }
  | { kind: "method"; receiver: TemporalExpression; name: "contains" | "union" | "exclude" | "forall" | "exists" | "size" | "put" | "remove" | "get" | "getOrElse" | "keys" | "values"; arguments: TemporalExpression[] }
  | { kind: "conditional"; condition: TemporalExpression; whenTrue: TemporalExpression; whenFalse: TemporalExpression }
  | { kind: "unary"; operator: "not" | "negate"; operand: TemporalExpression }
  | { kind: "binary"; operator: TemporalBinaryOperator; left: TemporalExpression; right: TemporalExpression };

export type TemporalBinaryOperator =
  | "eq" | "neq" | "and" | "or"
  | "lt" | "lte" | "gt" | "gte"
  | "add" | "subtract" | "multiply" | "divide" | "modulo";
export type TemporalScalarType = "int" | "bool" | "never";
export type TemporalValueType = "int" | "bool"
  | { kind: "set"; element: TemporalValueType | "never" }
  | { kind: "map"; key: TemporalScalarType; value: TemporalValueType | "never" }
  | { kind: "record"; fields: Readonly<Record<string, TemporalValueType>> };

export function temporalTypesCompatible(left: TemporalValueType, right: TemporalValueType): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "set" && right.kind === "set") return left.element === "never" || right.element === "never" || temporalTypesCompatible(left.element, right.element);
  if (left.kind === "map" && right.kind === "map") return (left.key === right.key || left.key === "never" || right.key === "never")
    && (left.value === "never" || right.value === "never" || temporalTypesCompatible(left.value, right.value));
  if (left.kind === "record" && right.kind === "record") {
    const leftNames = Object.keys(left.fields), rightNames = Object.keys(right.fields);
    return leftNames.length === rightNames.length && leftNames.every((name) => right.fields[name] && temporalTypesCompatible(left.fields[name]!, right.fields[name]!));
  }
  return false;
}

/** Rejects partial Map.get uses unless the same conjunction proves key membership. */
export function assertGuardedTemporalMapGets(expression: TemporalExpression, externalGuard?: TemporalExpression): void {
  const conjuncts = (value: TemporalExpression): TemporalExpression[] =>
    value.kind === "binary" && value.operator === "and" ? [...conjuncts(value.left), ...conjuncts(value.right)] : [value];
  const guards = [...conjuncts(expression), ...(externalGuard ? conjuncts(externalGuard) : [])];
  const same = (left: TemporalExpression, right: TemporalExpression): boolean => JSON.stringify(left) === JSON.stringify(right);
  const guarded = (receiver: TemporalExpression, key: TemporalExpression): boolean => guards.some((candidate) =>
    candidate.kind === "method" && candidate.name === "contains" && candidate.arguments.length === 1
    && candidate.receiver.kind === "method" && candidate.receiver.name === "keys" && candidate.receiver.arguments.length === 0
    && same(candidate.receiver.receiver, receiver) && same(candidate.arguments[0]!, key));
  const visit = (value: TemporalExpression): void => {
    if (value.kind === "method" && value.name === "get" && !guarded(value.receiver, value.arguments[0]!)) {
      throw new Error("temporal Map.get requires a conjunctive map.keys().contains(key) guard");
    }
    if (value.kind === "unary") visit(value.operand);
    else if (value.kind === "binary") { visit(value.left); visit(value.right); }
    else if (value.kind === "conditional") { visit(value.condition); visit(value.whenTrue); visit(value.whenFalse); }
    else if (value.kind === "array") value.elements.forEach(visit);
    else if (value.kind === "record") { if (value.base) visit(value.base); Object.values(value.fields).forEach(visit); }
    else if (value.kind === "field") visit(value.receiver);
    else if (value.kind === "lambda") visit(value.body);
    else if (value.kind === "call") value.arguments.forEach(visit);
    else if (value.kind === "method") { visit(value.receiver); value.arguments.forEach(visit); }
  };
  visit(expression);
}

export function formatTemporalValueType(type: TemporalValueType): string {
  if (typeof type === "string") return type;
  if (type.kind === "set") return `Set[${type.element === "never" ? "int" : formatTemporalValueType(type.element)}]`;
  if (type.kind === "map") return `${type.key === "never" ? "int" : type.key} -> ${type.value === "never" ? "int" : formatTemporalValueType(type.value)}`;
  return `{ ${Object.entries(type.fields).map(([name, field]) => `${name}: ${formatTemporalValueType(field)}`).join(", ")} }`;
}

export function parseTemporalValueType(source: string): TemporalValueType {
  const file = ts.createSourceFile("temporal-type.ts", `type __Value = ${source}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) throw new Error(`invalid temporal state type: ${source}`);
  const statement = file.statements[0];
  const convertType = (node: ts.TypeNode): TemporalValueType => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if ((node.typeName.text === "int" || node.typeName.text === "bool") && !node.typeArguments?.length) return node.typeName.text;
      if (node.typeName.text === "Set" && node.typeArguments?.length === 1) return { kind: "set", element: convertType(node.typeArguments[0]!) };
      if (node.typeName.text === "Map" && node.typeArguments?.length === 2) {
        const key = convertType(node.typeArguments[0]!), value = convertType(node.typeArguments[1]!);
        if (key !== "int" && key !== "bool") throw new Error("temporal Map keys must be int or bool");
        return { kind: "map", key, value };
      }
    }
    if (ts.isTypeLiteralNode(node)) {
      const fields: Record<string, TemporalValueType> = {};
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.type || !member.name || !ts.isIdentifier(member.name) || member.questionToken) throw new Error("temporal records require named, required fields");
        if (fields[member.name.text]) throw new Error(`duplicate temporal record field \`${member.name.text}\``);
        fields[member.name.text] = convertType(member.type);
      }
      if (Object.keys(fields).length === 0) throw new Error("temporal records require at least one field");
      return { kind: "record", fields };
    }
    throw new Error(`unsupported temporal state type: ${node.getText(file)}`);
  };
  if (!statement || !ts.isTypeAliasDeclaration(statement)) throw new Error(`unsupported temporal state type: ${source}`);
  return convertType(statement.type);
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
  if (expression.kind === "array") throw new Error("temporal array literals are only valid inside Map entries");
  if (expression.kind === "record") {
    const base = expression.base ? typeCheckTemporalExpression(expression.base, symbols) : undefined;
    if (base && (typeof base === "string" || base.kind !== "record")) throw new Error("temporal record spread requires a record");
    const fields: Record<string, TemporalValueType> = base && typeof base !== "string" ? { ...base.fields } : {};
    for (const [name, value] of Object.entries(expression.fields)) {
      const type = typeCheckTemporalExpression(value, symbols);
      if (base && fields[name] && !temporalTypesCompatible(fields[name]!, type)) throw new Error(`temporal record field \`${name}\` update changes its type`);
      fields[name] = type;
    }
    return { kind: "record", fields };
  }
  if (expression.kind === "field") {
    const receiver = typeCheckTemporalExpression(expression.receiver, symbols);
    if (typeof receiver === "string" || receiver.kind !== "record") throw new Error("temporal field access requires a record");
    const field = receiver.fields[expression.name];
    if (!field) throw new Error(`unknown temporal record field \`${expression.name}\``);
    return field;
  }
  if (expression.kind === "lambda") throw new Error("temporal lambda is only valid as a finite quantifier predicate");
  if (expression.kind === "call") {
    if (expression.name === "Map") {
      if (expression.arguments.length !== 1 || expression.arguments[0]?.kind !== "array") throw new Error("temporal Map requires one array of [key, value] entries");
      const pairs = expression.arguments[0].elements;
      const typed = pairs.map((pair) => {
        if (pair.kind !== "array" || pair.elements.length !== 2) throw new Error("temporal Map entries must be [key, value] pairs");
        const key = typeCheckTemporalExpression(pair.elements[0]!, symbols), value = typeCheckTemporalExpression(pair.elements[1]!, symbols);
        if (typeof key !== "string") throw new Error("temporal Map keys must be scalar");
        return { key, value };
      });
      if (typed.length === 0) return { kind: "map", key: "never", value: "never" };
      const key = typed[0]!.key, value = typed[0]!.value;
      if (typed.some((pair) => pair.key !== key || !temporalTypesCompatible(pair.value, value))) throw new Error("temporal Map requires homogeneous key and value types");
      return { kind: "map", key, value };
    }
    const elements = expression.arguments.map((item) => typeCheckTemporalExpression(item, symbols));
    if (elements.length === 0) return { kind: "set", element: "never" };
    const element = elements[0]!;
    if (elements.some((item) => !temporalTypesCompatible(item, element))) throw new Error("temporal Set requires the same element type");
    return { kind: "set", element };
  }
  if (expression.kind === "method") {
    const receiver = typeCheckTemporalExpression(expression.receiver, symbols);
    if (expression.name === "size") {
      if (typeof receiver === "string" || (receiver.kind !== "set" && receiver.kind !== "map")) throw new Error("temporal size requires a Set or Map receiver");
      if (expression.arguments.length !== 0) throw new Error("temporal size does not accept arguments");
      return "int";
    }
    if (expression.name === "put" || expression.name === "remove" || expression.name === "get"
      || expression.name === "getOrElse" || expression.name === "keys" || expression.name === "values") {
      if (typeof receiver === "string" || receiver.kind !== "map") throw new Error(`temporal ${expression.name} requires a Map receiver`);
      if (expression.name === "keys" || expression.name === "values") {
        if (expression.arguments.length !== 0) throw new Error(`temporal ${expression.name} does not accept arguments`);
        return { kind: "set", element: expression.name === "keys" ? receiver.key : receiver.value };
      }
      if (expression.name === "remove" || expression.name === "get") {
        if (expression.arguments.length !== 1) throw new Error(`temporal ${expression.name} requires one matching key`);
        const key = typeCheckTemporalExpression(expression.arguments[0]!, symbols);
        if (typeof key !== "string" || (receiver.key !== "never" && receiver.key !== key)) throw new Error(`temporal ${expression.name} key type must match the Map`);
        return expression.name === "get" ? receiver.value === "never" ? "int" : receiver.value : receiver;
      }
      if (expression.name === "getOrElse") {
        if (expression.arguments.length !== 2) throw new Error("temporal getOrElse requires a key and fallback");
        const key = typeCheckTemporalExpression(expression.arguments[0]!, symbols);
        if (typeof key !== "string" || (receiver.key !== "never" && receiver.key !== key)) {
          throw new Error("temporal getOrElse key type must match the Map");
        }
        const fallback = typeCheckTemporalExpression(expression.arguments[1]!, symbols);
        if (receiver.value !== "never" && !temporalTypesCompatible(receiver.value, fallback)) {
          throw new Error("temporal getOrElse fallback type must match the Map value");
        }
        return receiver.value === "never" ? fallback : receiver.value;
      }
      if (expression.arguments.length !== 2) throw new Error("temporal put requires a key and value");
      const key = typeCheckTemporalExpression(expression.arguments[0]!, symbols), value = typeCheckTemporalExpression(expression.arguments[1]!, symbols);
      if (typeof key !== "string" || (receiver.key !== "never" && receiver.key !== key) || (receiver.value !== "never" && !temporalTypesCompatible(receiver.value, value))) throw new Error("temporal put key/value types must match the Map");
      return receiver;
    }
    if (typeof receiver === "string" || receiver.kind !== "set") throw new Error(`temporal ${expression.name} requires a Set receiver`);
    if (expression.name === "contains") {
      if (expression.arguments.length !== 1) throw new Error("temporal contains requires one matching element");
      const element = typeCheckTemporalExpression(expression.arguments[0]!, symbols);
      if (receiver.element !== "never" && !temporalTypesCompatible(receiver.element, element)) throw new Error("temporal contains requires one matching element");
      return "bool";
    }
    if (expression.name === "union" || expression.name === "exclude") {
      if (expression.arguments.length !== 1) throw new Error("temporal union requires one matching Set");
      if (!temporalTypesCompatible(receiver, typeCheckTemporalExpression(expression.arguments[0]!, symbols))) throw new Error(`temporal ${expression.name} requires one matching Set`);
      return receiver;
    }
    const predicate = expression.arguments[0];
    if (expression.arguments.length !== 1 || !predicate || predicate.kind !== "lambda") throw new Error(`temporal ${expression.name} requires one arrow predicate`);
    const scoped = new Map(symbols);
    scoped.set(predicate.parameter, receiver.element === "never" ? "int" : receiver.element);
    if (typeCheckTemporalExpression(predicate.body, scoped) !== "bool") throw new Error(`temporal ${expression.name} requires a boolean predicate`);
    return "bool";
  }
  if (expression.kind === "conditional") {
    if (typeCheckTemporalExpression(expression.condition, symbols) !== "bool") throw new Error("temporal conditional requires a boolean condition");
    const whenTrue = typeCheckTemporalExpression(expression.whenTrue, symbols);
    const whenFalse = typeCheckTemporalExpression(expression.whenFalse, symbols);
    if (!temporalTypesCompatible(whenTrue, whenFalse)) throw new Error("temporal conditional requires matching branch types");
    return whenTrue;
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
  if (ts.isArrayLiteralExpression(node)) return { kind: "array", elements: node.elements.map((element) => {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) throw new Error("temporal arrays do not support spread or holes");
    return convert(element);
  }) };
  if (ts.isObjectLiteralExpression(node)) {
    let base: TemporalExpression | undefined;
    const fields: Record<string, TemporalExpression> = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (base) throw new Error("temporal records allow one leading spread");
        if (Object.keys(fields).length > 0) throw new Error("temporal record spread must be first");
        base = convert(property.expression);
      } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        fields[property.name.text] = convert(property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        fields[property.name.text] = { kind: "name", name: property.name.text };
      } else {
        throw new Error("temporal records require identifier fields and ordinary values");
      }
    }
    return { kind: "record", ...(base ? { base } : {}), fields };
  }
  if (ts.isPropertyAccessExpression(node)) return { kind: "field", receiver: convert(node.expression), name: node.name.text };
  if (ts.isConditionalExpression(node)) return { kind: "conditional", condition: convert(node.condition), whenTrue: convert(node.whenTrue), whenFalse: convert(node.whenFalse) };
  if (ts.isArrowFunction(node) && node.parameters.length === 1 && ts.isIdentifier(node.parameters[0]!.name) && !ts.isBlock(node.body)) {
    return { kind: "lambda", parameter: node.parameters[0]!.name.text, body: convert(node.body) };
  }
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && (node.expression.text === "Set" || node.expression.text === "Map")) return { kind: "call", name: node.expression.text, arguments: node.arguments.map(convert) };
    if (ts.isPropertyAccessExpression(node.expression)) {
      if (!["contains", "union", "exclude", "forall", "exists", "size", "put", "remove", "get", "getOrElse", "keys", "values"].includes(node.expression.name.text)) {
        throw new Error(`unsupported temporal method \`${node.expression.name.text}\``);
      }
      return { kind: "method", receiver: convert(node.expression.expression), name: node.expression.name.text as Extract<TemporalExpression, { kind: "method" }>["name"], arguments: node.arguments.map(convert) };
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
  if (expression.kind === "conditional") return 0;
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
  if (expression.kind === "array") return `[${expression.elements.map((item) => emit(item, backend)).join(", ")}]`;
  if (expression.kind === "record") {
    const fields = Object.entries(expression.fields);
    if (backend === "quint" && expression.base) return fields.reduce((value, [name, field]) => `${value}.with(${JSON.stringify(name)}, ${emit(field, backend)})`, emit(expression.base, backend));
    const body = [...(expression.base ? [`...${emit(expression.base, backend)}`] : []), ...fields.map(([name, field]) => `${name}: ${emit(field, backend)}`)].join(", ");
    return `{ ${body} }`;
  }
  if (expression.kind === "field") {
    const receiver = emit(expression.receiver, backend, 100);
    return `${backend === "runtime" && expression.receiver.kind === "record" ? `(${receiver})` : receiver}.${expression.name}`;
  }
  if (expression.kind === "lambda") return `${expression.parameter} => ${emit(expression.body, backend)}`;
  if (expression.kind === "call") {
    if (expression.name === "Map") {
      const entries = (expression.arguments[0] as Extract<TemporalExpression, { kind: "array" }>).elements.map((pair) => (pair as Extract<TemporalExpression, { kind: "array" }>).elements);
      if (backend === "quint") return `Map(${entries.map(([key, value]) => `${emit(key!, backend)} -> ${emit(value!, backend)}`).join(", ")})`;
      return `new Map([${entries.map(([key, value]) => `[${emit(key!, backend)}, ${emit(value!, backend)}]`).join(", ")}])`;
    }
    const items = expression.arguments.map((item) => emit(item, backend)).join(", ");
    return backend === "quint" ? `Set(${items})` : `new Set([${items}])`;
  }
  if (expression.kind === "method") {
    const receiver = emit(expression.receiver, backend, 100);
    if (expression.name === "getOrElse") {
      const key = emit(expression.arguments[0]!, backend);
      const fallback = emit(expression.arguments[1]!, backend);
      return backend === "quint"
        ? `(if (${receiver}.keys().contains(${key})) ${receiver}.get(${key}) else ${fallback})`
        : `(${receiver}.has(${key}) ? ${receiver}.get(${key}) : ${fallback})`;
    }
    if (backend === "quint" && expression.name === "values") return `${receiver}.keys().map(_uneffect_key => ${receiver}.get(_uneffect_key))`;
    if (backend === "quint" && expression.name === "remove") return `${receiver}.keys().exclude(Set(${emit(expression.arguments[0]!, backend)})).mapBy(_uneffect_key => ${receiver}.get(_uneffect_key))`;
    if (backend === "quint") return `${receiver}.${expression.name}(${expression.arguments.map((item) => emit(item, backend)).join(", ")})`;
    if (expression.name === "put") return `new Map([...${receiver}, [${emit(expression.arguments[0]!, backend)}, ${emit(expression.arguments[1]!, backend)}]])`;
    if (expression.name === "remove") return `new Map([...${receiver}].filter(([_uneffect_key]) => _uneffect_key !== ${emit(expression.arguments[0]!, backend)}))`;
    if (expression.name === "get") return `${receiver}.get(${emit(expression.arguments[0]!, backend)})`;
    if (expression.name === "keys") return `new Set(${receiver}.keys())`;
    if (expression.name === "values") return `new Set(${receiver}.values())`;
    if (expression.name === "size") return `${receiver}.size`;
    if (expression.name === "contains") return `${receiver}.has(${emit(expression.arguments[0]!, backend)})`;
    if (expression.name === "union") return `new Set([...${receiver}, ...${emit(expression.arguments[0]!, backend)}])`;
    if (expression.name === "exclude") return `new Set([...${receiver}].filter(_uneffect_item => !${emit(expression.arguments[0]!, backend)}.has(_uneffect_item)))`;
    return `Array.from(${receiver}).${expression.name === "exists" ? "some" : "every"}(${emit(expression.arguments[0]!, backend)})`;
  }
  if (expression.kind === "conditional") {
    const value = backend === "quint"
      ? `if (${emit(expression.condition, backend)}) ${emit(expression.whenTrue, backend)} else ${emit(expression.whenFalse, backend)}`
      : `${emit(expression.condition, backend, 1)} ? ${emit(expression.whenTrue, backend)} : ${emit(expression.whenFalse, backend)}`;
    return parent > 0 ? `(${value})` : value;
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
