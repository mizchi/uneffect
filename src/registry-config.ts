import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEffectExpression } from "./capabilities.js";
import { validateBuiltinSemantics } from "./builtin-semantic-schema.js";
import type { BuiltinSemantics, SemanticPrimitive } from "./builtin-semantic-schema.js";
import {
  builtinContractRegistry,
  extendBuiltinContractRegistry,
  type BuiltinContract,
  type BuiltinContractRegistry,
  type BuiltinContractRegistryExtension,
  type DeclarationFingerprint,
  type ModuleInitializationContract,
} from "./builtin-contracts.js";

export const builtinRegistryConfigSchema = "uneffect-registry/v1" as const;

export class BuiltinRegistryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuiltinRegistryConfigError";
  }
}

function fail(path: string, message: string): never {
  throw new BuiltinRegistryConfigError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown) fail(path, `unknown key ${JSON.stringify(unknown)}`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(path, `expected an integer >= ${minimum}`);
  }
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function trusted(value: unknown, path: string): "trusted" {
  if (value !== "trusted") fail(path, "evidence must be trusted");
  return "trusted";
}

function expiration(value: unknown, path: string): string | undefined {
  const text = optionalString(value, path);
  if (text !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(text)) fail(path, "expected YYYY-MM-DD");
  if (text !== undefined) {
    const [year, month, day] = text.split("-").map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      fail(path, "expected a valid calendar date");
    }
  }
  return text;
}

function effect(value: unknown, path: string): string {
  const text = string(value, path);
  try { parseEffectExpression(text); } catch (cause) {
    fail(path, `invalid effect: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return text;
}

function registrySemantics(value: unknown, path: string): BuiltinSemantics {
  let semantics: BuiltinSemantics;
  try { semantics = validateBuiltinSemantics(value); } catch (cause) {
    fail(path, cause instanceof Error ? cause.message : String(cause));
  }
  const visit = (primitive: SemanticPrimitive, primitivePath: string): void => {
    if (primitive.kind === "property") {
      primitive.read.forEach((nested, index) => visit(nested, `${primitivePath}.read[${index}]`));
      primitive.write.forEach((nested, index) => visit(nested, `${primitivePath}.write[${index}]`));
      return;
    }
    if (primitive.kind !== "effect") return;
    if (primitive.scope) {
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(primitive.capability)) {
        fail(`${primitivePath}.capability`, "expected an effect capability name");
      }
    } else effect(primitive.capability, `${primitivePath}.capability`);
  };
  semantics.primitives.forEach((primitive, index) => visit(primitive, `${path}.primitives[${index}]`));
  return semantics;
}

function moduleInitialization(value: unknown, path: string): ModuleInitializationContract {
  const input = record(value, path);
  keys(input, ["module", "runtime", "effects", "evidence", "trustReason", "trustOwner", "trustExpiresOn"], path);
  const module = string(input.module, `${path}.module`);
  if (module.includes("*") && (!module.endsWith("*") || module.slice(0, -1).includes("*"))) {
    fail(`${path}.module`, "only one trailing wildcard is supported");
  }
  const runtime = record(input.runtime, `${path}.runtime`);
  keys(runtime, ["kind", runtime.kind === "node" ? "major" : "version"], `${path}.runtime`);
  const runtimeValue = runtime.kind === "node"
    ? { kind: "node" as const, major: integer(runtime.major, `${path}.runtime.major`, 1) }
    : runtime.kind === "package"
      ? { kind: "package" as const, version: string(runtime.version, `${path}.runtime.version`) }
      : fail(`${path}.runtime.kind`, "expected node or package");
  if (module.startsWith("node:") && runtimeValue.kind !== "node") fail(path, "node: modules require a node runtime");
  if (!module.startsWith("node:") && runtimeValue.kind !== "package") fail(path, "packages require a package runtime");
  return {
    module,
    runtime: runtimeValue,
    effects: array(input.effects, `${path}.effects`).map((item, index) => effect(item, `${path}.effects[${index}]`)),
    evidence: trusted(input.evidence, `${path}.evidence`),
    trustReason: string(input.trustReason, `${path}.trustReason`),
    trustOwner: string(input.trustOwner, `${path}.trustOwner`),
    ...(expiration(input.trustExpiresOn, `${path}.trustExpiresOn`) ? { trustExpiresOn: input.trustExpiresOn as string } : {}),
  };
}

function builtin(value: unknown, path: string): BuiltinContract {
  const input = record(value, path);
  keys(input, ["symbol", "runtime", "evidence", "trustReason", "trustOwner", "trustExpiresOn", "semantics", "callableResult"], path);
  const symbol = record(input.symbol, `${path}.symbol`);
  keys(symbol, ["module", "export"], `${path}.symbol`);
  const module = string(symbol.module, `${path}.symbol.module`);
  const runtime = input.runtime === undefined ? undefined : record(input.runtime, `${path}.runtime`);
  if (runtime) keys(runtime, ["kind", runtime.kind === "node" ? "major" : "version"], `${path}.runtime`);
  const runtimeValue = runtime?.kind === "node"
    ? { kind: "node" as const, major: integer(runtime.major, `${path}.runtime.major`, 1) }
    : runtime?.kind === "package"
      ? { kind: "package" as const, version: string(runtime.version, `${path}.runtime.version`) }
      : runtime === undefined ? undefined : fail(`${path}.runtime.kind`, "expected node or package");
  if (module.startsWith("node:") && runtimeValue?.kind === "package") fail(path, "node: function contracts require a node runtime");
  const externalPackage = module !== "global" && !module.startsWith("lib.") && !module.startsWith("node:");
  if (externalPackage && runtimeValue?.kind !== "package") fail(path, "package contracts require a package runtime");
  let semanticsValue: BuiltinContract["semantics"];
  if (input.semantics !== undefined) {
    semanticsValue = registrySemantics(input.semantics, `${path}.semantics`);
  }
  const callableResult = input.callableResult === undefined ? undefined : record(input.callableResult, `${path}.callableResult`);
  if (callableResult) keys(callableResult, ["semantics", "capturedCallbackArguments"], `${path}.callableResult`);
  const callableResultValue: BuiltinContract["callableResult"] = callableResult ? {
    ...(callableResult.semantics === undefined ? {} : { semantics: registrySemantics(callableResult.semantics, `${path}.callableResult.semantics`) }),
    ...(callableResult.capturedCallbackArguments === undefined ? {} : {
      capturedCallbackArguments: array(callableResult.capturedCallbackArguments, `${path}.callableResult.capturedCallbackArguments`)
        .map((item, index) => integer(item, `${path}.callableResult.capturedCallbackArguments[${index}]`)),
    }),
  } : undefined;
  return {
    symbol: { module, export: string(symbol.export, `${path}.symbol.export`) },
    ...(runtimeValue === undefined ? {} : { runtime: runtimeValue }),
    evidence: trusted(input.evidence, `${path}.evidence`),
    trustReason: string(input.trustReason, `${path}.trustReason`),
    trustOwner: string(input.trustOwner, `${path}.trustOwner`),
    ...(expiration(input.trustExpiresOn, `${path}.trustExpiresOn`) ? { trustExpiresOn: input.trustExpiresOn as string } : {}),
    ...(semanticsValue === undefined ? {} : { semantics: semanticsValue }),
    ...(callableResultValue === undefined ? {} : { callableResult: callableResultValue }),
  };
}

function declaration(value: unknown, path: string): DeclarationFingerprint {
  const input = record(value, path);
  keys(input, ["library", "compilerVersion", "sha256"], path);
  const sha256 = string(input.sha256, `${path}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) fail(`${path}.sha256`, "expected a lowercase SHA-256 digest");
  return { library: string(input.library, `${path}.library`), compilerVersion: string(input.compilerVersion, `${path}.compilerVersion`), sha256 };
}

function unique<T>(items: readonly T[], identity: (item: T) => string, path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = identity(item);
    if (seen.has(id)) fail(path, `duplicate entry ${JSON.stringify(id)}`);
    seen.add(id);
  }
}

