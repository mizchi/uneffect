import type { Node, Program } from "oxc-parser";
import { oxcChildren } from "../oxc/source.js";
import type { CorsaApiFrontend } from "./corsa-api-frontend.js";

/** Stable receiver identity plus a literal member name authenticates frozen dispatch. */
export function collectFrozenEffectTables(frontend: CorsaApiFrontend, file: string, program: Program) {
  const declarations: Array<{ symbolId: string; start: number; name: string }> = [];
  const calls = new Map<number, string>();
  const identity = (node: Node) => {
    const symbol = frontend.getSymbolAtPosition(file, node.start);
    return symbol ? (frontend.getAliasedSymbol(symbol) ?? symbol).id : undefined;
  };
  const member = (node: Node, computed: boolean): string | undefined => {
    if (!computed && node.type === "Identifier") return node.name;
    if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) return String(node.value);
    return undefined;
  };
  const id = (receiver: string, name: string) => JSON.stringify(["frozen-effect-member", receiver, name]);
  const library = (node: Node) => frontend.getSymbolAtPosition(file, node.start)?.declarations
    ?.some(path => /(?:^|[/\\])lib\.es[\w.]*\.d\.ts$/iu.test(path)) === true;
  for (const statement of program.body) {
    const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (node?.type !== "VariableDeclaration" || node.kind !== "const") continue;
    for (const declaration of node.declarations) {
      const init = declaration.init;
      if (declaration.id.type !== "Identifier" || init?.type !== "CallExpression" || init.optional || init.arguments.length !== 1) continue;
      const callee = init.callee, table = init.arguments[0];
      if (callee.type !== "MemberExpression" || callee.optional || member(callee.property, callee.computed) !== "freeze"
        || callee.object.type !== "Identifier" || callee.object.name !== "Object" || !library(callee.object) || !library(callee.property)
        || table?.type !== "ObjectExpression") continue;
      const names = new Set<string>();
      if (!table.properties.every(property => {
        if (property.type !== "Property" || property.kind !== "init") return false;
        const name = member(property.key, property.computed);
        if (!name || names.has(name) || name === "__proto__") return false;
        names.add(name);
        return true;
      })) continue;
      const receiver = identity(declaration.id);
      if (!receiver) continue;
      for (const property of table.properties) {
        if (property.type !== "Property") continue;
        const body = property.value;
        if ((body.type !== "ArrowFunctionExpression" && body.type !== "FunctionExpression") || body.async || body.generator) continue;
        const name = member(property.key, property.computed)!;
        declarations.push({ symbolId: id(receiver, name), start: body.start, name });
      }
    }
  }
  const visit = (node: Node): void => {
    if (node.type === "CallExpression" && !node.optional && node.callee.type === "MemberExpression" && !node.callee.optional) {
      const callee = node.callee;
      const name = member(callee.property, callee.computed);
      const receiver = callee.object.type === "Identifier" ? identity(callee.object) : undefined;
      if (receiver && name) calls.set(node.start, id(receiver, name));
    }
    for (const child of oxcChildren(node)) visit(child);
  };
  visit(program);
  return { declarations, calls };
}
