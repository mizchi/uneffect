import type { Node, CallExpression } from "oxc-parser";
import { posix } from "node:path";
import { parseOxcSource, type OxcSource } from "../frontends/oxc/source.js";
import { dslFields as fields, dslObject as object, dslImports } from "../frontends/oxc/dsl.js";
import { effectSchema, formatEffect, parseEffectExpression, type AtomDomain, type Effect, type EffectSchema } from "./capabilities.js";
import { extractAnnotations } from "../support/annotations.js";

function strings(source: OxcSource, node: Node | null | undefined, context: string): string[] {
  if (node?.type !== "ArrayExpression") throw new Error(`${source.fileName}: ${context} must be a literal array`);
  return node.elements.map(element => {
    if (!element || element.type !== "Literal" || typeof element.value !== "string") throw new Error(`${source.fileName}: ${context} only accepts string literals`);
    return element.value;
  });
}
function union(values: string[], context: string): string {
  if (!values.length) throw new Error(`${context} must not be empty`);
  return values.map(value => JSON.stringify(value)).join(" | ");
}
export interface ParsedCapabilityDsl { effects: Effect[]; schemas: Map<string, EffectSchema> }

/** Interpret trusted source declarations without authenticating helpers or implementation bodies. */
export function parseCapabilityDslWithSchemas(fileName: string, text: string, exportName: string): ParsedCapabilityDsl {
  const source = parseOxcSource(fileName, text);
  const imported = dslImports(source, ["defineCapability", "defineEffectSchema", "Custom", "Console", "Fetch", "FsRead", "FsWrite", "Throw", "Builtin"]);
  const schemas = new Map<string, EffectSchema>(), schemaBindings = new Map<string, EffectSchema>();
  const variables = source.program.body.flatMap(statement => {
    const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    return node?.type === "VariableDeclaration" ? node.declarations.map(declaration => ({ declaration, exported: statement.type === "ExportNamedDeclaration" })) : [];
  });
  for (const { declaration } of variables) {
    const call = declaration.init?.type === "ChainExpression" ? declaration.init.expression : declaration.init;
    if (declaration.id.type !== "Identifier" || call?.type !== "CallExpression" || call.callee.type !== "Identifier" || imported.get(call.callee.name) !== "defineEffectSchema") continue;
    if (call.optional || declaration.init?.type === "ChainExpression") throw new Error(`${fileName}: optional schema calls are unsupported`);
    if (call.arguments.length !== 1) throw new Error(`${fileName}: defineEffectSchema requires one object literal`);
    const value = fields(source, object(source, call.arguments[0], "Effect schema"), "Effect schema");
    if (!value.has("name") || !value.has("arguments") || [...value.keys()].some(key => !["name", "arguments", "version"].includes(key))) throw new Error(`${fileName}: Effect schema requires name, arguments, and optional version`);
    const name = value.get("name"), version = value.get("version");
    if (!name || (name.type !== "Literal" || typeof name.value !== "string") || !/^[A-Za-z_$][\w$]*$/.test(name.value)) throw new Error(`${fileName}: Effect schema name must be a static identifier string`);
    if (effectSchema(name.value) || schemas.has(name.value)) throw new Error(`${fileName}: duplicate or builtin Effect schema ${name.value}`);
    if (version && (version.type !== "Literal" || version.value !== 1)) throw new Error(`${fileName}: Effect schema version must be 1`);
    const domains = strings(source, value.get("arguments"), `${name.value} schema arguments`) as AtomDomain[];
    const allowed = new Set<AtomDomain>(["token", "literal", "url", "path", "host", "env", "sys", "region"]);
    if (domains.some((domain) => !allowed.has(domain))) throw new Error(`${fileName}: unknown Effect schema atom domain`);
    const schema = { name: name.value, version: 1, arguments: domains } satisfies EffectSchema;
    schemas.set(schema.name, schema); schemaBindings.set(declaration.id.name, schema);
  }
  let definition: CallExpression | undefined;
  for (const { declaration, exported } of variables) {
    if (!exported) continue;
    if (declaration.id.type !== "Identifier") throw new Error(`${fileName}: capability DSL requires static names`);
    const call = declaration.init;
    if (declaration.id.name === exportName && call?.type === "CallExpression" && !call.optional && call.callee.type === "Identifier" && imported.get(call.callee.name) === "defineCapability") definition = call;
  }
  if (!definition) throw new Error(`${fileName}: does not export capability ${exportName}`);
  if (definition.arguments.length !== 1) throw new Error(`${fileName}: defineCapability requires one object literal`);
  const root = fields(source, object(source, definition.arguments[0], "capability definition"), "capability definition");
  if (root.size !== 1 || !root.has("effects")) throw new Error(`${fileName}: capability definition requires exactly effects`);
  const list = root.get("effects");
  if (!list || list.type !== "ArrayExpression") throw new Error(`${fileName}: effects must be a literal array`);
  const effects = list.elements.map((element) => {
    if (!element || element.type !== "CallExpression" || element.optional || element.callee.type !== "Identifier") throw new Error(`${fileName}: unsupported capability descriptor`);
    const helper = imported.get(element.callee.name);
    if (!helper || helper === "defineCapability") throw new Error(`${fileName}: unsupported capability descriptor ${source.textOf(element)}`);
    if (helper === "Console") {
      if (element.arguments.length !== 0) throw new Error(`${fileName}: Console does not accept arguments`);
      return parseEffectExpression("Console");
    }
    if (helper === "Throw") {
      const error = element.arguments[0];
      if (element.arguments.length !== 1 || !error || error.type !== "Identifier") throw new Error(`${fileName}: Throw requires an Error constructor identifier`);
      return parseEffectExpression(`Throw<${error.name}>`);
    }
    if (helper === "Custom") {
      const binding = element.arguments[0];
      if (!binding || binding.type !== "Identifier") throw new Error(`${fileName}: Custom requires a local Effect schema identifier`);
      const schema = schemaBindings.get(binding.name);
      if (!schema) throw new Error(`${fileName}: Custom references an unknown local Effect schema`);
      if (schema.arguments.length === 0) {
        if (element.arguments.length !== 1) throw new Error(`${fileName}: ${schema.name} does not accept scope arguments`);
        return { kind: "capability", name: schema.name, arguments: [] } satisfies Effect;
      }
      const scope = fields(source, object(source, element.arguments[1], `Custom ${schema.name}`), `Custom ${schema.name}`);
      if (element.arguments.length !== 2 || scope.size !== 1 || !scope.has("arguments")) throw new Error(`${fileName}: Custom ${schema.name} requires exactly arguments`);
      const args = scope.get("arguments");
      if (!args || args.type !== "ArrayExpression" || args.elements.length !== schema.arguments.length) throw new Error(`${fileName}: Custom ${schema.name} requires ${schema.arguments.length} argument sets`);
      const formatted = args.elements.map((argument, index) => {
        if ((argument?.type === "Literal" && typeof argument.value === "string") && argument.value === "All") return "All";
        return strings(source, argument, `${schema.name} argument ${index + 1}`).map((value) => {
          const domain = schema.arguments[index]!;
          return domain === "token" || domain === "sys" ? value : domain === "region" ? `typeof ${value}` : JSON.stringify(value);
        }).join(" | ");
      });
      return parseEffectExpression(`${schema.name}<${formatted.join(", ")}>`, schemas);
    }
    if (helper === "Builtin") {
      const name = element.arguments[0];
      if (!name || (name.type !== "Literal" || typeof name.value !== "string")) throw new Error(`${fileName}: Builtin requires a literal builtin name`);
      const schema = effectSchema(name.value);
      if (!schema) throw new Error(`${fileName}: unknown builtin Effect schema ${name.value}`);
      if (schema.arguments.length === 0) {
        if (element.arguments.length !== 1) throw new Error(`${fileName}: ${name.value} does not accept scope arguments`);
        return parseEffectExpression(name.value);
      }
      // A bare parameterized builtin denotes its existing unscoped/All upper
      // bound, matching comment syntax such as `CookieRead` and `FsRead`.
      if (element.arguments.length === 1) return parseEffectExpression(name.value);
      const scope = fields(source, object(source, element.arguments[1], `Builtin ${name.value}`), `Builtin ${name.value}`);
      if (element.arguments.length !== 2 || scope.size !== 1 || !scope.has("arguments")) throw new Error(`${fileName}: Builtin ${name.value} requires exactly arguments`);
      const args = scope.get("arguments");
      if (!args || args.type !== "ArrayExpression" || args.elements.length !== schema.arguments.length) throw new Error(`${fileName}: Builtin ${name.value} requires ${schema.arguments.length} argument sets`);
      const formatAtom = (value: string, domain: AtomDomain): string => domain === "token" || domain === "sys" ? value : domain === "region" ? `typeof ${value}` : JSON.stringify(value);
      const formatted = args.elements.map((argument, index) => {
        if ((argument?.type === "Literal" && typeof argument.value === "string") && argument.value === "All") return "All";
        const values = strings(source, argument, `${name.value} argument ${index + 1}`);
        if (!values.length) throw new Error(`${name.value} argument ${index + 1} must not be empty`);
        return values.map(value => formatAtom(value, schema.arguments[index]!)).join(" | ");
      });
      return parseEffectExpression(`${name.value}<${formatted.join(", ")}>`);
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
export function prepareCapabilityDslSourceLinks(files: Readonly<Record<string, string>>, validate?: (fileName: string) => void): PreparedCapabilityDslLinks {
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
    const specification = Object.hasOwn(files, specificationFile) ? files[specificationFile] : undefined;
    if (specification === undefined) throw new Error(`${fileName}: capability specification ${specificationFile} does not exist in the selected project`);
    validate?.(specificationFile);
    const parsed = parseCapabilityDslWithSchemas(specificationFile, specification, exportName);
    for (const [name, schema] of parsed.schemas) {
      const existing = schemas.get(name);
      if (existing && JSON.stringify(existing) !== JSON.stringify(schema)) throw new Error(`${fileName}: conflicting local Effect schema ${name}`);
      schemas.set(name, schema);
    }
    const declaration = parsed.effects.map(formatEffect).join(" | ");
    if (declaration.includes("*/")) throw new Error(`${fileName}: capability scope cannot escape a generated annotation`);
    const annotationPrefix = ["uneffect", "effect"].join(":");
    output[fileName] = source.replace(/\/\*\s*uneffect\s*:\s*capability_from\s+(?:"[^"]+"|'[^']+')\s*\*\//, `/* ${annotationPrefix} ${declaration} */`);
  }
  return { files: output, schemas };
}

/** Prepare source declarations without checker authentication. */
export function prepareCapabilityDslSources(files: Readonly<Record<string, string>>): PreparedCapabilityDslLinks {
  return prepareCapabilityDslSourceLinks(files);
}
