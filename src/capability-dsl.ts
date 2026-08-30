import ts from "typescript";
import { posix } from "node:path";
import { formatEffect, parseEffectExpression, type Effect } from "./capabilities.js";
import { extractAnnotations } from "./annotations.js";

declare const capabilityDescriptor: unique symbol;
export interface CapabilityDescriptor { readonly [capabilityDescriptor]: true }
export interface CapabilityDefinition { readonly effects: readonly CapabilityDescriptor[] }
export const defineCapability = <const Definition extends CapabilityDefinition>(definition: Definition): Definition => definition;
export const Console = (): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const Fetch = (_scope: { readonly methods: readonly ("GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS")[]; readonly urls: readonly string[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const FsRead = (_scope: { readonly paths: readonly string[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const FsWrite = (_scope: { readonly paths: readonly string[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export const Throw = (_error: ErrorConstructor): CapabilityDescriptor => ({}) as CapabilityDescriptor;

function staticName(source: ts.SourceFile, name: ts.BindingName | ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error(`${source.fileName}: capability DSL requires static names`);
}
function object(source: ts.SourceFile, expression: ts.Expression | undefined, context: string): ts.ObjectLiteralExpression {
  if (expression && ts.isObjectLiteralExpression(expression)) return expression;
  throw new Error(`${source.fileName}: ${context} must be an object literal`);
}
function fields(source: ts.SourceFile, value: ts.ObjectLiteralExpression, context: string): Map<string, ts.Expression> {
  const entries = value.properties.map((property): [string, ts.Expression] => {
    if (!ts.isPropertyAssignment(property)) throw new Error(`${source.fileName}: ${context} requires static properties`);
    return [staticName(source, property.name), property.initializer];
  });
  const result = new Map(entries);
  if (result.size !== entries.length) throw new Error(`${source.fileName}: duplicate ${context} property`);
  return result;
}
function strings(source: ts.SourceFile, expression: ts.Expression | undefined, context: string): string[] {
  if (!expression || !ts.isArrayLiteralExpression(expression)) throw new Error(`${source.fileName}: ${context} must be a literal array`);
  return expression.elements.map((element) => {
    if (!ts.isStringLiteral(element)) throw new Error(`${source.fileName}: ${context} only accepts string literals`);
    return element.text;
  });
}
function union(values: string[], context: string): string {
  if (values.length === 0) throw new Error(`${context} must not be empty`);
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

export function parseCapabilityDsl(fileName: string, text: string, exportName: string): Effect[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Map<string, string>();
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const name = element.propertyName?.text ?? element.name.text;
      if (["defineCapability", "Console", "Fetch", "FsRead", "FsWrite", "Throw"].includes(name)) {
        if (statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") throw new Error(`${name} must be imported from @mizchi/uneffect/spec`);
        imported.set(element.name.text, name);
      }
    }
  }
  let definition: ts.CallExpression | undefined;
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    for (const declaration of statement.declarationList.declarations) if (staticName(source, declaration.name) === exportName && declaration.initializer && ts.isCallExpression(declaration.initializer)
      && ts.isIdentifier(declaration.initializer.expression) && imported.get(declaration.initializer.expression.text) === "defineCapability") definition = declaration.initializer;
  }
  if (!definition) throw new Error(`${fileName}: does not export capability ${exportName}`);
  if (definition.arguments.length !== 1) throw new Error(`${fileName}: defineCapability requires one object literal`);
  const root = fields(source, object(source, definition.arguments[0], "capability definition"), "capability definition");
  if (root.size !== 1 || !root.has("effects")) throw new Error(`${fileName}: capability definition requires exactly effects`);
  const list = root.get("effects");
  if (!list || !ts.isArrayLiteralExpression(list)) throw new Error(`${fileName}: effects must be a literal array`);
  return list.elements.map((element) => {
    if (!ts.isCallExpression(element) || !ts.isIdentifier(element.expression)) throw new Error(`${fileName}: unsupported capability descriptor`);
    const helper = imported.get(element.expression.text);
    if (!helper || helper === "defineCapability") throw new Error(`${fileName}: unsupported capability descriptor ${element.getText(source)}`);
    if (helper === "Console") {
      if (element.arguments.length !== 0) throw new Error(`${fileName}: Console does not accept arguments`);
      return parseEffectExpression("Console");
    }
    if (helper === "Throw") {
      const error = element.arguments[0];
      if (element.arguments.length !== 1 || !error || !ts.isIdentifier(error)) throw new Error(`${fileName}: Throw requires an Error constructor identifier`);
      return parseEffectExpression(`Throw<${error.text}>`);
    }
    const scope = fields(source, object(source, element.arguments[0], helper), helper);
    if (element.arguments.length !== 1) throw new Error(`${fileName}: ${helper} requires one scope object`);
    if (helper === "Fetch") {
      if (scope.size !== 2 || !scope.has("methods") || !scope.has("urls")) throw new Error(`${fileName}: Fetch requires exactly methods and urls`);
      return parseEffectExpression(`Fetch<${union(strings(source, scope.get("methods"), "Fetch methods"), "Fetch methods")}, ${union(strings(source, scope.get("urls"), "Fetch urls"), "Fetch urls")}>`);
    }
    const field = helper === "FsRead" || helper === "FsWrite" ? "paths" : "";
    if (!field || scope.size !== 1 || !scope.has(field)) throw new Error(`${fileName}: unsupported capability descriptor ${helper}`);
    return parseEffectExpression(`${helper}<${union(strings(source, scope.get(field), `${helper} paths`), `${helper} paths`)}>`);
  });
}

export function materializeCapabilityDslLinks(files: Readonly<Record<string, string>>): Record<string, string> {
  const output = { ...files };
  for (const [fileName, source] of Object.entries(files)) {
    const links = extractAnnotations(source, "capability_from");
    if (links.length === 0) continue;
    if (links.length !== 1) throw new Error(`${fileName}: expected exactly one uneffect:capability from declaration`);
    const match = /^(?:"([^"]+)"|'([^']+)')$/.exec(links[0]!);
    if (!match) throw new Error(`${fileName}: capability from requires a quoted relative .uneffect.ts path and export`);
    const reference = match[1] ?? match[2]!, hash = reference.lastIndexOf("#");
    if (hash < 0) throw new Error(`${fileName}: capability from reference requires an export name`);
    const requested = reference.slice(0, hash), exportName = reference.slice(hash + 1);
    if (!requested.startsWith("./") && !requested.startsWith("../")) throw new Error(`${fileName}: capability from path must be relative`);
    if (!requested.endsWith(".uneffect.ts") || !/^[A-Za-z_$][\w$]*$/.test(exportName)) throw new Error(`${fileName}: invalid capability specification reference`);
    const specificationFile = posix.normalize(posix.join(posix.dirname(fileName), requested));
    const specification = files[specificationFile];
    if (specification === undefined) throw new Error(`${fileName}: capability specification ${specificationFile} does not exist in the selected project`);
    const declaration = parseCapabilityDsl(specificationFile, specification, exportName).map(formatEffect).join(" | ");
    output[fileName] = source.replace(/(\/\*\s*uneffect\s*:\s*capability\s+)from\s+(?:"[^"]+"|'[^']+')\s*(\*\/)/, `$1effect ${declaration} $2`);
  }
  return output;
}
