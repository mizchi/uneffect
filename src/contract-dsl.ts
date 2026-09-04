import ts from "@typescript/typescript6";
import { posix } from "node:path";
import { extractAnnotations } from "./annotations.js";
import type { NumericDomain } from "./invariant-ir.js";
import type { TemporalType } from "./temporal-dsl.js";

type ValueOf<Type> = Type extends TemporalType<infer Value> ? Value : never;
type ParameterShape = Readonly<Record<string, TemporalType<unknown>>>;
type ParametersOf<Shape extends ParameterShape> = { readonly [Name in keyof Shape]: ValueOf<Shape[Name]> };
type ContractPredicate<Value> = (values: Value) => boolean;
export interface ContractDefinition<Parameters extends ParameterShape, Result extends TemporalType<unknown>> {
  readonly parameters: Parameters;
  readonly returns: Result;
  readonly requires?: ContractPredicate<ParametersOf<Parameters>> | readonly ContractPredicate<ParametersOf<Parameters>>[];
  readonly ensures: ContractPredicate<ParametersOf<Parameters> & { readonly result: ValueOf<Result> }> | readonly ContractPredicate<ParametersOf<Parameters> & { readonly result: ValueOf<Result> }>[];
}
export const defineContract = <const Parameters extends ParameterShape, const Result extends TemporalType<unknown>>(definition: ContractDefinition<Parameters, Result>): ContractDefinition<Parameters, Result> => definition;
export const nat = (): TemporalType<number> => ({ kind: "nat" }) as TemporalType<number>;
export const float = (): TemporalType<number> => ({ kind: "float" }) as TemporalType<number>;

export interface ParsedContractDsl {
  parameters: Array<{ name: string; domain: NumericDomain }>;
  resultDomain: NumericDomain;
  requires: string[];
  ensures: string[];
}
export interface ContractClauseProvenance {
  kind: "requires" | "ensures";
  expression: string;
  fileName: string;
  line: number;
  column: number;
  span: { start: number; end: number };
}
export interface PreparedContractDslLinks {
  files: Record<string, string>;
  provenance: Record<string, ContractClauseProvenance[]>;
}

function name(source: ts.SourceFile, node: ts.BindingName | ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  throw new Error(`${source.fileName}: contract DSL requires static names`);
}
function object(source: ts.SourceFile, expression: ts.Expression | undefined, context: string): ts.ObjectLiteralExpression {
  if (expression && ts.isObjectLiteralExpression(expression)) return expression;
  throw new Error(`${source.fileName}: ${context} must be an object literal`);
}
function fields(source: ts.SourceFile, value: ts.ObjectLiteralExpression, context: string): Map<string, ts.Expression> {
  const entries = value.properties.map((property): [string, ts.Expression] => {
    if (!ts.isPropertyAssignment(property)) throw new Error(`${source.fileName}: ${context} requires static properties`);
    return [name(source, property.name), property.initializer];
  });
  const result = new Map(entries);
  if (result.size !== entries.length) throw new Error(`${source.fileName}: duplicate ${context} property`);
  return result;
}
function predicate(source: ts.SourceFile, expression: ts.Expression | undefined, context: string): string {
  if (!expression || (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) || expression.parameters.length !== 1 || ts.isBlock(expression.body)) {
    throw new Error(`${source.fileName}: ${context} must be a single-expression predicate with one destructured parameter`);
  }
  if (!ts.isObjectBindingPattern(expression.parameters[0]!.name)) throw new Error(`${source.fileName}: ${context} must destructure contract values`);
  return expression.body.getText(source);
}
function predicates(source: ts.SourceFile, expression: ts.Expression | undefined, context: string): string[] {
  if (expression && ts.isArrayLiteralExpression(expression)) {
    if (expression.elements.length === 0) throw new Error(`${source.fileName}: ${context} must not be empty`);
    return expression.elements.map((item, index) => predicate(source, item, `${context} ${index + 1}`));
  }
  return [predicate(source, expression, context)];
}

