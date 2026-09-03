import { dirname, join } from "node:path";
import ts from "typescript";
import { builtinSemanticCatalog, materializeBuiltinSemanticDefinitions } from "./builtin-semantic-catalog.js";
import type { BuiltinSemantics } from "./builtin-semantic-schema.js";

export interface BuiltinSymbolKey {
  module: string;
  export: string;
  /** Static path from an exact module export; unlike legacy `Type#member`, this preserves receiver provenance. */
  path?: readonly string[];
}

export interface PathResultRefinement {
  kind: "path";
  pattern: string;
}

/** The reviewed call returns a newly owned object with no aliases in caller-visible state. */
export interface FreshResultRefinement { kind: "fresh" }
export type BuiltinResultRefinement = PathResultRefinement | FreshResultRefinement;

export type PromiseCombinator = "all" | "allSettled" | "race" | "any";

export interface CallableResultContract {
  /** Generic semantics performed when the returned function is called. */
  semantics?: BuiltinSemantics;
  /** Factory argument positions captured and synchronously invoked by the returned function. */
  capturedCallbackArguments?: readonly number[];
}

export interface BuiltinContract {
  symbol: BuiltinSymbolKey;
  /** Exact host/package artifact against which this function contract was reviewed. */
  runtime?: { kind: "package"; version: string } | { kind: "node"; major: number };
  evidence: "trusted";
  trustReason?: string;
  trustOwner?: string;
  trustExpiresOn?: string;
  /** Versioned generic semantics interpreted by every participating domain. */
  semantics?: BuiltinSemantics;
  callableResult?: CallableResultContract;
}

export interface ModuleInitializationContract {
  /** Exact package specifier, or a trailing `*` prefix pattern such as `node:*`. */
  module: string;
  effects: readonly string[];
  evidence: "trusted";
  trustReason: string;
  trustOwner: string;
  trustExpiresOn?: string;
  /** The runtime artifact against which initialization was reviewed. */
  runtime:
    | { kind: "package"; version: string }
    | { kind: "node"; major: number };
}

export interface ModuleInitializationEnvironment {
  packageVersion?: string;
  nodeMajor?: number;
}

export interface BuiltinContractRegistry {
  version: 2;
  contracts: readonly BuiltinContract[];
  moduleInitializations: readonly ModuleInitializationContract[];
  declarations: readonly DeclarationFingerprint[];
  /** Declarative semantic modules that contributed trusted analyzer inputs. */
  modules?: readonly SemanticModuleLedgerEntry[];
}

export interface SemanticModuleLedgerEntry {
  name: string;
  version: string;
  namespace: string;
  evidence: "trusted";
  trustOwner: string;
  trustReason: string;
  digest: string;
}

export interface BuiltinContractRegistryExtension {
  contracts?: readonly BuiltinContract[];
  moduleInitializations?: readonly ModuleInitializationContract[];
  declarations?: readonly DeclarationFingerprint[];
}

/**
 * Add caller-owned contracts ahead of defaults. Exact module contracts still
 * outrank wildcard contracts, so a narrow review can refine `node:*` safely.
 */
export function extendBuiltinContractRegistry(
  base: BuiltinContractRegistry,
  extension: BuiltinContractRegistryExtension,
): BuiltinContractRegistry {
  const contractIds = new Set(extension.contracts?.map((item) => builtinSymbolId(item.symbol)) ?? []);
  const moduleIds = new Set(extension.moduleInitializations?.map((item) => item.module) ?? []);
  const declarationIds = new Set(extension.declarations?.map((item) => item.library) ?? []);
  return {
    version: 2,
    contracts: extension.contracts
      ? [...extension.contracts, ...base.contracts.filter((item) => !contractIds.has(builtinSymbolId(item.symbol)))]
      : base.contracts,
    moduleInitializations: extension.moduleInitializations
      ? [...extension.moduleInitializations, ...base.moduleInitializations.filter((item) => !moduleIds.has(item.module))]
      : base.moduleInitializations,
    declarations: extension.declarations
      ? [...extension.declarations, ...base.declarations.filter((item) => !declarationIds.has(item.library))]
      : base.declarations,
    ...(base.modules ? { modules: base.modules } : {}),
  };
}

export interface DeclarationFingerprint { library: string; compilerVersion: string; sha256: string }

export function builtinSymbolId(symbol: BuiltinSymbolKey): string {
  return `${symbol.module}#${symbol.export}${symbol.path?.length ? `#${symbol.path.join("#")}` : ""}`;
}

export function builtinSymbolDisplayName(symbol: BuiltinSymbolKey): string {
  return [symbol.export, ...(symbol.path ?? [])].join(".");
}

export function findBuiltinContract(registry: BuiltinContractRegistry, symbol: BuiltinSymbolKey): BuiltinContract | undefined {
  const id = builtinSymbolId(symbol);
  return registry.contracts.find((contract) => builtinSymbolId(contract.symbol) === id);
}

