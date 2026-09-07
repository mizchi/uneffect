import ts from "@typescript/typescript6";
import { prepareCapabilityDslSourceLinks } from "./capability-dsl-source.js";
import type { PreparedCapabilityDslLinks } from "./capability-dsl-source.js";
export { Builtin, Console, Custom, Fetch, FsRead, FsWrite, Throw, defineCapability, defineEffectSchema } from "./capability-authoring.js";
export type { BuiltinEffectName, CapabilityDefinition, CapabilityDescriptor, LocalEffectSchema } from "./capability-authoring.js";
export { parseCapabilityDsl, parseCapabilityDslWithSchemas } from "./capability-dsl-source.js";
export type { ParsedCapabilityDsl, PreparedCapabilityDslLinks } from "./capability-dsl-source.js";

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

export function validateCapabilityDslHelperIdentities(program: ts.Program, fileName: string): void {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`${fileName}: capability specification is not part of the TypeScript Program`);
  const checker = program.getTypeChecker(), helpers = new Set(["defineCapability", "defineEffectSchema", "Custom", "Console", "Fetch", "FsRead", "FsWrite", "Throw", "Builtin"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (!helpers.has(exported)) continue;
      const symbol = checker.getSymbolAtLocation(element.name), target = symbol && unalias(checker, symbol);
      const valid = target?.name === exported && target.declarations?.some((declaration) =>
        /(?:^|\/)capability-(?:dsl|authoring)\.(?:d\.)?ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      if (!valid) throw new Error(`${fileName}: ${element.name.text} does not resolve to @mizchi/uneffect/spec#${exported} by TypeChecker symbol identity`);
    }
  }
}

/** Compatibility adapter retaining Program helper authentication. */
export function prepareCapabilityDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): PreparedCapabilityDslLinks {
  return prepareCapabilityDslSourceLinks(files, program ? fileName => validateCapabilityDslHelperIdentities(program, fileName) : undefined);
}
export function materializeCapabilityDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): Record<string, string> {
  return prepareCapabilityDslLinks(files, program).files;
}
