import type { Node, TSType } from "oxc-parser";
import { parseOxcExpression } from "../frontends/oxc/expression.js";
import { oxcChildren } from "../frontends/oxc/source.js";
import { parseLogicExpression } from "./logic.js";
import type { PropertyBoundaryKind, PropertyLiteral, PropertyTestDomain } from "./property-tests.js";

export const isIdentifier = (node: Node): node is Extract<Node, { type: "Identifier" }> => node.type === "Identifier";
export const isNumberLiteral = (node: Node): node is Extract<Node, { type: "Literal"; value: number }> => node.type === "Literal" && typeof node.value === "number";
export const isStaticMember = (node: Node): node is Extract<Node, { type: "MemberExpression"; computed: false }> => node.type === "MemberExpression" && !node.computed && !node.optional && node.property.type === "Identifier";
export const isComputedMember = (node: Node): node is Extract<Node, { type: "MemberExpression"; computed: true }> => node.type === "MemberExpression" && node.computed && !node.optional;
export const isCall = (node: Node): node is Extract<Node, { type: "CallExpression" }> => node.type === "CallExpression" && !node.optional;
export const isBinary = (node: Node): node is Extract<Node, { type: "BinaryExpression" | "LogicalExpression" }> => node.type === "BinaryExpression" || node.type === "LogicalExpression";
export const isWrapped = (node: Node): node is Extract<Node, { type: "ParenthesizedExpression" | "TSNonNullExpression" }> => node.type === "ParenthesizedExpression" || node.type === "TSNonNullExpression";

const supported = new Set<PropertyBoundaryKind>(["Int", "Nat", "U8", "U32", "I32"]);
function literalValue(type: TSType): PropertyLiteral | undefined {
  if (type.type !== "TSLiteralType") return undefined;
  const literal = type.literal;
  if (literal.type === "Literal" && ["boolean", "string", "number"].includes(typeof literal.value)) return literal.value as PropertyLiteral;
  if (literal.type === "UnaryExpression" && literal.operator === "-" && isNumberLiteral(literal.argument)) return -literal.argument.value;
  return undefined;
}
function maximum(type: TSType | undefined): number | undefined {
  return type?.type === "TSLiteralType" && isNumberLiteral(type.literal) && Number.isSafeInteger(type.literal.value) && type.literal.value >= 0 ? type.literal.value : undefined;
}

/** Declared generator domains, not authenticated semantic type or proof facts. */
export function propertyTypeDomain(type: TSType | undefined): PropertyTestDomain | undefined {
  if (!type) return undefined;
  if (type.type === "TSParenthesizedType") return propertyTypeDomain(type.typeAnnotation);
  if (type.type === "TSTypeLiteral") {
    const fields: Record<string, PropertyTestDomain> = {}, optional: string[] = [];
    for (const member of type.members) {
      if (member.type !== "TSPropertySignature" || member.computed || !member.typeAnnotation
        || member.key.type !== "Identifier" && !(member.key.type === "Literal" && typeof member.key.value === "string")) return undefined;
      const name = member.key.type === "Identifier" ? member.key.name : String(member.key.value);
      if (["__proto__", "prototype", "constructor"].includes(name) || Object.hasOwn(fields, name)) return undefined;
      const field = propertyTypeDomain(member.typeAnnotation.typeAnnotation);
      if (!field || typeof field === "object" && field.kind === "union") return undefined;
      if (member.optional) {
        if (typeof field === "object" && field.kind !== "record") return undefined;
        optional.push(name);
      }
      fields[name] = field;
    }
    return Object.keys(fields).length ? { kind: "record", fields, ...(optional.length ? { optional } : {}) } : undefined;
  }
  if (type.type === "TSUnionType") {
    const members = type.types.map(member => propertyTypeDomain(member) ?? (literalValue(member) === undefined ? undefined : { kind: "literal" as const, value: literalValue(member)! }));
    if (members.some(member => member === undefined || typeof member === "object" && member.kind !== "literal")) return undefined;
    return { kind: "union", members: members as Array<PropertyBoundaryKind | { kind: "literal"; value: PropertyLiteral }> };
  }
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return undefined;
  const name = type.typeName.name, args = type.typeArguments?.params ?? [];
  if (supported.has(name as PropertyBoundaryKind)) return name as PropertyBoundaryKind;
  if ((name === "BoundedUint8Array" || name === "BoundedUint32Array") && args.length === 1) {
    const max = maximum(args[0]);
    return max === undefined ? undefined : { kind: "bounded-array", element: name === "BoundedUint8Array" ? "U8" : "U32", maximum: max };
  }
  if (name === "BoundedSet" && args.length === 2) {
    const element = propertyTypeDomain(args[0]), max = maximum(args[1]);
    return typeof element === "string" && max !== undefined ? { kind: "bounded-set", element, maximum: max } : undefined;
  }
  if (name === "BoundedMap" && args.length === 3) {
    const key = propertyTypeDomain(args[0]), value = propertyTypeDomain(args[1]), max = maximum(args[2]);
    return typeof key === "string" && typeof value === "string" && max !== undefined ? { kind: "bounded-map", key, value, maximum: max } : undefined;
  }
  return undefined;
}

