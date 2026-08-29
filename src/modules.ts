import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  builtinContractRegistry,
  type BuiltinContractRegistry,
  type SemanticModuleLedgerEntry,
} from "./builtin-contracts.js";
import { effectSchema, registerEffectSchema, unregisterEffectSchema, type AtomDomain, type EffectSchema } from "./capabilities.js";
import { parseBuiltinRegistryConfig } from "./registry-config.js";

export const uneffectModuleSchema = "uneffect-module/v1" as const;

export class UneffectModuleError extends Error {
  constructor(message: string) { super(message); this.name = "UneffectModuleError"; }
}

export interface UneffectModuleManifest {
  schema: typeof uneffectModuleSchema;
  name: string;
  version: string;
  namespace: string;
  evidence: "trusted";
  trustOwner: string;
  trustReason: string;
  effectSchemas: EffectSchema[];
  registry: Record<string, unknown>;
}

export type UneffectModuleLedgerEntry = SemanticModuleLedgerEntry;

const domains = new Set<AtomDomain>(["token", "literal", "url", "path", "host", "env", "sys", "region"]);
function fail(path: string, message: string): never { throw new UneffectModuleError(`${path}: ${message}`); }
function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
  return value;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown) fail(path, `unknown key ${JSON.stringify(unknown)}`);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function parseUneffectModuleManifest(value: unknown): UneffectModuleManifest {
  const input = record(value, "module");
  exactKeys(input, ["$schema", "schema", "name", "version", "namespace", "evidence", "trustOwner", "trustReason", "effectSchemas", "registry"], "module");
  if (input.$schema !== undefined) text(input.$schema, "module.$schema");
  if (input.schema !== uneffectModuleSchema) fail("module.schema", `unsupported schema ${JSON.stringify(input.schema)}`);
  if (input.evidence !== "trusted") fail("module.evidence", "evidence must be trusted");
  const namespace = text(input.namespace, "module.namespace");
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(namespace)) fail("module.namespace", "expected a dotted identifier");
  if (!Array.isArray(input.effectSchemas)) fail("module.effectSchemas", "expected an array");
  const effectSchemas = input.effectSchemas.map((value, index): EffectSchema => {
    const path = `module.effectSchemas[${index}]`, item = record(value, path);
    exactKeys(item, ["name", "version", "arguments"], path);
    const name = text(item.name, `${path}.name`);
    if (!name.startsWith(`${namespace}.`)) fail(`${path}.name`, `must start with namespace ${JSON.stringify(`${namespace}.`)}`);
    if (typeof item.version !== "number" || !Number.isSafeInteger(item.version) || item.version < 1) fail(`${path}.version`, "expected an integer >= 1");
    if (!Array.isArray(item.arguments)) fail(`${path}.arguments`, "expected an array");
    const arguments_ = item.arguments.map((domain, argumentIndex) => {
      if (typeof domain !== "string" || !domains.has(domain as AtomDomain)) fail(`${path}.arguments[${argumentIndex}]`, "unknown atom domain");
      return domain as AtomDomain;
    });
    return { name, version: item.version, arguments: arguments_ };
  });
  const names = new Set<string>();
  for (const schema of effectSchemas) {
    if (names.has(schema.name)) fail("module.effectSchemas", `duplicate effect schema ${JSON.stringify(schema.name)}`);
    names.add(schema.name);
  }
  return {
    schema: uneffectModuleSchema,
    name: text(input.name, "module.name"), version: text(input.version, "module.version"), namespace,
    evidence: "trusted", trustOwner: text(input.trustOwner, "module.trustOwner"), trustReason: text(input.trustReason, "module.trustReason"),
    effectSchemas, registry: record(input.registry, "module.registry"),
  };
}

export function installUneffectModules(values: readonly unknown[], base: BuiltinContractRegistry = builtinContractRegistry): {
  registry: BuiltinContractRegistry; ledger: UneffectModuleLedgerEntry[];
} {
  const manifests = values.map(parseUneffectModuleManifest);
  const identities = new Set<string>(), newSchemas = new Map<string, EffectSchema>();
  for (const manifest of manifests) {
    const identity = `${manifest.name}@${manifest.version}`;
    if (identities.has(identity)) fail("modules", `duplicate module ${JSON.stringify(identity)}`);
    identities.add(identity);
  }
  for (const manifest of manifests) {
    for (const schema of manifest.effectSchemas) {
      const claimed = newSchemas.get(schema.name) ?? effectSchema(schema.name);
      if (claimed && canonicalJson(claimed) !== canonicalJson(schema)) fail("modules", `effect schema ${JSON.stringify(schema.name)} is already owned with a different definition`);
      newSchemas.set(schema.name, schema);
    }
  }
  const installedNames: string[] = [];
  for (const manifest of manifests) for (const schema of manifest.effectSchemas) {
    if (!effectSchema(schema.name)) installedNames.push(schema.name);
    registerEffectSchema(schema);
  }
  let registry = base;
  try {
    for (const manifest of manifests) registry = parseBuiltinRegistryConfig(manifest.registry, registry);
  } catch (cause) {
    for (const name of installedNames) unregisterEffectSchema(name);
    throw cause;
  }
  const ledger = manifests.map((manifest) => ({
      name: manifest.name, version: manifest.version, namespace: manifest.namespace,
      evidence: "trusted" as const, trustOwner: manifest.trustOwner, trustReason: manifest.trustReason,
      digest: createHash("sha256").update(canonicalJson(manifest)).digest("hex"),
    }));
  registry = { ...registry, modules: [...(base.modules ?? []), ...ledger] };
  return { registry, ledger };
}

export async function loadUneffectModules(fileNames: readonly string[], base: BuiltinContractRegistry = builtinContractRegistry) {
  const values = await Promise.all(fileNames.map(async (fileName) => {
    const absolute = resolve(fileName);
    try { return JSON.parse(await readFile(absolute, "utf8")) as unknown; }
    catch (cause) { throw new UneffectModuleError(`${absolute}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }));
  return installUneffectModules(values, base);
}
