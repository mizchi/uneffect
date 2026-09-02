import ts from "typescript";
import { posix } from "node:path";
import { effectSchema, formatEffect, parseEffectExpression, type AtomDomain, type Effect, type EffectSchema } from "./capabilities.js";
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
export type BuiltinEffectName =
  | "Console" | "Storage" | "Random" | "Timer" | "InvokeUserCode"
  | "CookieRead" | "CookieWrite" | "LocalStorageRead" | "LocalStorageWrite"
  | "GlobalVarsRead" | "GlobalVarsWrite"
  | "ScriptLoad" | "ExecuteExternalCode" | "Fetch" | "Dom" | "Clone" | "Transfer" | "SharedMemory"
  | "FsRead" | "FsWrite" | "Ffi" | "Net" | "Env" | "Run" | "Sys" | "Import";
export const Builtin = (_name: BuiltinEffectName, _scope?: { readonly arguments: readonly (readonly string[] | "All")[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;
export interface LocalEffectSchema<Name extends string = string> { readonly name: Name; readonly version: 1; readonly arguments: readonly AtomDomain[] }
export const defineEffectSchema = <const Name extends string, const Domains extends readonly AtomDomain[]>(schema: { readonly name: Name; readonly version?: 1; readonly arguments: Domains }): LocalEffectSchema<Name> => ({ ...schema, version: 1 });
export const Custom = (_schema: LocalEffectSchema, _scope?: { readonly arguments: readonly (readonly string[] | "All")[] }): CapabilityDescriptor => ({}) as CapabilityDescriptor;

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
        /(?:^|\/)capability-dsl\.(?:d\.)?ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      if (!valid) throw new Error(`${fileName}: ${element.name.text} does not resolve to @mizchi/uneffect/spec#${exported} by TypeChecker symbol identity`);
    }
  }
}

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