export function parseContractDsl(fileName: string, text: string, exportName: string): ParsedContractDsl {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), imported = new Map<string, string>();
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (["defineContract", "int", "nat", "float", "bool"].includes(exported)) {
        if (statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") throw new Error(`${exported} must be imported from @mizchi/uneffect/spec`);
        imported.set(element.name.text, exported);
      }
    }
  }
  let definition: ts.CallExpression | undefined;
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    for (const declaration of statement.declarationList.declarations) if (name(source, declaration.name) === exportName && declaration.initializer && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression) && imported.get(declaration.initializer.expression.text) === "defineContract") definition = declaration.initializer;
  }
  if (!definition) throw new Error(`${fileName}: does not export contract ${exportName}`);
  const root = fields(source, object(source, definition.arguments[0], "contract definition"), "contract definition");
  if (![3, 4].includes(root.size) || !root.has("parameters") || !root.has("returns") || !root.has("ensures")) throw new Error(`${fileName}: contract requires parameters, returns, ensures, and optional requires`);
  const descriptor = (expression: ts.Expression | undefined, context: string): NumericDomain => {
    if (!expression || !ts.isCallExpression(expression) || expression.arguments.length !== 0 || !ts.isIdentifier(expression.expression)) throw new Error(`${fileName}: ${context} requires a scalar descriptor`);
    const helper = imported.get(expression.expression.text);
    if (helper !== "int" && helper !== "nat" && helper !== "float" && helper !== "bool") throw new Error(`${fileName}: unsupported contract type descriptor`);
    return helper;
  };
  const parameters = [...fields(source, object(source, root.get("parameters"), "contract parameters"), "contract parameters")]
    .map(([parameter, value]) => ({ name: parameter, domain: descriptor(value, `parameter ${parameter}`) }));
  return {
    parameters,
    resultDomain: descriptor(root.get("returns"), "contract return"),
    requires: root.has("requires") ? predicates(source, root.get("requires"), "requires") : [],
    ensures: predicates(source, root.get("ensures"), "ensures"),
  };
}

function contractClauseProvenance(fileName: string, text: string, exportName: string): ContractClauseProvenance[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let root: ts.ObjectLiteralExpression | undefined;
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === exportName
      && declaration.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.arguments[0]
      && ts.isObjectLiteralExpression(declaration.initializer.arguments[0])) root = declaration.initializer.arguments[0];
  }
  if (!root) return [];
  const result: ContractClauseProvenance[] = [];
  for (const property of root.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
    if (propertyName !== "requires" && propertyName !== "ensures") continue;
    const values = ts.isArrayLiteralExpression(property.initializer) ? property.initializer.elements : [property.initializer];
    for (const value of values) {
      if ((!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) || ts.isBlock(value.body)) continue;
      const start = value.body.getStart(source), position = source.getLineAndCharacterOfPosition(start);
      result.push({
        kind: propertyName,
        expression: value.body.getText(source),
        fileName,
        line: position.line + 1,
        column: position.character + 1,
        span: { start, end: value.body.getEnd() },
      });
    }
  }
  return result;
}

function typeDomain(checker: ts.TypeChecker, type: ts.Type): NumericDomain | undefined {
  const named = type.aliasSymbol?.name ?? type.getSymbol()?.name;
  if (named === "Nat") return "nat";
  if (named === "Float") return "float";
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
    const fromNumericModule = symbol?.declarations?.some((item) =>
      /(?:^|\/)numeric\.(?:d\.)?ts$/.test(item.getSourceFile().fileName.replaceAll("\\", "/")));
    if (importedFromPublicPackage && fromNumericModule && (symbol?.name === "Nat" || symbol?.name === "Float")) {
      return symbol.name === "Nat" ? "nat" : "float";
    }
  }
  return node ? typeDomain(checker, checker.getTypeFromTypeNode(node)) : undefined;
}

