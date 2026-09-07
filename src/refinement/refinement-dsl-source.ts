import { posix } from "node:path";
import type { Node } from "oxc-parser";
import { parseOxcSource } from "../frontends/oxc/source.js";
import { dslFields, dslObject, dslImports } from "../frontends/oxc/dsl.js";
import { projection, nodeGlobalRuntime } from "./refinement-authoring.js";
import { extractAnnotations } from "../support/annotations.js";
import { parseRefinementRuntimeIdentity } from "../evidence/runtime-identities.js";
import type { ParsedRefinementDefinition, RefinementBindingManifest } from "./binding-contracts.js";
export type { ParsedRefinementDefinition, RefinementBindingManifest } from "./binding-contracts.js";

function identifier(node: Node | null | undefined, fileName: string, context: string): string {
  if (node?.type !== "Identifier") throw new Error(`${fileName}: ${context} must be a callable identifier`);
  return node.name;
}
function literal(node: Node | null | undefined, fileName: string, context: string): string {
  if (node?.type !== "Literal" || typeof node.value !== "string") throw new Error(`${fileName}: ${context} must be a string literal`);
  return node.value;
}

/** Interpret trusted source declarations without executing them or authenticating callables. */
export function parseRefinementDsl(fileName: string, text: string): ParsedRefinementDefinition {
  const source = parseOxcSource(fileName, text);
  const helpers = dslImports(source, ["defineRefinement", "globalRuntime", "nodeGlobalRuntime", "identityProjection", "setFromArrayProjection", "mapFromEntriesProjection"]);
  const objectEntries = (node: Node | null | undefined, _fileName: string, context: string) => [...dslFields(source, dslObject(source, node, context), context, true)];
  const assignment = source.program.body.find(statement => statement.type === "ExportDefaultDeclaration");
  if (!assignment || assignment.declaration.type !== "CallExpression" || assignment.declaration.optional || assignment.declaration.callee.type !== "Identifier"
    || helpers.get(assignment.declaration.callee.name) !== "defineRefinement" || assignment.declaration.arguments.length !== 1) {
    throw new Error(`${fileName}: default export must call defineRefinement imported from @mizchi/uneffect/spec`);
  }
  const entries = objectEntries(assignment.declaration.arguments[0], fileName, "defineRefinement argument");
  const fields = new Map(entries);
  if (fields.size !== entries.length) throw new Error(`${fileName}: duplicate refinement definition property`);
  const supported = new Set(["name", "version", "runtime", "create", "observe", "abstractions", "actions", "invariants"]);
  for (const name of fields.keys()) if (!supported.has(name)) throw new Error(`${fileName}: unsupported refinement definition property ${name}`);
  for (const name of ["name", "version", "create", "observe", "abstractions", "actions", "invariants"])
    if (!fields.has(name)) throw new Error(`${fileName}: refinement definition requires ${name}`);

  const callHelper = (node: Node | null | undefined, context: string): { helper: string; arguments: readonly Node[] } => {
    if (!node || node.type !== "CallExpression" || node.optional || node.callee.type !== "Identifier") throw new Error(`${fileName}: ${context} must call a refinement DSL helper`);
    const helper = helpers.get(node.callee.name);
    if (!helper) throw new Error(`${fileName}: unsupported refinement DSL helper ${node.callee.name}; helpers must be imported from @mizchi/uneffect/spec`);
    return { helper, arguments: node.arguments };
  };
  const abstractions = Object.fromEntries(objectEntries(fields.get("abstractions"), fileName, "abstractions").map(([name, value]) => {
    const call = callHelper(value, `abstraction ${name}`);
    const kinds: Record<string, "identity" | "set-from-array" | "map-from-entries"> = {
      identityProjection: "identity", setFromArrayProjection: "set-from-array", mapFromEntriesProjection: "map-from-entries",
    };
    const kind = kinds[call.helper];
    if (!kind) throw new Error(`${fileName}: unsupported refinement projection helper ${call.helper}`);
    if (call.arguments.length !== 1) throw new Error(`${fileName}: abstraction ${name} requires one string literal path`);
    const path = literal(call.arguments[0], fileName, `abstraction ${name} path`);
    projection(kind, path);
    return [name, kind === "identity" ? path : `${kind === "set-from-array" ? "Set" : "Map"}(${path})`];
  }));
  const callableMap = (name: "actions" | "invariants"): Record<string, string> =>
    Object.fromEntries(objectEntries(fields.get(name), fileName, name).map(([modelName, value]) => [modelName, identifier(value, fileName, `${name}.${modelName}`)]));

  let runtimeIdentity: string | undefined;
  if (fields.has("runtime")) {
    const call = callHelper(fields.get("runtime"), "runtime");
    if (call.helper === "globalRuntime" && call.arguments.length === 0) runtimeIdentity = "globalThis";
    else if (call.helper === "nodeGlobalRuntime" && call.arguments.length === 2 && call.arguments[0]?.type === "Literal" && typeof call.arguments[0].value === "number" && call.arguments[1]?.type === "Literal" && typeof call.arguments[1].value === "string") {
      const major = Number(call.arguments[0]!.value), realm = call.arguments[1]!.value;
      runtimeIdentity = nodeGlobalRuntime(major, realm).identity;
    } else throw new Error(`${fileName}: unsupported refinement runtime descriptor`);
  }
  return {
    name: literal(fields.get("name"), fileName, "name"), version: literal(fields.get("version"), fileName, "version"),
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
    create: identifier(fields.get("create"), fileName, "create"), observe: identifier(fields.get("observe"), fileName, "observe"),
    abstractions, actions: callableMap("actions"), invariants: callableMap("invariants"),
  };
}