export function parseBuiltinRegistryConfig(value: unknown, base: BuiltinContractRegistry = builtinContractRegistry): BuiltinContractRegistry {
  const input = record(value, "registry");
  keys(input, ["$schema", "schema", "builtinRegistryVersion", "contracts", "moduleInitializations", "declarations"], "registry");
  if (input.$schema !== undefined) string(input.$schema, "registry.$schema");
  if (input.schema !== builtinRegistryConfigSchema) fail("registry.schema", `unsupported schema ${JSON.stringify(input.schema)}`);
  if (input.builtinRegistryVersion !== base.version) fail("registry.builtinRegistryVersion", `builtin registry version must be ${base.version}`);
  const extension: BuiltinContractRegistryExtension = {
    contracts: input.contracts === undefined ? [] : array(input.contracts, "registry.contracts")
      .map((item, index) => builtin(item, `registry.contracts[${index}]`)),
    moduleInitializations: input.moduleInitializations === undefined
      ? [] : array(input.moduleInitializations, "registry.moduleInitializations")
        .map((item, index) => moduleInitialization(item, `registry.moduleInitializations[${index}]`)),
    declarations: input.declarations === undefined ? [] : array(input.declarations, "registry.declarations")
      .map((item, index) => declaration(item, `registry.declarations[${index}]`)),
  };
  unique(extension.contracts!, (item) => `${item.symbol.module}#${item.symbol.export}`, "registry.contracts");
  unique(extension.moduleInitializations!, (item) => item.module, "registry.moduleInitializations");
  unique(extension.declarations!, (item) => item.library, "registry.declarations");
  return extendBuiltinContractRegistry(base, extension);
}

export async function loadBuiltinRegistryConfig(fileName: string, base: BuiltinContractRegistry = builtinContractRegistry): Promise<BuiltinContractRegistry> {
  const absolute = resolve(fileName);
  let value: unknown;
  try { value = JSON.parse(await readFile(absolute, "utf8")); } catch (cause) {
    throw new BuiltinRegistryConfigError(`${absolute}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try { return parseBuiltinRegistryConfig(value, base); } catch (cause) {
    if (cause instanceof BuiltinRegistryConfigError) throw new BuiltinRegistryConfigError(`${absolute}: ${cause.message}`);
    throw cause;
  }
}