export interface ParsedCapabilityDsl { effects: Effect[]; schemas: Map<string, EffectSchema> }
export function parseCapabilityDslWithSchemas(fileName: string, text: string, exportName: string): ParsedCapabilityDsl {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = new Map<string, string>();
  for (const statement of source.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const name = element.propertyName?.text ?? element.name.text;
      if (["defineCapability", "defineEffectSchema", "Custom", "Console", "Fetch", "FsRead", "FsWrite", "Throw", "Builtin"].includes(name)) {
        if (statement.moduleSpecifier.text !== "@mizchi/uneffect/spec") throw new Error(`${name} must be imported from @mizchi/uneffect/spec`);
        imported.set(element.name.text, name);
      }
    }
  }
  const schemas = new Map<string, EffectSchema>();
  const schemaBindings = new Map<string, EffectSchema>();
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)
      || !ts.isIdentifier(declaration.initializer.expression) || imported.get(declaration.initializer.expression.text) !== "defineEffectSchema") continue;
    const value = fields(source, object(source, declaration.initializer.arguments[0], "Effect schema"), "Effect schema");
    if (![2, 3].includes(value.size) || !value.has("name") || !value.has("arguments")) throw new Error(`${fileName}: Effect schema requires name, arguments, and optional version`);
    const name = value.get("name"), version = value.get("version");
    if (!name || !ts.isStringLiteral(name) || !/^[A-Za-z_$][\w$]*$/.test(name.text)) throw new Error(`${fileName}: Effect schema name must be a static identifier string`);
    if (effectSchema(name.text) || schemas.has(name.text)) throw new Error(`${fileName}: duplicate or builtin Effect schema ${name.text}`);
    if (version && (!ts.isNumericLiteral(version) || version.text !== "1")) throw new Error(`${fileName}: Effect schema version must be 1`);
    const domains = strings(source, value.get("arguments"), `${name.text} schema arguments`) as AtomDomain[];
    const allowed = new Set<AtomDomain>(["token", "literal", "url", "path", "host", "env", "sys", "region"]);
    if (domains.some((domain) => !allowed.has(domain))) throw new Error(`${fileName}: unknown Effect schema atom domain`);
    const schema = { name: name.text, version: 1, arguments: domains } satisfies EffectSchema;
    schemas.set(schema.name, schema); schemaBindings.set(declaration.name.text, schema);
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
  const effects = list.elements.map((element) => {
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
    if (helper === "Custom") {
      const binding = element.arguments[0];
      if (!binding || !ts.isIdentifier(binding)) throw new Error(`${fileName}: Custom requires a local Effect schema identifier`);
      const schema = schemaBindings.get(binding.text);
      if (!schema) throw new Error(`${fileName}: Custom references an unknown local Effect schema`);
      if (schema.arguments.length === 0) {
        if (element.arguments.length !== 1) throw new Error(`${fileName}: ${schema.name} does not accept scope arguments`);
        return { kind: "capability", name: schema.name, arguments: [] } satisfies Effect;
      }
      const scope = fields(source, object(source, element.arguments[1], `Custom ${schema.name}`), `Custom ${schema.name}`);
      if (element.arguments.length !== 2 || scope.size !== 1 || !scope.has("arguments")) throw new Error(`${fileName}: Custom ${schema.name} requires exactly arguments`);
      const args = scope.get("arguments");
      if (!args || !ts.isArrayLiteralExpression(args) || args.elements.length !== schema.arguments.length) throw new Error(`${fileName}: Custom ${schema.name} requires ${schema.arguments.length} argument sets`);
      const formatted = args.elements.map((argument, index) => {
        if (ts.isStringLiteral(argument) && argument.text === "All") return "All";
        return strings(source, argument, `${schema.name} argument ${index + 1}`).map((value) => {
          const domain = schema.arguments[index]!;
          return domain === "token" || domain === "sys" ? value : domain === "region" ? `typeof ${value}` : JSON.stringify(value);
        }).join(" | ");
      });
      return parseEffectExpression(`${schema.name}<${formatted.join(", ")}>`, schemas);
    }
    if (helper === "Builtin") {
      const name = element.arguments[0];
      if (!name || !ts.isStringLiteral(name)) throw new Error(`${fileName}: Builtin requires a literal builtin name`);
      const schema = effectSchema(name.text);
      if (!schema) throw new Error(`${fileName}: unknown builtin Effect schema ${name.text}`);
      if (schema.arguments.length === 0) {
        if (element.arguments.length !== 1) throw new Error(`${fileName}: ${name.text} does not accept scope arguments`);
        return parseEffectExpression(name.text);
      }
      // A bare parameterized builtin denotes its existing unscoped/All upper
      // bound, matching comment syntax such as `CookieRead` and `FsRead`.
      if (element.arguments.length === 1) return parseEffectExpression(name.text);
      const scope = fields(source, object(source, element.arguments[1], `Builtin ${name.text}`), `Builtin ${name.text}`);
      if (element.arguments.length !== 2 || scope.size !== 1 || !scope.has("arguments")) throw new Error(`${fileName}: Builtin ${name.text} requires exactly arguments`);
      const args = scope.get("arguments");
      if (!args || !ts.isArrayLiteralExpression(args) || args.elements.length !== schema.arguments.length) throw new Error(`${fileName}: Builtin ${name.text} requires ${schema.arguments.length} argument sets`);
      const formatAtom = (value: string, domain: AtomDomain): string => domain === "token" || domain === "sys" ? value : domain === "region" ? `typeof ${value}` : JSON.stringify(value);
      const formatted = args.elements.map((argument, index) => {
        if (ts.isStringLiteral(argument) && argument.text === "All") return "All";
        return union(strings(source, argument, `${name.text} argument ${index + 1}`), `${name.text} argument ${index + 1}`)
          .split(" | ").map((value) => formatAtom(JSON.parse(value) as string, schema.arguments[index]!)).join(" | ");
      });
      return parseEffectExpression(`${name.text}<${formatted.join(", ")}>`);
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
  return { effects, schemas };
}

export function parseCapabilityDsl(fileName: string, text: string, exportName: string): Effect[] {
  return parseCapabilityDslWithSchemas(fileName, text, exportName).effects;
}

export interface PreparedCapabilityDslLinks { files: Record<string, string>; schemas: Map<string, EffectSchema> }
export function prepareCapabilityDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): PreparedCapabilityDslLinks {
  const output = { ...files }, schemas = new Map<string, EffectSchema>();
  for (const [fileName, source] of Object.entries(files)) {
    const links = extractAnnotations(source, "capability_from");
    if (links.length === 0) continue;
    if (links.length !== 1) throw new Error(`${fileName}: expected exactly one uneffect:capability_from declaration`);
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
    if (program) validateCapabilityDslHelperIdentities(program, specificationFile);
    const parsed = parseCapabilityDslWithSchemas(specificationFile, specification, exportName);
    for (const [name, schema] of parsed.schemas) {
      const existing = schemas.get(name);
      if (existing && JSON.stringify(existing) !== JSON.stringify(schema)) throw new Error(`${fileName}: conflicting local Effect schema ${name}`);
      schemas.set(name, schema);
    }
    const declaration = parsed.effects.map(formatEffect).join(" | ");
    const annotationPrefix = ["uneffect", "effect"].join(":");
    output[fileName] = source.replace(/\/\*\s*uneffect\s*:\s*capability_from\s+(?:"[^"]+"|'[^']+')\s*\*\//, `/* ${annotationPrefix} ${declaration} */`);
  }
  return { files: output, schemas };
}

export function materializeCapabilityDslLinks(files: Readonly<Record<string, string>>, program?: ts.Program): Record<string, string> {
  return prepareCapabilityDslLinks(files, program).files;
}
