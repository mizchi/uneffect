import type { Node, ObjectExpression, Expression } from "oxc-parser";
import type { OxcSource } from "./source.js";

/** Syntax-only import bindings. Semantic authentication belongs to the checker adapter. */
export function dslImports(source: OxcSource, helpers: readonly string[]): Map<string, string> {
  const imported = new Map<string, string>();
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const element of statement.specifiers) {
      if (element.type !== "ImportSpecifier") continue;
      const name = element.imported.type === "Identifier" ? element.imported.name : element.imported.value;
      if (!helpers.includes(name)) continue;
      if (statement.source.value !== "@mizchi/uneffect/spec") throw new Error(`${name} must be imported from @mizchi/uneffect/spec`);
      if (statement.importKind === "type" || element.importKind === "type") throw new Error(`${source.fileName}: ${name} must be a value import`);
      imported.set(element.local.name, name);
    }
  }
  return imported;
}

export function dslObject(source: OxcSource, node: Node | null | undefined, context: string, parentheses = false): ObjectExpression {
  while (parentheses && node?.type === "ParenthesizedExpression") node = node.expression;
  if (node?.type !== "ObjectExpression") throw new Error(`${source.fileName}: ${context} must be an object literal`);
  return node;
}

export function dslFields(source: OxcSource, object: ObjectExpression, context: string, allowShorthand = false): Map<string, Expression> {
  const result = new Map<string, Expression>();
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed || property.method || (property.shorthand && (!allowShorthand || property.value.type !== "Identifier")) || property.kind !== "init"
      || (property.key.type !== "Identifier" && !(property.key.type === "Literal" && typeof property.key.value === "string"))) {
      throw new Error(`${source.fileName}: ${context} requires static properties`);
    }
    const name = property.key.type === "Identifier" ? property.key.name : String(property.key.value);
    if (name === "__proto__") throw new Error(`${source.fileName}: ${context} does not support prototype setters`);
    if (name.includes("*/") || /[\r\n\u2028\u2029]/u.test(name)) throw new Error(`${source.fileName}: ${context} key cannot escape a generated annotation`);
    if (result.has(name)) throw new Error(`${source.fileName}: duplicate ${context} property`);
    result.set(name, property.value as Expression);
  }
  return result;
}

export function dslCallback(source: OxcSource, node: Node | null | undefined, context: string, predicate = false): Expression {
  const description = predicate ? "predicate with one destructured parameter" : "function with one destructured state parameter";
  if (!node || node.type !== "ArrowFunctionExpression" || node.async || node.params.length !== 1 || node.body.type === "BlockStatement") {
    throw new Error(`${source.fileName}: ${context} must be a single-expression ${description}`);
  }
  const parameter = node.params[0]!;
  if (parameter.type !== "ObjectPattern" || parameter.optional) throw new Error(`${source.fileName}: ${context} must destructure ${predicate ? "contract values" : "temporal state"}`);
  for (const property of parameter.properties) {
    if (property.type !== "Property" || property.computed || !property.shorthand || property.value.type !== "Identifier") {
      throw new Error(`${source.fileName}: ${context} only supports direct ${predicate ? "contract" : "state"} destructuring`);
    }
  }
  return node.body;
}

/** Prevent symbolic source text from escaping generated annotation comments. */
export function dslExpressionText(source: OxcSource, node: Node): string {
  const text = source.textOf(node);
  if (text.includes("*/")) throw new Error(`${source.fileName}: DSL expression cannot contain a comment terminator`);
  return text;
}
