import ts from "../support/typescript-compiler.js";
import { resolveTemporalDslSourceLink } from "./temporal-dsl-source.js";
import type { TemporalDslLink } from "./temporal-dsl-source.js";
export { bool, defineTemporal, int, text } from "./temporal-authoring.js";
export type { TemporalDefinition, TemporalType } from "./temporal-authoring.js";
export { parseTemporalDsl } from "./temporal-dsl-source.js";
export type { TemporalDslLink } from "./temporal-dsl-source.js";

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Verify that DSL calls resolve to Uneffect's declarations, not same-spelled user code. */
export function validateTemporalDslHelperIdentities(program: ts.Program, fileName: string): void {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`${fileName}: temporal specification is not part of the TypeScript Program`);
  const checker = program.getTypeChecker();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (!["defineTemporal", "int", "bool", "text"].includes(exported)) continue;
      const symbol = checker.getSymbolAtLocation(element.name);
      const target = symbol && unalias(checker, symbol);
      const declarations = target?.declarations ?? [];
      const valid = target?.name === exported && declarations.some((declaration) =>
        /(?:^|\/)temporal-(?:dsl|authoring)\.(?:d\.)?ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      if (!valid) throw new Error(`${fileName}: ${element.name.text} does not resolve to @mizchi/uneffect/spec#${exported} by TypeChecker symbol identity`);
    }
  }
}

/** Compatibility adapter: source parsing plus optional Program authentication. */
export function resolveTemporalDslLink(
  implementationFile: string,
  implementationSource: string,
  files: Readonly<Record<string, string>>,
  program?: ts.Program,
): TemporalDslLink | undefined {
  const link = resolveTemporalDslSourceLink(implementationFile, implementationSource, files);
  if (link && program) validateTemporalDslHelperIdentities(program, link.specificationFile);
  return link;
}