export function specializationValueMatches(type: TSType | undefined, value: PropertyLiteral): boolean {
  if (type?.type === "TSStringKeyword") return typeof value === "string";
  if (type?.type === "TSNumberKeyword") return typeof value === "number" && Number.isFinite(value);
  if (type?.type === "TSBooleanKeyword") return typeof value === "boolean";
  return false;
}

const expressionTexts = new WeakMap<Node, string>();
export function propertyExpression(expression: string): Node {
  const parsed = parseOxcExpression(expression, "property");
  const visit = (node: Node): void => {
    expressionTexts.set(node, parsed.source.slice(node.start, node.end));
    for (const child of oxcChildren(node)) visit(child);
  };
  visit(parsed.expression);
  return parsed.expression;
}
export const propertyExpressionText = (node: Node): string => expressionTexts.get(node) ?? node.type;

export function propertyPath(node: Node): { root: string; path: string[] } | undefined {
  if (isIdentifier(node)) return { root: node.name, path: [] };
  if (!isStaticMember(node) || node.property.type !== "Identifier") return undefined;
  const parent = propertyPath(node.object);
  return parent ? { root: parent.root, path: [...parent.path, node.property.name] } : undefined;
}

export function exactUnaryPredicate(requirement: string, parameter: string): string | undefined {
  try {
    let expression = propertyExpression(requirement);
    while (expression.type === "ParenthesizedExpression") expression = expression.expression;
    return isCall(expression) && isIdentifier(expression.callee) && expression.arguments.length === 1
      && isIdentifier(expression.arguments[0]!) && expression.arguments[0]!.name === parameter ? expression.callee.name : undefined;
  } catch { return undefined; }
}

function validateStructured(node: Node, allowed: ReadonlySet<string>): void {
  if (isIdentifier(node) || node.type === "Literal" && ["number", "string", "boolean"].includes(typeof node.value)) return;
  if (isWrapped(node)) return validateStructured(node.expression, allowed);
  if (node.type === "UnaryExpression" && ["!", "-"].includes(node.operator)) return validateStructured(node.argument, allowed);
  if (isStaticMember(node) && propertyPath(node)) return;
  if (isCall(node) && isStaticMember(node.callee) && node.callee.property.type === "Identifier" && ["has", "get"].includes(node.callee.property.name)
    && isIdentifier(node.callee.object) && node.arguments.length === 1 && isNumberLiteral(node.arguments[0]!)) return;
  if (isCall(node) && isIdentifier(node.callee) && allowed.has(node.callee.name) && node.arguments.length === 1) return validateStructured(node.arguments[0]!, allowed);
  if (isComputedMember(node) && isIdentifier(node.object) && (isNumberLiteral(node.property) || isIdentifier(node.property))) return;
  if (isBinary(node) && ["+", "-", "*", "/", "%", "<", "<=", ">", ">=", "==", "===", "!=", "!==", "&&", "||"].includes(node.operator)) {
    validateStructured(node.left, allowed); validateStructured(node.right, allowed); return;
  }
  throw new Error(`unsupported property expression: ${propertyExpressionText(node)}`);
}
export function validatePropertyExpression(expression: string, allowed: ReadonlySet<string> = new Set()): void {
  try { parseLogicExpression(expression); } catch { validateStructured(propertyExpression(expression), allowed); }
}
