import ts from "../../support/typescript-compiler.js";
import { dirname, join } from "node:path";
import { builtinContractRegistry, findModuleInitializationContract, type BuiltinContract, type BuiltinContractRegistry, type ModuleInitializationEnvironment, type ModuleInitializationContract } from "../../effects/builtin-contracts.js";

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
