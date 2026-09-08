import { parseSync, type Node } from "oxc-parser";
import { oxcChildren } from "../oxc/source.js";
import type { CorsaApiFrontend } from "./corsa-api-frontend.js";
import { collectFrozenEffectTables } from "./corsa-effect-tables.js";

/** Native identities link bodies; shorthand writes conservatively exclude same-name candidates. */
export function collectCorsaEffectBindings(frontend: CorsaApiFrontend, file: string, text: string): {
  declarations: Array<{ symbolId: string; start: number; name: string }>;
  writes: Set<string>;
  ambiguousWrites: Set<string>;
  calls: Map<number, string>;
} {
  const parsed = parseSync(file, text, { lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  const declarations: Array<{ symbolId: string; start: number; name: string }> = [];
  const writes = new Set<string>();
  const ambiguousWrites = new Set<string>();
  const calls = new Map<number, string>();
  if (parsed.errors.length) return { declarations, writes, ambiguousWrites, calls };
  const recordWrite = (node: Node, shorthand = false): void => {
    if (node.type === "Identifier") {
      const symbol = frontend.getSymbolAtPosition(file, node.start);
      if (symbol) writes.add((frontend.getAliasedSymbol(symbol) ?? symbol).id);
      // At a shorthand target, the position query can return the property symbol,
      // not the binding being assigned. Never use that as evidence of no write.
      if (shorthand) ambiguousWrites.add(node.name);
    } else if (node.type !== "MemberExpression") {
      for (const child of oxcChildren(node)) recordWrite(child, shorthand || node.type === "Property" && node.shorthand);
    }
  };
  let dynamicScope = false;
  const visit = (node: Node): void => {
    if (node.type === "AssignmentExpression") recordWrite(node.left);
    if (node.type === "UpdateExpression") recordWrite(node.argument);
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") recordWrite(node.left);
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "eval") dynamicScope = true;
    for (const child of oxcChildren(node)) visit(child);
  };
  visit(parsed.program);
  if (dynamicScope) return { declarations, writes, ambiguousWrites, calls };
  for (const statement of parsed.program.body) {
    const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement;
    if (node?.type !== "FunctionDeclaration" || !node.id || !node.body || node.async || node.generator) continue;
    const symbol = frontend.getSymbolAtPosition(file, node.id.start);
    if (symbol?.declarations?.length === 1) declarations.push({ symbolId: symbol.id, start: node.start, name: node.id.name });
  }
  const frozen = collectFrozenEffectTables(frontend, file, parsed.program);
  declarations.push(...frozen.declarations);
  return { declarations, writes, ambiguousWrites, calls: frozen.calls };
}