export function findModuleInitializationContract(
  registry: BuiltinContractRegistry,
  moduleName: string,
  environment: ModuleInitializationEnvironment,
): ModuleInitializationContract | undefined {
  const nameMatches = registry.moduleInitializations.filter((contract) => contract.module.endsWith("*")
      ? moduleName.startsWith(contract.module.slice(0, -1))
      : contract.module === moduleName);
  const exactMatches = nameMatches.filter((contract) => !contract.module.endsWith("*"));
  const candidates = exactMatches.length > 0 ? exactMatches : nameMatches;
  const nodeRuntime = moduleName.startsWith("node:");
  return candidates.find((contract) => nodeRuntime
    ? contract.runtime.kind === "node" && contract.runtime.major === environment.nodeMajor
    : contract.runtime.kind === "package" && contract.runtime.version === environment.packageVersion);
}

function packageName(moduleName: string): string {
  if (!moduleName.startsWith("@")) return moduleName.split("/")[0]!;
  return moduleName.split("/").slice(0, 2).join("/");
}

const resolvedPackageVersions = new WeakMap<ts.Program, Map<string, string | null>>();

function resolvedPackageVersion(program: ts.Program, containingFile: string, moduleName: string): string | undefined {
  let cache = resolvedPackageVersions.get(program);
  if (!cache) {
    cache = new Map();
    resolvedPackageVersions.set(program, cache);
  }
  const key = `${containingFile}\0${moduleName}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached === null ? undefined : cached;
  const resolved = ts.resolveModuleName(moduleName, containingFile, program.getCompilerOptions(), ts.sys).resolvedModule;
  if (!resolved) { cache.set(key, null); return undefined; }
  const expectedName = packageName(moduleName);
  let directory = dirname(resolved.resolvedFileName);
  while (true) {
    const manifest = join(directory, "package.json");
    const text = ts.sys.readFile(manifest);
    if (text !== undefined) {
      try {
        const value = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (value.name === expectedName && typeof value.version === "string") {
          cache.set(key, value.version);
          return value.version;
        }
      } catch { cache.set(key, null); return undefined; }
    }
    const parent = dirname(directory);
    if (parent === directory) { cache.set(key, null); return undefined; }
    directory = parent;
  }
}

/** Fail-closed runtime binding for reviewed function contracts. */
export function builtinContractApplies(
  program: ts.Program,
  containingFile: string,
  contract: BuiltinContract,
): boolean {
  if (contract.runtime === undefined) return true;
  return contract.runtime.kind === "node"
    ? contract.symbol.module.startsWith("node:")
      && contract.runtime.major === Number.parseInt(process.versions.node.split(".")[0]!, 10)
    : !contract.symbol.module.startsWith("node:")
      && contract.runtime.version === resolvedPackageVersion(program, containingFile, contract.symbol.module);
}

/** Resolve a reviewed contract against the runtime/package actually analyzed. */
export function resolveModuleInitializationContract(
  program: ts.Program,
  containingFile: string,
  moduleName: string,
  registry: BuiltinContractRegistry = builtinContractRegistry,
): ModuleInitializationContract | undefined {
  const environment: ModuleInitializationEnvironment = moduleName.startsWith("node:")
    ? { nodeMajor: Number.parseInt(process.versions.node.split(".")[0]!, 10) }
    : { packageVersion: resolvedPackageVersion(program, containingFile, moduleName) };
  return findModuleInitializationContract(registry, moduleName, environment);
}

/**
 * Semantic overlays are applied after TypeChecker symbol resolution. They do
 * not modify or wrap the runtime builtin.
 */
export const builtinContractRegistry: BuiltinContractRegistry = {
  version: 2,
  declarations: [{ library: "lib.dom.d.ts", compilerVersion: "6.0.3", sha256: "d6b1eba8496bdd0eed6fc8a685768fe01b2da4a0388b5fe7df558290bffcf32f" }],
  moduleInitializations: [
    {
      module: "node:*", effects: [], evidence: "trusted",
      runtime: { kind: "node", major: 24 },
      trustReason: "reviewed Node builtin module initialization boundary", trustOwner: "@mizchi/uneffect",
    },
    ...([
      ["@oxlint/plugins", "1.80.0"], ["corsa-oxlint", "1.12.4"], ["effect", "3.22.1"],
      ["typescript", "6.0.3"], ["valibot", "1.4.2"], ["z3-solver", "4.16.0"],
    ] as const).map(([module, packageVersion]): ModuleInitializationContract => ({
      module, runtime: { kind: "package", version: packageVersion }, effects: [], evidence: "trusted",
      trustReason: "reviewed package module initialization boundary", trustOwner: "@mizchi/uneffect",
    })),
  ],
  contracts: materializeBuiltinSemanticDefinitions(builtinSemanticCatalog.definitions),
};
