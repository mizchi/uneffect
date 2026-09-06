/** Optional repository adapter. Only this layer needs a TypeScript parser/Node. */
import { posix } from "node:path";
import ts from "@typescript/typescript6";
import type { DependencyNode } from "./contracts.js";

/** Snapshot of literal ESM import dependencies, including type-only dependencies.
 * Keys must be normalized repository-relative POSIX paths. This is not a build resolver:
 * external packages, tsconfig aliases, CommonJS require and filesystem reads are outside scope.
 */
export function extractImportGraph(sources: ReadonlyMap<string, string>) {
  const nodes: DependencyNode[] = [];
  const externalSpecifiers = new Set<string>();
  const unresolved: { file: string; specifier: string }[] = [];
  for (const file of [...sources.keys()].sort()) {
    const dependencies = new Set<string>();
    function record(specifier: string) {
      if (!specifier.startsWith(".")) { externalSpecifiers.add(specifier); return; }
      const base = posix.join(posix.dirname(file), specifier);
      const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".d.ts"),
        `${base}.ts`, `${base}/index.ts`];
      const resolved = candidates.find(candidate => sources.has(candidate));
      if (resolved) dependencies.add(resolved);
      else unresolved.push({ file, specifier });
    }
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)) record(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal)) record(node.argument.literal.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) record(argument.text);
        else unresolved.push({ file, specifier: "<computed import>" });
      }
      ts.forEachChild(node, visit);
    }
    visit(ts.createSourceFile(file, sources.get(file)!, ts.ScriptTarget.Latest, true));
    nodes.push({ id: file, dependencies: [...dependencies].sort() });
  }
  return { nodes, externalSpecifiers: [...externalSpecifiers].sort(), unresolved };
}
