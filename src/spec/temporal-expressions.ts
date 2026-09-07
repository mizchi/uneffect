import { parseOxcExpression } from "../frontends/oxc/expression.js";
import { parseSync, type Expression, type TSType } from "oxc-parser";

export type TemporalExpression =
  | { kind: "name"; name: string }
  | { kind: "integer"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
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
export type TemporalScalarType = "int" | "bool" | "string" | "never";
export type TemporalValueType = "int" | "bool" | "string"
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
  const text = `type __Value = ${source}`;
  const file = parseSync("temporal-type.ts", text, { lang: "ts" });
  if (file.errors.length || file.program.body.length !== 1) throw new Error(`invalid temporal state type: ${source}`);
  const statement = file.program.body[0];
  const convertType = (node: TSType): TemporalValueType => {
    if (node.type === "TSStringKeyword") return "string";
    if (node.type === "TSTypeReference" && node.typeName.type === "Identifier") {
      const name = node.typeName.name, arguments_ = node.typeArguments?.params;
      if ((name === "int" || name === "bool") && !arguments_?.length) return name;
      if (name === "Set" && arguments_?.length === 1) return { kind: "set", element: convertType(arguments_[0]!) };
      if (name === "Map" && arguments_?.length === 2) {
        const key = convertType(arguments_[0]!), value = convertType(arguments_[1]!);
        if (key !== "int" && key !== "bool" && key !== "string") throw new Error("temporal Map keys must be int, bool, or string");
        return { kind: "map", key, value };
      }
    }
    if (node.type === "TSTypeLiteral") {
      const fields: Record<string, TemporalValueType> = {};
      for (const member of node.members) {
        if (member.type !== "TSPropertySignature" || !member.typeAnnotation || member.key.type !== "Identifier" || member.optional || member.computed || member.key.name === "__proto__") throw new Error("temporal records require named, required fields");
        if (Object.hasOwn(fields, member.key.name)) throw new Error(`duplicate temporal record field \`${member.key.name}\``);
        Object.defineProperty(fields, member.key.name, { value: convertType(member.typeAnnotation.typeAnnotation), enumerable: true, configurable: true, writable: true });
      }
      if (Object.keys(fields).length === 0) throw new Error("temporal records require at least one field");
      return { kind: "record", fields };
    }
    throw new Error(`unsupported temporal state type: ${text.slice(node.start, node.end)}`);
  };
  if (!statement || statement.type !== "TSTypeAliasDeclaration") throw new Error(`unsupported temporal state type: ${source}`);
  return convertType(statement.typeAnnotation);
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
  if (expression.kind === "string") return "string";
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

function convert(node: Expression, source: string): TemporalExpression {
  const child = (expression: Expression) => convert(expression, source);
  if (node.type === "ParenthesizedExpression") return child(node.expression);
  if (node.type === "Identifier") return { kind: "name", name: node.name };
  if (node.type === "Literal") {
    if (typeof node.value === "number" && /^\d+$/.test(String(node.value))) return { kind: "integer", value: String(node.value) };
    if (typeof node.value === "string") return { kind: "string", value: node.value };
    if (typeof node.value === "boolean") return { kind: "boolean", value: node.value };
  }
  if (node.type === "ArrayExpression") return { kind: "array", elements: node.elements.map(element => {
    if (!element || element.type === "SpreadElement") throw new Error("temporal arrays do not support spread or holes");
    return child(element);
  }) };
  if (node.type === "ObjectExpression") {
    let base: TemporalExpression | undefined;
    const fields: Record<string, TemporalExpression> = {};
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        if (base) throw new Error("temporal records allow one leading spread");
        if (Object.keys(fields).length > 0) throw new Error("temporal record spread must be first");
        base = child(property.argument);
      } else if (!property.computed && !property.method && property.kind === "init" && property.key.type === "Identifier" && property.key.name !== "__proto__") {
        Object.defineProperty(fields, property.key.name, { value: child(property.value), enumerable: true, configurable: true, writable: true });
      } else throw new Error("temporal records require identifier fields and ordinary values");
    }
    return { kind: "record", ...(base ? { base } : {}), fields };
  }
  if (node.type === "MemberExpression" && !node.computed && !node.optional && node.property.type === "Identifier") return { kind: "field", receiver: child(node.object), name: node.property.name };
  if (node.type === "ConditionalExpression") return { kind: "conditional", condition: child(node.test), whenTrue: child(node.consequent), whenFalse: child(node.alternate) };
  if (node.type === "ArrowFunctionExpression" && !node.async && node.params.length === 1 && node.params[0]!.type === "Identifier" && node.body.type !== "BlockStatement") {
    return { kind: "lambda", parameter: node.params[0]!.name, body: child(node.body) };
  }
  if (node.type === "CallExpression" && !node.optional) {
    const args = () => node.arguments.map(argument => {
      if (argument.type === "SpreadElement") throw new Error("unsupported temporal expression: spread argument");
      return child(argument);
    });
    if (node.callee.type === "Identifier" && (node.callee.name === "Set" || node.callee.name === "Map")) return { kind: "call", name: node.callee.name, arguments: args() };
    if (node.callee.type === "MemberExpression" && !node.callee.computed && !node.callee.optional && node.callee.property.type === "Identifier") {
      const name = node.callee.property.name;
      if (!["contains", "union", "exclude", "forall", "exists", "size", "put", "remove", "get", "getOrElse", "keys", "values"].includes(name)) throw new Error(`unsupported temporal method \`${name}\``);
      return { kind: "method", receiver: child(node.callee.object), name: name as Extract<TemporalExpression, { kind: "method" }>["name"], arguments: args() };
    }
  }
  if (node.type === "UnaryExpression") {
    if (node.operator === "!") return { kind: "unary", operator: "not", operand: child(node.argument) };
    if (node.operator === "-") return { kind: "unary", operator: "negate", operand: child(node.argument) };
  }
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    if (node.operator === "==" || node.operator === "!=") throw new Error("temporal expressions require strict equality (`===` or `!==`)");
    const operators = new Map<string, TemporalBinaryOperator>([
      ["===", "eq"], ["!==", "neq"], ["&&", "and"], ["||", "or"],
      ["<", "lt"], ["<=", "lte"], [">", "gt"], [">=", "gte"],
      ["+", "add"], ["-", "subtract"], ["*", "multiply"], ["/", "divide"], ["%", "modulo"],
    ]);
    const operator = operators.get(node.operator);
    if (operator && node.left.type !== "PrivateIdentifier") return { kind: "binary", operator, left: child(node.left), right: child(node.right) };
  }
  throw new Error(`unsupported temporal expression: ${source.slice(node.start, node.end)}`);
}

export function parseTemporalExpression(source: string): TemporalExpression {
  const parsed = parseOxcExpression(source, "temporal");
  return convert(parsed.expression, parsed.source);
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
  if (expression.kind === "string") return JSON.stringify(expression.value);
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
