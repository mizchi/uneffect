import { readFileSync } from "node:fs";
import ts from "../support/typescript-compiler.js";
import type { RefinementBindingManifest } from "./binding-contracts.js";
import { refinementDslSpecificationFile, resolveRefinementDslSourceLinks } from "./refinement-dsl-source.js";
import { refinementCallableReferences, validateRefinementCallableTypes, type RefinementCallableReference } from "./refinement-link.js";
export { defineRefinement, globalRuntime, identityProjection, mapFromEntriesProjection, nodeGlobalRuntime, setFromArrayProjection } from "./refinement-authoring.js";
export type { RefinementCallable, RefinementDefinition, RefinementProjection, RefinementRuntimeDescriptor } from "./refinement-authoring.js";
export { parseRefinementDsl } from "./refinement-dsl-source.js";
export type { ParsedRefinementDefinition } from "./binding-contracts.js";

function programReferenceNode(source: ts.SourceFile, reference: RefinementCallableReference): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (node.pos > reference.identifier.start || node.end < reference.identifier.end) return;
    if (ts.isIdentifier(node) && node.getStart(source) === reference.identifier.start && node.end === reference.identifier.end) found = node;
    if (!found) node.forEachChild(visit);
  };
  visit(source);
  if (!found) throw new Error(`${source.fileName}: missing Program callable reference ${reference.context}`);
  return found;
}

function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Validates helper provenance and callable compatibility against the exact Program. */
export function validateRefinementDslIdentities(program: ts.Program, fileName: string): void {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`${fileName}: refinement specification is not part of the TypeScript Program`);
  const checker = program.getTypeChecker();
  const helperNames = new Set(["defineRefinement", "globalRuntime", "nodeGlobalRuntime", "identityProjection", "setFromArrayProjection", "mapFromEntriesProjection"]);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (!helperNames.has(exported)) continue;
      const symbol = checker.getSymbolAtLocation(element.name), target = symbol && unalias(checker, symbol);
      const valid = target?.name === exported && target.declarations?.some((declaration) =>
        /(?:^|\/)refinement-(?:dsl|authoring)\.(?:d\.)?ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      if (!valid) throw new Error(`${fileName}: ${element.name.text} does not resolve to @mizchi/uneffect/spec#${exported} by TypeChecker symbol identity`);
    }
  }

  const references = refinementCallableReferences(fileName, source.text);
  validateRefinementCallableTypes(fileName, references, reference => {
    const node = programReferenceNode(source, reference);
    const signatures = checker.getSignaturesOfType(checker.getTypeAtLocation(node), ts.SignatureKind.Call);
    if (signatures.length !== 1) throw new Error(`${fileName}: ${reference.context} must resolve to exactly one callable signature by TypeChecker identity`);
    const signature = signatures[0]!;
    return { parameters: signature.getParameters().map(parameter => checker.getTypeOfSymbolAtLocation(parameter, signature.getDeclaration())), result: checker.getReturnTypeOfSignature(signature) };
  }, (left, right) => checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left),
  type => (type.flags & ts.TypeFlags.BooleanLike) !== 0);
}

function validateRefinementDslCallableOrigins(program: ts.Program, specificationFile: string, implementationFile: string): void {
  const source = program.getSourceFile(specificationFile);
  if (!source) throw new Error(`${specificationFile}: refinement specification is not part of the TypeScript Program`);
  const checker = program.getTypeChecker();
  const references = refinementCallableReferences(specificationFile, source.text);
  const expected = implementationFile.replaceAll("\\", "/");
  for (const reference of references) {
    const name = reference.context, node = programReferenceNode(source, reference);
    const shorthand = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : undefined;
    const symbol = shorthand ?? checker.getSymbolAtLocation(node), target = symbol && unalias(checker, symbol);
    const declarations = target?.declarations ?? [];
    if (!declarations.some((declaration) => declaration.getSourceFile().fileName.replaceAll("\\", "/") === expected)) {
      throw new Error(`${specificationFile}: ${name} does not resolve to an export declared by attached implementation ${implementationFile}`);
    }
  }
}

/** Compatibility adapter preserving helper, callable type, and implementation-origin checks. */
export function resolveRefinementDslLink(
  implementationFile: string,
  implementationSource: string,
  files: Readonly<Record<string, string>>,
  program?: ts.Program,
): RefinementBindingManifest {
  return resolveRefinementDslSourceLinks(implementationFile, implementationSource, files, program ? specificationFile => {
    validateRefinementDslIdentities(program, specificationFile);
    validateRefinementDslCallableOrigins(program, specificationFile, implementationFile);
  } : undefined);
}

/** Loads one attached typed specification from disk for Node-based tooling. */
export function resolveRefinementDslFileLink(
  implementationFile: string,
  program?: ts.Program,
): RefinementBindingManifest {
  const implementationSource = readFileSync(implementationFile, "utf8");
  const specificationFile = refinementDslSpecificationFile(implementationFile, implementationSource);
  const specificationSource = readFileSync(specificationFile, "utf8");
  return resolveRefinementDslLink(implementationFile, implementationSource, {
    [implementationFile]: implementationSource,
    [specificationFile]: specificationSource,
  }, program);
}