export function validateContractDslLink(program: ts.Program, implementationFile: string, specificationFile: string, contract: ParsedContractDsl): void {
  const implementation = program.getSourceFile(implementationFile), specification = program.getSourceFile(specificationFile);
  if (!implementation || !specification) throw new Error(`${implementationFile}: linked contract files must belong to the TypeScript Program`);
  const checker = program.getTypeChecker();
  const linked = implementation.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && extractAnnotations(implementation.text.slice(statement.getFullStart(), statement.getStart(implementation)), "contract_from").length > 0);
  if (linked.length !== 1 || !linked[0]!.name || !linked[0]!.body) throw new Error(`${implementationFile}: contract from must directly precede exactly one function declaration`);
  const declaration = linked[0]!;
  if (declaration.parameters.length !== contract.parameters.length) throw new Error(`${implementationFile}: linked contract parameter count does not match ${declaration.name!.text}`);
  declaration.parameters.forEach((parameter, index) => {
    const expected = contract.parameters[index]!;
    if (!ts.isIdentifier(parameter.name) || parameter.name.text !== expected.name || parameter.questionToken || parameter.dotDotDotToken) throw new Error(`${implementationFile}: linked contract parameter ${index + 1} must be required identifier ${expected.name}`);
    const actual = typeNodeDomain(checker, parameter.type) ?? typeDomain(checker, checker.getTypeAtLocation(parameter));
    if (actual !== expected.domain) throw new Error(`${implementationFile}: linked contract parameter ${expected.name} expects ${expected.domain}, implementation is ${actual ?? "unsupported"}`);
  });
  const signature = checker.getSignatureFromDeclaration(declaration), result = typeNodeDomain(checker, declaration.type)
    ?? (signature && typeDomain(checker, checker.getReturnTypeOfSignature(signature)));
  if (result !== contract.resultDomain) throw new Error(`${implementationFile}: linked contract result expects ${contract.resultDomain}, implementation is ${result ?? "unsupported"}`);
  for (const statement of specification.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "@mizchi/uneffect/spec") {
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = element.propertyName?.text ?? element.name.text;
      if (!["defineContract", "int", "nat", "float", "bool"].includes(exported)) continue;
      let symbol = checker.getSymbolAtLocation(element.name);
      if (symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const expectedFile = exported === "defineContract" || exported === "nat" || exported === "float" ? "contract-dsl" : "temporal-dsl";
      const valid = symbol?.name === exported && symbol.declarations?.some((item) => new RegExp(`(?:^|/)${expectedFile}\\.(?:d\\.)?ts$`).test(item.getSourceFile().fileName.replaceAll("\\", "/")));
      if (!valid) throw new Error(`${specificationFile}: ${element.name.text} does not resolve to @mizchi/uneffect/spec#${exported} by TypeChecker symbol identity`);
    }
  }
}

export function prepareContractDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): PreparedContractDslLinks {
  const output = { ...files }, annotationPrefix = ["uneffect", ""].join(":");
  const provenance: Record<string, ContractClauseProvenance[]> = {};
  for (const [fileName, source] of Object.entries(files)) {
    const links = extractAnnotations(source, "contract_from");
    if (links.length === 0) continue;
    if (links.length !== 1) throw new Error(`${fileName}: expected exactly one uneffect:contract_from declaration`);
    const quoted = /^(?:"([^"]+)"|'([^']+)')$/.exec(links[0]!);
    if (!quoted) throw new Error(`${fileName}: contract from requires a quoted relative .uneffect.ts path and export`);
    const reference = quoted[1] ?? quoted[2]!, hash = reference.lastIndexOf("#"), requested = reference.slice(0, hash), exportName = reference.slice(hash + 1);
    if (hash < 0 || (!requested.startsWith("./") && !requested.startsWith("../")) || !requested.endsWith(".uneffect.ts") || !/^[A-Za-z_$][\w$]*$/.test(exportName)) throw new Error(`${fileName}: invalid contract specification reference`);
    const specificationFile = posix.normalize(posix.join(posix.dirname(fileName), requested)), specification = files[specificationFile];
    if (specification === undefined) throw new Error(`${fileName}: contract specification ${specificationFile} does not exist in the selected project`);
    const contract = parseContractDsl(specificationFile, specification, exportName);
    provenance[fileName] = contractClauseProvenance(specificationFile, specification, exportName);
    if (program) validateContractDslLink(program, fileName, specificationFile, contract);
    const body = [
      ...contract.parameters.filter((item) => item.domain === "nat" || item.domain === "float").map((item) => `assert ${item.name}: ${item.domain === "nat" ? "Nat" : "Float"}`),
      ...(contract.resultDomain === "nat" || contract.resultDomain === "float" ? [`returns ${contract.resultDomain === "nat" ? "Nat" : "Float"}`] : []),
      ...contract.requires.map((value) => `requires ${value}`),
      ...contract.ensures.map((value) => `ensures ${value}`),
    ].join("\n * ");
    output[fileName] = source.replace(/\/\*\s*uneffect\s*:\s*contract_from\s+(?:"[^"]+"|'[^']+')\s*\*\//, `/* ${annotationPrefix}\n * ${body}\n */`);
  }
  return { files: output, provenance };
}

export function materializeContractDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): Record<string, string> {
  return prepareContractDslLinks(files, program).files;
}
