import ts from "@typescript/typescript6";
import { inspectContractImplementation, validateContractSignatureDomains } from "./contract-link.js";
import { numericContractDomain } from "./numeric-contract-identity.js";
import type { NumericDomain } from "./logic-contracts.js";
import type { ParsedContractDsl, PreparedContractDslLinks } from "./contract-dsl-contracts.js";
import { prepareContractDslSourceLinks } from "./contract-dsl-source.js";
export { defineContract, float, nat } from "./contract-authoring.js";
export type { ContractDefinition } from "./contract-authoring.js";
export type { ParsedContractDsl, ContractClauseProvenance, PreparedContractDslLinks } from "./contract-dsl-contracts.js";
export { parseContractDsl } from "./contract-dsl-source.js";

function typeDomain(checker: ts.TypeChecker, type: ts.Type): NumericDomain | undefined {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const branded = numericContractDomain(symbol?.name, symbol?.declarations?.map(item => item.getSourceFile().fileName) ?? []);
  if (branded) return branded;
  if (type.flags & ts.TypeFlags.BooleanLike) return "bool";
  if (type.flags & ts.TypeFlags.NumberLike) return "int";
  return undefined;
}
function typeNodeDomain(checker: ts.TypeChecker, node: ts.TypeNode | undefined): NumericDomain | undefined {
  if (node && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const alias = checker.getSymbolAtLocation(node.typeName);
    const importedFromPublicPackage = Boolean(alias?.declarations?.some((declaration) => {
      if (!ts.isImportSpecifier(declaration)) return false;
      const importDeclaration = declaration.parent.parent.parent;
      return ts.isImportDeclaration(importDeclaration)
        && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && importDeclaration.moduleSpecifier.text === "@mizchi/uneffect";
    }));
    const symbol = alias && (alias.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(alias) : alias;
    const branded = numericContractDomain(symbol?.name, symbol?.declarations?.map(item => item.getSourceFile().fileName) ?? []);
    if (importedFromPublicPackage && branded) return branded;
  }
  return node ? typeDomain(checker, checker.getTypeFromTypeNode(node)) : undefined;
}

export function validateContractDslLink(program: ts.Program, implementationFile: string, specificationFile: string, contract: ParsedContractDsl): void {
  const implementation = program.getSourceFile(implementationFile), specification = program.getSourceFile(specificationFile);
  if (!implementation || !specification) throw new Error(`${implementationFile}: linked contract files must belong to the TypeScript Program`);
  const checker = program.getTypeChecker();
  const syntax = inspectContractImplementation(implementationFile, implementation.text, contract);
  // Oxc validates the declaration shape; the compatibility adapter locates only
  // the corresponding checker node in the same Program source.
  const declaration = implementation.statements.find(statement => statement.getStart(implementation) === syntax.start && statement.end === syntax.end) as ts.FunctionDeclaration | undefined;
  if (!declaration) throw new Error(`${implementationFile}: missing Program contract declaration`);
  const parameters = declaration.parameters.map(parameter => typeNodeDomain(checker, parameter.type) ?? typeDomain(checker, checker.getTypeAtLocation(parameter)));
  const signature = checker.getSignatureFromDeclaration(declaration), result = typeNodeDomain(checker, declaration.type)
    ?? (signature && typeDomain(checker, checker.getReturnTypeOfSignature(signature)));
  validateContractSignatureDomains(implementationFile, contract, parameters, result);
  for (const statement of specification.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "@mizchi/uneffect/spec") {
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (!["defineContract", "int", "nat", "float", "bool"].includes(exported)) continue;
      let symbol = checker.getSymbolAtLocation(element.name);
      if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const expectedFile = exported === "defineContract" || exported === "nat" || exported === "float" ? "contract-(?:dsl|authoring)" : "temporal-(?:dsl|authoring)";
      const valid = symbol?.name === exported && symbol.declarations?.some((item) => new RegExp(`(?:^|/)${expectedFile}\\.(?:d\\.)?ts$`).test(item.getSourceFile().fileName.replaceAll("\\", "/")));
      if (!valid) throw new Error(`${specificationFile}: ${element.name.text} does not resolve to @mizchi/uneffect/spec#${exported} by TypeChecker symbol identity`);
    }
  }
}

/** Compatibility adapter: source preparation plus optional Program signature/helper authentication. */
export function prepareContractDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): PreparedContractDslLinks {
  return prepareContractDslSourceLinks(files, program ? (implementationFile, specificationFile, contract) =>
    validateContractDslLink(program, implementationFile, specificationFile, contract) : undefined);
}

export function materializeContractDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): Record<string, string> {
  return prepareContractDslLinks(files, program).files;
}