/** Validate the attachment before a caller reads its referenced file. */
export function refinementDslSpecificationFile(implementationFile: string, implementationSource: string): string {
  const links = extractAnnotations(implementationSource, "refinement_from");
  if (links.length !== 1) throw new Error(`${implementationFile}: expected exactly one uneffect:refinement_from declaration`);
  const quoted = /^(?:"([^"]+)"|'([^']+)')$/.exec(links[0]!);
  if (!quoted) throw new Error(`${implementationFile}: refinement_from requires a quoted relative .uneffect.ts path and #default export`);
  const reference = quoted[1] ?? quoted[2]!, hash = reference.lastIndexOf("#");
  const requested = reference.slice(0, hash), exportName = reference.slice(hash + 1);
  if (hash < 0 || exportName !== "default" || (!requested.startsWith("./") && !requested.startsWith("../")) || !requested.endsWith(".uneffect.ts")) {
    throw new Error(`${implementationFile}: invalid refinement specification reference`);
  }
  const specificationFile = posix.normalize(posix.join(posix.dirname(implementationFile), requested));
  return specificationFile;
}

/** Resolves one implementation attachment and lowers its typed DSL to the stable v1 manifest. */
export function resolveRefinementDslSourceLinks(
  implementationFile: string,
  implementationSource: string,
  files: Readonly<Record<string, string>>,
  validate?: (specificationFile: string) => void,
): RefinementBindingManifest {
  const specificationFile = refinementDslSpecificationFile(implementationFile, implementationSource);
  const specification = files[specificationFile];
  if (specification === undefined) throw new Error(`${implementationFile}: refinement specification ${specificationFile} does not exist in the selected project`);
  const parsed = parseRefinementDsl(specificationFile, specification);
  validate?.(specificationFile);
  const runtimeIdentity = parsed.runtimeIdentity ? parseRefinementRuntimeIdentity(parsed.runtimeIdentity) : undefined;
  if (parsed.runtimeIdentity && !runtimeIdentity) throw new Error(`${specificationFile}: unsupported refinement runtime identity ${parsed.runtimeIdentity}`);
  return {
    schema: "uneffect-refinement-bindings/v1", fileName: implementationFile,
    adapterName: parsed.name, version: parsed.version,
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
    create: parsed.create, observe: parsed.observe,
    abstractions: parsed.abstractions, actions: parsed.actions, invariants: parsed.invariants,
  };
}

/** Resolve trusted source attachments without checker authentication. */
export function resolveRefinementDslSourceLink(implementationFile: string, implementationSource: string, files: Readonly<Record<string, string>>): RefinementBindingManifest {
  return resolveRefinementDslSourceLinks(implementationFile, implementationSource, files);
}
