import type { Node, Program } from "oxc-parser";
import { oxcChildren } from "../frontends/oxc/source.js";

interface EnumerationQueries {
  symbolId(node: Node): string | undefined;
  originalTable(node: Node): boolean;
  objectCall(node: Node, name: string, arity: number): boolean;
}

/** Const loop keys enumerate the permanent own properties of a frozen literal. */
export function frozenRegistryKeys(program: Program, body: Node, binding: Node | undefined, queries: EnumerationQueries): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!binding) return keys;
  const declaration = program.body.flatMap(statement => {
    const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    return node?.type === "VariableDeclaration" && node.kind === "const" ? node.declarations : [];
  }).find(node => node.id === binding);
  const init = declaration?.init;
  if (!init || init.type !== "CallExpression" || !queries.objectCall(init, "freeze", 1)) return keys;
  const value = init.arguments[0];
  if (value?.type !== "ObjectExpression" || !value.properties.every(property => property.type === "Property"
    && property.kind === "init" && !property.computed && !property.method && property.value.type === "Literal")) return keys;
  const visit = (node: Node): void => {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return;
    if (node.type === "ForOfStatement" && !node.await && node.left.type === "VariableDeclaration" && node.left.kind === "const"
      && node.left.declarations.length === 1 && node.right.type === "CallExpression" && queries.objectCall(node.right, "keys", 1)
      && queries.originalTable(node.right.arguments[0]!)) {
      const id = node.left.declarations[0]!.id;
      if (id.type === "Identifier") { const symbol = queries.symbolId(id); if (symbol) keys.add(symbol); }
    }
    for (const child of oxcChildren(node)) visit(child);
  };
  visit(body);
  return keys;
}
