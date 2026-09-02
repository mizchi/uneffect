import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { VerificationArtifact } from "./contracts.js";
import { formatEffect, parseEffectSet } from "./capabilities.js";
import { analyzeProgramEffects, type EffectSummary, type ExternalFunctionEffectContract } from "./effects.js";
import { analyzeCallableSummaries, type CallableSummary } from "./callable-summary.js";
import { analyzeResourceCallableSummaries } from "./resource-callable-typescript.js";
import type { ResourceCallableOperation, ResourceCallableSummary } from "./resource-protocol.js";
import { builtinContractRegistry, type BuiltinContractRegistry, type SemanticModuleLedgerEntry } from "./builtin-contracts.js";
import { inspectBuildOutputs } from "./build-output-integrity.js";
import { resolveFrozenObjectLiteral, stableCallableDeclaration } from "./stable-callable.js";

export interface ContractCallbackSummaryV1 {
  index: number;
  name: string;
  path?: readonly (string | number)[];
  containerAccess?: "borrow-readonly";
  cardinality: "0" | "0..1" | "exactly-1" | "0..n" | "unknown";
  timing: "inline" | "deferred" | "promise-reaction" | "unknown";
  completion: "propagate-throw" | "convert-throw-to-rejection" | "host-report-throw" | "unknown";
  schedulingSource?: "setTimeout" | "setInterval" | "requestAnimationFrame" | "EventTarget.prototype.addEventListener";
  schedulingDelay?: number;
  effectBound?: readonly string[];
}

export interface ContractReturnedCallableV1 {
  effects: string[];
  rejects?: string[];
  evidence: "inferred" | "trusted" | "verified";
}
export interface ContractReturnedMemberV1 extends ContractReturnedCallableV1 {
  key: string;
  parameters?: string[];
  callbacks?: ContractCallbackSummaryV1[];
  returnsReceiver?: boolean;
}

export interface ContractSummaryExportV1 {
  symbol: { module: string; export: string; path?: string[] };
  functionName: string;
  evidence: "verified";
  declarationSpan: { start: number; end: number };
  declarationDigest: string;
  signature: string;
  signatureDigest: string;
  /** Number of type parameters on the primary public signature. */
  genericArity?: number;
  /** Ordered public overloads; the implementation signature is not exported. */
  overloads?: Array<{ signature: string; digest: string; genericArity?: number }>;
  parameters: string[];
  requires: string[];
  ensures: string[];
  artifactIds: string[];
  /** Present when the public entry re-exports a callable implemented in another Program source. */
  implementation?: { fileName: string; sourceDigest: string };
  effect?: {
    effects: string[];
    parameters: string[];
    rejects?: string[];
    returnCallable?: ContractReturnedCallableV1;
    returnMembers?: ContractReturnedMemberV1[];
    callbacks?: ContractCallbackSummaryV1[];
  };
  /** Reviewed lifecycle declaration; linkage is authenticated but implementation semantics remain trusted. */
  resource?: {
    evidence: "trusted";
    operations: ResourceCallableOperation[];
    returnMembers?: Array<{ key: string; operations: ResourceCallableOperation[] }>;
  };
}

export interface ContractSummaryBundleV1 {
  schema: "uneffect-contract-summary/v1";
  package: { name: string; version: string };
  compiler: { typescriptVersion: string; compilerOptionsDigest: string };
  producer: { fileName: string; sourceDigest: string };
  /** Exact trusted semantics inputs used while producing this summary. */
  modules?: readonly SemanticModuleLedgerEntry[];
  /** Package-relative runtime files whose exact bytes were reviewed with this summary. */
  runtimeArtifacts?: readonly { packagePath: string; digest: string }[];
  /** Exact same-compiler outputs re-emitted from the producer Program. */
  typescriptEmit?: {
    outputs: readonly { kind: "declaration" | "runtime"; packagePath: string; digest: string }[];
  };
  exports: ContractSummaryExportV1[];
  contentDigest: string;
}

export interface CreateContractSummaryBundleOptions {
  packageName: string;
  packageVersion: string;
  /** Root package import or one of its explicit subpath import specifiers. */
  moduleSpecifier?: string;
  fileName: string;
  source: string;
  program: ts.Program;
  artifacts: readonly VerificationArtifact[];
  builtinRegistry?: BuiltinContractRegistry;
  runtimeArtifacts?: readonly { packagePath: string; fileName: string }[];
  typescriptEmit?: { packageRoot: string; projectFile?: string };
}

export interface ValidateContractSummaryBundleOptions {
  packageName: string;
  packageVersion: string;
  moduleSpecifier?: string;
  fileName: string;
  source: string;
  program: ts.Program;
  builtinRegistry?: BuiltinContractRegistry;
  runtimeArtifacts?: readonly { packagePath: string; fileName: string }[];
  typescriptEmit?: { packageRoot: string; projectFile?: string };
}

export interface BoundContractSummaryExportV1 {
  exportName: string;
  /** Declaration binding is verified; persisted producer authority is trusted. */
  evidence: "trusted";
  declarationFileName: string;
  declarationSpan: { start: number; end: number };
  declarationDigest: string;
  signature: string;
  callSites: Array<{ fileName: string; span: { start: number; end: number } }>;
  summary: ContractSummaryExportV1;
}

export interface BoundContractSummaryBundleV1 {
  schema: "uneffect-bound-contract-summary/v1";
  status: "not-applicable" | "verified" | "unknown";
  package: { name: string; version: string };
  compiler: { producerTypeScriptVersion: string; consumerTypeScriptVersion: string; consumerCompilerOptionsDigest: string };
  exports: BoundContractSummaryExportV1[];
  blockers: string[];
}

/** Project verified declaration bindings into the existing Effect analyzer IR. */
export function boundContractSummaryEffectContracts(
  bindings: readonly BoundContractSummaryBundleV1[],
): Map<string, ExternalFunctionEffectContract> {
  const contracts = new Map<string, ExternalFunctionEffectContract>();
  for (const binding of bindings) for (const item of binding.exports) if (item.summary.effect) {
    contracts.set(`${item.declarationFileName}:${item.declarationSpan.start}`, {
      effects: item.summary.effect.effects.flatMap((effect) => parseEffectSet(effect)),
      parameters: item.summary.effect.parameters,
      rejects: item.summary.effect.rejects ?? [],
      contractEvidence: "trusted",
      ...(item.summary.effect.returnCallable ? { returnCallable: {
        effects: item.summary.effect.returnCallable.effects.flatMap((effect) => parseEffectSet(effect)),
        rejects: item.summary.effect.returnCallable.rejects ?? [],
        contractEvidence: "trusted",
      } } : {}),
      ...(item.summary.effect.returnMembers ? { returnMembers: item.summary.effect.returnMembers.map((member) => ({
        key: member.key,
        effects: member.effects.flatMap((effect) => parseEffectSet(effect)),
        rejects: member.rejects ?? [],
        parameters: member.parameters,
        returnsReceiver: member.returnsReceiver,
        ...(member.callbacks ? { callbackParameters: member.callbacks.map((callback) => {
          const { effectBound, ...rest } = callback;
          return { ...rest, ...(effectBound ? { effectBound: effectBound.flatMap((effect) => parseEffectSet(effect)) } : {}) };
        }) } : {}),
        contractEvidence: "trusted" as const,
      })) } : {}),
      ...(item.summary.effect.callbacks ? { callbackParameters: item.summary.effect.callbacks.map((callback) => {
        const { effectBound, ...rest } = callback;
        return {
          ...rest,
          ...(effectBound ? { effectBound: effectBound.flatMap((effect) => parseEffectSet(effect)) } : {}),
        };
      }) } : {}),
      functionName: [item.exportName, ...(item.summary.symbol.path ?? [])].join("."),
      authorizedCallSites: item.callSites.map(({ fileName, span }) => `${fileName}:${span.start}:${span.end}`),
      // Linkage is verified structurally. The persisted producer authority is
      // retained separately in the package-contract assumption ledger.
      evidence: "verified",
      reason: `persisted package contract ${binding.package.name}@${binding.package.version}`,
    });
  }
  return contracts;
}

/** Project package lifecycle contracts onto installed TypeChecker declaration identities. */
export function boundContractSummaryResourceContracts(
  bindings: readonly BoundContractSummaryBundleV1[],
): ResourceCallableSummary[] {
  return bindings.flatMap((binding) => binding.exports.flatMap((item): ResourceCallableSummary[] => item.summary.resource ? [{
    schema: "uneffect-resource-callable-summary/v1",
    id: `${item.declarationFileName}:${item.declarationSpan.start}`,
    evidence: "trusted",
    operations: item.summary.resource.operations,
    ...(item.summary.resource.returnMembers ? { returnMembers: item.summary.resource.returnMembers } : {}),
  }] : []));
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const sha256File = (fileName: string): string => createHash("sha256").update(readFileSync(fileName)).digest("hex");
function validPackagePath(packagePath: string): boolean {
  return packagePath.length > 0 && !packagePath.startsWith("/") && !packagePath.includes("\\")
    && packagePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
function packageModuleSpecifier(packageName: string, requested?: string): string {
  const moduleSpecifier = requested ?? packageName;
  const suffix = moduleSpecifier.startsWith(`${packageName}/`) ? moduleSpecifier.slice(packageName.length + 1) : undefined;
  if (moduleSpecifier !== packageName && (suffix === undefined || !validPackagePath(suffix))) {
    throw new Error(`contract summary module specifier must be the package root or a subpath of ${packageName}`);
  }
  return moduleSpecifier;
}
function runtimeArtifactLedger(
  artifacts: readonly { packagePath: string; fileName: string }[] | undefined,
): readonly { packagePath: string; digest: string }[] | undefined {
  if (!artifacts?.length) return undefined;
  if (new Set(artifacts.map(({ packagePath }) => packagePath)).size !== artifacts.length) {
    throw new Error("contract summary runtime artifact paths must be unique");
  }
  return artifacts.map(({ packagePath, fileName }) => {
    if (!validPackagePath(packagePath)) throw new Error(`invalid package-relative runtime artifact path ${packagePath}`);
    if (!existsSync(fileName)) throw new Error(`contract summary runtime artifact does not exist: ${fileName}`);
    return { packagePath, digest: sha256File(fileName) };
  });
}
function typescriptEmitLedger(
  program: ts.Program,
  options: { packageRoot: string; projectFile?: string } | undefined,
): ContractSummaryBundleV1["typescriptEmit"] {
  if (!options) return undefined;
  const integrity = inspectBuildOutputs(program, options.projectFile);
  if (integrity.status !== "verified") {
    throw new Error(`contract summary TypeScript emit is not exact: ${integrity.message ?? integrity.status}`);
  }
  const packageRoot = resolve(options.packageRoot);
  const outputs = integrity.outputs.map((output) => {
    const packagePath = relative(packageRoot, resolve(output.fileName)).replaceAll("\\", "/");
    if (!validPackagePath(packagePath)) {
      throw new Error(`TypeScript emit output is outside package root: ${output.fileName}`);
    }
    return { kind: output.kind, packagePath, digest: output.expectedDigest };
  }).sort((left, right) => left.packagePath.localeCompare(right.packagePath));
  if (outputs.length === 0) throw new Error("contract summary TypeScript emit produced no declaration or runtime outputs");
  if (new Set(outputs.map(({ packagePath }) => packagePath)).size !== outputs.length) {
    throw new Error("contract summary TypeScript emit output paths must be unique");
  }
  return { outputs };
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, ordered(item)]));
  return value;
}
const canonical = (value: unknown): string => JSON.stringify(ordered(value));
const compilerOptionsDigest = (program: ts.Program): string => sha256(canonical(program.getCompilerOptions()));
const bundleDigest = (bundle: Omit<ContractSummaryBundleV1, "contentDigest">): string => sha256(canonical(bundle));

/** Load a versioned summary. Full provenance validation happens when it is bound to a Program. */
export async function loadContractSummaryBundle(fileName: string): Promise<ContractSummaryBundleV1> {
  let value: unknown;
  try { value = JSON.parse(await readFile(fileName, "utf8")); }
  catch (cause) { throw new Error(`cannot load contract summary ${fileName}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (!value || typeof value !== "object" || (value as { schema?: unknown }).schema !== "uneffect-contract-summary/v1") {
    throw new Error(`unsupported contract summary schema in ${fileName}`);
  }
  const bundle = value as ContractSummaryBundleV1;
  if (!bundle.package || typeof bundle.package.name !== "string" || typeof bundle.package.version !== "string"
    || !bundle.compiler || typeof bundle.compiler.typescriptVersion !== "string"
    || typeof bundle.compiler.compilerOptionsDigest !== "string" || !bundle.producer
    || typeof bundle.producer.fileName !== "string" || typeof bundle.producer.sourceDigest !== "string"
    || !Array.isArray(bundle.exports) || typeof bundle.contentDigest !== "string") {
    throw new Error(`malformed contract summary ${fileName}`);
  }
  if (bundle.modules !== undefined && (!Array.isArray(bundle.modules)
    || bundle.modules.some((module) => !module || typeof module !== "object"
      || typeof module.name !== "string" || typeof module.version !== "string"
      || typeof module.namespace !== "string" || module.evidence !== "trusted"
      || typeof module.trustOwner !== "string" || typeof module.trustReason !== "string"
      || !/^[0-9a-f]{64}$/u.test(module.digest))
    || new Set(bundle.modules.map((module) => `${module.name}@${module.version}`)).size !== bundle.modules.length)) {
    throw new Error(`malformed contract summary semantics-module ledger ${fileName}`);
  }
  if (bundle.runtimeArtifacts !== undefined && (!Array.isArray(bundle.runtimeArtifacts)
    || bundle.runtimeArtifacts.length === 0
    || bundle.runtimeArtifacts.some((artifact) => !artifact || typeof artifact !== "object"
      || typeof artifact.packagePath !== "string" || !validPackagePath(artifact.packagePath)
      || typeof artifact.digest !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.digest))
    || new Set(bundle.runtimeArtifacts.map(({ packagePath }) => packagePath)).size !== bundle.runtimeArtifacts.length)) {
    throw new Error(`malformed contract summary runtime artifact ledger ${fileName}`);
  }
  if (bundle.typescriptEmit !== undefined && (!bundle.typescriptEmit || typeof bundle.typescriptEmit !== "object"
    || !Array.isArray(bundle.typescriptEmit.outputs) || bundle.typescriptEmit.outputs.length === 0
    || bundle.typescriptEmit.outputs.some((output) => !output || typeof output !== "object"
      || (output.kind !== "declaration" && output.kind !== "runtime")
      || typeof output.packagePath !== "string" || !validPackagePath(output.packagePath)
      || typeof output.digest !== "string" || !/^[0-9a-f]{64}$/u.test(output.digest))
    || new Set(bundle.typescriptEmit.outputs.map(({ packagePath }) => packagePath)).size !== bundle.typescriptEmit.outputs.length)) {
    throw new Error(`malformed contract summary TypeScript emit ledger ${fileName}`);
  }
  for (const [index, item] of bundle.exports.entries()) {
    try { packageModuleSpecifier(bundle.package.name, item?.symbol?.module); }
    catch { throw new Error(`malformed contract summary export ${index} in ${fileName}`); }
    const validCallback = (callback: ContractCallbackSummaryV1): boolean =>
      Boolean(callback && typeof callback === "object"
        && Number.isInteger(callback.index) && callback.index >= 0
        && typeof callback.name === "string"
        && (callback.path === undefined || (Array.isArray(callback.path)
          && callback.path.every((part) => typeof part === "string" || Number.isInteger(part))))
        && (callback.containerAccess === undefined || callback.containerAccess === "borrow-readonly")
        && ["0", "0..1", "exactly-1", "0..n", "unknown"].includes(callback.cardinality)
        && ["inline", "deferred", "promise-reaction", "unknown"].includes(callback.timing)
        && ["propagate-throw", "convert-throw-to-rejection", "host-report-throw", "unknown"].includes(callback.completion)
        && (callback.schedulingSource === undefined || ["setTimeout", "setInterval", "requestAnimationFrame", "EventTarget.prototype.addEventListener"].includes(callback.schedulingSource))
        && (callback.schedulingDelay === undefined || ((callback.schedulingSource === "setTimeout" || callback.schedulingSource === "setInterval")
          && Number.isFinite(callback.schedulingDelay) && callback.schedulingDelay >= 0))
        && (callback.effectBound === undefined || (Array.isArray(callback.effectBound)
          && callback.effectBound.every((entry) => typeof entry === "string"))));
    const validResourceReference = (reference: unknown): boolean => Boolean(reference && typeof reference === "object"
      && ((reference as { kind?: unknown }).kind === "return" || (reference as { kind?: unknown }).kind === "receiver"
        || ((reference as { kind?: unknown }).kind === "parameter"
          && Number.isInteger((reference as { index?: unknown }).index)
          && ((reference as { index: number }).index >= 0))));
    const validResourceOperation = (operation: ResourceCallableOperation): boolean => {
      if (!operation || typeof operation !== "object"
        || !["acquire", "use", "borrow", "consume", "release", "transfer", "escape"].includes(operation.kind)
        || !validResourceReference(operation.subject)) return false;
      if (operation.kind === "acquire") return operation.subject.kind === "return" && operation.target === undefined;
      if (operation.kind === "transfer") return validResourceReference(operation.target);
      return operation.target === undefined;
    };
    if (!item || typeof item !== "object" || !item.symbol
      || typeof item.symbol.module !== "string" || typeof item.symbol.export !== "string"
      || (item.symbol.path !== undefined && (!Array.isArray(item.symbol.path) || item.symbol.path.length === 0
        || !item.symbol.path.every((entry) => typeof entry === "string" && entry.length > 0)))
      || typeof item.functionName !== "string" || item.evidence !== "verified"
      || !item.declarationSpan || !Number.isInteger(item.declarationSpan.start) || !Number.isInteger(item.declarationSpan.end)
      || typeof item.declarationDigest !== "string" || typeof item.signature !== "string"
      || typeof item.signatureDigest !== "string" || !Array.isArray(item.parameters)
      || (item.genericArity !== undefined && (!Number.isInteger(item.genericArity) || item.genericArity <= 0))
      || (item.overloads !== undefined && (!Array.isArray(item.overloads) || item.overloads.length < 2
        || item.overloads.some((overload) => !overload || typeof overload.signature !== "string"
          || typeof overload.digest !== "string" || !/^[0-9a-f]{64}$/u.test(overload.digest)
          || (overload.genericArity !== undefined
            && (!Number.isInteger(overload.genericArity) || overload.genericArity <= 0))
          || sha256(overload.signature) !== overload.digest)
        || new Set(item.overloads.map(({ signature }) => signature)).size !== item.overloads.length
        || item.overloads[0]?.signature !== item.signature))
      || !item.parameters.every((entry) => typeof entry === "string")
      || !Array.isArray(item.requires) || !item.requires.every((entry) => typeof entry === "string")
      || !Array.isArray(item.ensures) || !item.ensures.every((entry) => typeof entry === "string")
      || !Array.isArray(item.artifactIds) || !item.artifactIds.every((entry) => typeof entry === "string")
      || (item.implementation !== undefined && (!item.implementation || typeof item.implementation !== "object"
        || typeof item.implementation.fileName !== "string" || item.implementation.fileName.length === 0
        || typeof item.implementation.sourceDigest !== "string" || !/^[0-9a-f]{64}$/u.test(item.implementation.sourceDigest)))
      || (item.effect !== undefined && (!item.effect || typeof item.effect !== "object"
        || !Array.isArray(item.effect.effects) || !item.effect.effects.every((entry) => typeof entry === "string")
        || !Array.isArray(item.effect.parameters) || !item.effect.parameters.every((entry) => typeof entry === "string")
        || (item.effect.rejects !== undefined && (!Array.isArray(item.effect.rejects)
          || !item.effect.rejects.every((entry) => typeof entry === "string")))
        || (item.effect.returnCallable !== undefined && (!item.effect.returnCallable
          || !Array.isArray(item.effect.returnCallable.effects)
          || !item.effect.returnCallable.effects.every((entry) => typeof entry === "string")
          || !["inferred", "trusted", "verified"].includes(item.effect.returnCallable.evidence)
          || (item.effect.returnCallable.rejects !== undefined && (!Array.isArray(item.effect.returnCallable.rejects)
            || !item.effect.returnCallable.rejects.every((entry) => typeof entry === "string")))))
        || (item.effect.returnMembers !== undefined && (!Array.isArray(item.effect.returnMembers)
          || !item.effect.returnMembers.every((member) => member && typeof member.key === "string"
            && Array.isArray(member.effects) && member.effects.every((entry) => typeof entry === "string")
            && ["inferred", "trusted", "verified"].includes(member.evidence)
            && (member.parameters === undefined || (Array.isArray(member.parameters)
              && member.parameters.every((entry) => typeof entry === "string")))
            && (member.callbacks === undefined || (Array.isArray(member.callbacks)
              && member.callbacks.every(validCallback)))
            && (member.returnsReceiver === undefined || typeof member.returnsReceiver === "boolean")
            && (member.rejects === undefined || (Array.isArray(member.rejects)
              && member.rejects.every((entry) => typeof entry === "string"))))))
        || (item.effect.callbacks !== undefined && (!Array.isArray(item.effect.callbacks)
          || !item.effect.callbacks.every(validCallback)))))
      || (item.resource !== undefined && (!item.resource || item.resource.evidence !== "trusted"
        || !Array.isArray(item.resource.operations) || !item.resource.operations.every(validResourceOperation)
        || (item.resource.returnMembers !== undefined && (!Array.isArray(item.resource.returnMembers)
          || !item.resource.returnMembers.every((member) => member && typeof member.key === "string"
            && Array.isArray(member.operations) && member.operations.length > 0
            && member.operations.every(validResourceOperation))))))) {
      throw new Error(`malformed contract summary export ${index} in ${fileName}`);
    }
  }
  return bundle;
}

function installedPackageAt(declarationFileName: string, packageName: string): { name: string; version: string; directory: string } | undefined {
  let directory = dirname(declarationFileName);
  for (;;) {
    const manifestFile = join(directory, "package.json");
    if (existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === packageName && typeof manifest.version === "string") {
          return { name: packageName, version: manifest.version, directory };
        }
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Bind a producer contract bundle to declarations actually resolved by a
 * consumer Program. This authenticates identity and installed bytes; it does
 * not authenticate the publisher or prove that runtime JavaScript matches the
 * declaration package.
 */
export function bindContractSummaryBundleToProgram(
  bundle: ContractSummaryBundleV1,
  program: ts.Program,
  builtinRegistry: BuiltinContractRegistry = builtinContractRegistry,
): BoundContractSummaryBundleV1 {
  const blockers: string[] = [];
  const { contentDigest, ...unsigned } = bundle;
  if (bundle.schema !== "uneffect-contract-summary/v1") blockers.push(`unsupported contract summary schema ${bundle.schema}`);
  if (bundleDigest(unsigned) !== contentDigest) blockers.push("contract summary content digest does not match its payload");
  if (canonical(bundle.modules ?? []) !== canonical(builtinRegistry.modules ?? [])) {
    blockers.push("contract summary semantics-module ledger does not match the consumer registry");
  }
  if (bundle.runtimeArtifacts !== undefined && (!Array.isArray(bundle.runtimeArtifacts)
    || bundle.runtimeArtifacts.length === 0
    || bundle.runtimeArtifacts.some((artifact) => !artifact || typeof artifact !== "object"
      || typeof artifact.packagePath !== "string" || !validPackagePath(artifact.packagePath)
      || typeof artifact.digest !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.digest))
    || new Set(bundle.runtimeArtifacts.map(({ packagePath }) => packagePath)).size !== bundle.runtimeArtifacts.length)) {
    blockers.push("contract summary runtime artifact ledger is malformed");
  }
  if (bundle.typescriptEmit !== undefined && (!bundle.typescriptEmit || typeof bundle.typescriptEmit !== "object"
    || !Array.isArray(bundle.typescriptEmit.outputs) || bundle.typescriptEmit.outputs.length === 0
    || bundle.typescriptEmit.outputs.some((output) => !output || typeof output !== "object"
      || (output.kind !== "declaration" && output.kind !== "runtime")
      || typeof output.packagePath !== "string" || !validPackagePath(output.packagePath)
      || typeof output.digest !== "string" || !/^[0-9a-f]{64}$/u.test(output.digest))
    || new Set(bundle.typescriptEmit.outputs.map(({ packagePath }) => packagePath)).size !== bundle.typescriptEmit.outputs.length)) {
    blockers.push("contract summary TypeScript emit ledger is malformed");
  }
  if (bundle.compiler.typescriptVersion !== ts.version) {
    blockers.push(`contract summary TypeScript ${bundle.compiler.typescriptVersion} does not match consumer ${ts.version}`);
  }
  if (blockers.length > 0) return {
    schema: "uneffect-bound-contract-summary/v1",
    status: "unknown",
    package: bundle.package,
    compiler: {
      producerTypeScriptVersion: bundle.compiler.typescriptVersion,
      consumerTypeScriptVersion: ts.version,
      consumerCompilerOptionsDigest: compilerOptionsDigest(program),
    },
    exports: [],
    blockers,
  };
  const checker = program.getTypeChecker();
  const allowedSymbols = new Map<string, Set<ts.Symbol>>();
  const allowedRoots = new Map<string, Set<ts.Symbol>>();
  const bindingKey = (moduleSpecifier: string, exportName: string, path: readonly string[] = []): string =>
    `${moduleSpecifier}\0${exportName}\0${path.join("\0")}`;
  const summarizedModules = new Set(bundle.exports.map((item) => item.symbol.module));
  const memberSymbol = (root: ts.Symbol, path: readonly string[]): ts.Symbol | undefined => {
    let selected = root;
    for (const member of path) {
      const location = selected.valueDeclaration ?? selected.declarations?.[0];
      if (!location) return undefined;
      const property = checker.getPropertyOfType(checker.getTypeOfSymbolAtLocation(selected, location), member);
      if (!property) return undefined;
      selected = (property.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(property) : property;
    }
    return selected;
  };
  const rememberModuleExports = (moduleSpecifier: ts.StringLiteralLike): void => {
    if (!summarizedModules.has(moduleSpecifier.text)) return;
    const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
    if (!moduleSymbol) return;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
      if (!target.declarations?.length) continue;
      for (const summary of bundle.exports) {
        if (summary.symbol.module !== moduleSpecifier.text || summary.symbol.export !== exported.getName()) continue;
        const selectedTarget = memberSymbol(target, summary.symbol.path ?? []);
        if (!selectedTarget?.declarations?.length) continue;
        const key = bindingKey(moduleSpecifier.text, exported.getName(), summary.symbol.path);
        const selected = allowedSymbols.get(key) ?? new Set<ts.Symbol>();
        selected.add(selectedTarget);
        allowedSymbols.set(key, selected);
        const roots = allowedRoots.get(key) ?? new Set<ts.Symbol>();
        roots.add(target);
        allowedRoots.set(key, roots);
      }
    }
  };
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        rememberModuleExports(node.moduleSpecifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const candidates = new Map<string, Array<{
    declaration: ts.Declaration; signature: string; availableSignatures: string[]; call: ts.CallExpression;
    typeScriptValid: boolean;
  }>>();
  const unwrap = (input: ts.Expression): ts.Expression => {
    let expression = input;
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression)) expression = expression.expression;
    return expression;
  };
  const hasRootPath = (
    input: ts.Expression,
    roots: ReadonlySet<ts.Symbol>,
    path: readonly string[],
    seen: ReadonlySet<ts.Symbol> = new Set(),
  ): boolean => {
    const expression = unwrap(input);
    const location = ts.isPropertyAccessExpression(expression) ? expression.name
      : ts.isElementAccessExpression(expression) ? expression.argumentExpression : expression;
    let symbol = location ? checker.getSymbolAtLocation(location) : undefined;
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    if (path.length === 0 && symbol && roots.has(symbol)) return true;
    if (ts.isIdentifier(expression) && symbol && !seen.has(symbol)) {
      const declaration = symbol.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
        return hasRootPath(declaration.initializer, roots, path, new Set(seen).add(symbol));
      }
      if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
        && path.length > 0) {
        const variable = declaration.parent.parent;
        const keyNode = declaration.propertyName ?? (ts.isIdentifier(declaration.name) ? declaration.name : undefined);
        const key = keyNode && (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode)
          || ts.isNumericLiteral(keyNode)) ? keyNode.text : undefined;
        if (key === path[path.length - 1] && ts.isVariableDeclaration(variable) && variable.initializer
          && ts.isVariableDeclarationList(variable.parent) && (variable.parent.flags & ts.NodeFlags.Const) !== 0) {
          return hasRootPath(variable.initializer, roots, path.slice(0, -1), new Set(seen).add(symbol));
        }
      }
    }
    if (path.length === 0) return false;
    const expected = path[path.length - 1];
    const access = ts.isPropertyAccessExpression(expression) ? { receiver: expression.expression, key: expression.name.text }
      : ts.isElementAccessExpression(expression) && expression.argumentExpression
        && (ts.isStringLiteralLike(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression))
        ? { receiver: expression.expression, key: expression.argumentExpression.text } : undefined;
    return access?.key === expected && hasRootPath(access.receiver, roots, path.slice(0, -1), seen);
  };
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const semanticErrors = program.getSemanticDiagnostics(source)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
        && diagnostic.file === source && diagnostic.start !== undefined && diagnostic.length !== undefined);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        if (signature) for (const [key, symbols] of allowedSymbols) {
          const summary = bundle.exports.find((item) => key === bindingKey(item.symbol.module, item.symbol.export, item.symbol.path));
          const roots = allowedRoots.get(key);
          if (!summary || !roots || !hasRootPath(node.expression, roots, summary.symbol.path ?? [])) continue;
          const symbol = [...symbols][0];
          const declaration = symbol?.declarations?.[0];
          if (!symbol || !declaration) continue;
          candidates.set(key, [...(candidates.get(key) ?? []), {
            declaration, signature: checker.signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation),
            availableSignatures: checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, declaration), ts.SignatureKind.Call)
              .map((available) => checker.signatureToString(available, declaration, ts.TypeFormatFlags.NoTruncation)),
            typeScriptValid: !semanticErrors.some((diagnostic) => diagnostic.start! < node.getEnd()
              && diagnostic.start! + diagnostic.length! > node.getStart(source)),
            call: node,
          }]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const exports: BoundContractSummaryExportV1[] = [];
  for (const summary of bundle.exports) {
    const uses = candidates.get(bindingKey(summary.symbol.module, summary.symbol.export, summary.symbol.path)) ?? [];
    const declarations = [...new Set(uses.map(({ declaration }) => declaration))];
    if (declarations.length === 0) continue;
    if (declarations.length !== 1) {
      blockers.push(`contract summary export ${summary.symbol.export} resolves ambiguously in the consumer Program`);
      continue;
    }
    const declaration = declarations[0]!;
    const declarationSource = declaration.getSourceFile();
    const installed = installedPackageAt(declarationSource.fileName, bundle.package.name);
    if (!installed) {
      blockers.push(`contract summary export ${summary.symbol.export} is not backed by an installed ${bundle.package.name} package manifest`);
      continue;
    }
    if (installed.version !== bundle.package.version) {
      blockers.push(`installed ${bundle.package.name} version ${installed.version} does not match summary ${bundle.package.version}`);
      continue;
    }
    let runtimeMatches = true;
    for (const artifact of bundle.runtimeArtifacts ?? []) {
      const installedFile = join(installed.directory, ...artifact.packagePath.split("/"));
      if (!existsSync(installedFile) || sha256File(installedFile) !== artifact.digest) {
        const message = `installed ${bundle.package.name} runtime artifact ${artifact.packagePath} does not match summary digest`;
        if (!blockers.includes(message)) blockers.push(message);
        runtimeMatches = false;
      }
    }
    for (const output of bundle.typescriptEmit?.outputs ?? []) {
      const installedFile = join(installed.directory, ...output.packagePath.split("/"));
      if (!existsSync(installedFile) || sha256File(installedFile) !== output.digest) {
        const message = `installed ${bundle.package.name} TypeScript ${output.kind} output ${output.packagePath} does not match summary digest`;
        if (!blockers.includes(message)) blockers.push(message);
        runtimeMatches = false;
      }
    }
    if (!runtimeMatches) continue;
    const signatures = [...new Set(uses.map((use) => use.signature))];
    const acceptedSignatures = summary.overloads
      ?? [{ signature: summary.signature, digest: summary.signatureDigest, genericArity: summary.genericArity }];
    const accepted = new Set(acceptedSignatures
      .filter(({ signature, digest }) => sha256(signature) === digest)
      .map(({ signature }) => signature));
    const availableSets = [...new Set(uses.map(({ availableSignatures }) => canonical(availableSignatures)))];
    const hasGenericSignature = acceptedSignatures.some(({ genericArity }) => (genericArity ?? 0) > 0);
    if (signatures.length === 0 || (!hasGenericSignature && signatures.some((signature) => !accepted.has(signature)))
      || availableSets.length !== 1
      || availableSets[0] !== canonical(acceptedSignatures.map(({ signature }) => signature))) {
      blockers.push(`contract summary signature for ${summary.symbol.export} does not match the installed declaration`);
      continue;
    }
    if (uses.some(({ typeScriptValid }) => !typeScriptValid)) {
      blockers.push(`contract summary call to ${summary.symbol.export} is TypeScript-invalid`);
      continue;
    }
    const signatureText = signatures.join(" | ");
    const declarationText = declarationSource.text.slice(declaration.getStart(declarationSource), declaration.getEnd());
    exports.push({
      exportName: summary.symbol.export,
      evidence: "trusted",
      declarationFileName: declarationSource.fileName,
      declarationSpan: { start: declaration.getStart(declarationSource), end: declaration.getEnd() },
      declarationDigest: sha256(declarationText),
      signature: signatureText,
      callSites: uses.map(({ call }) => ({
        fileName: call.getSourceFile().fileName,
        span: { start: call.getStart(call.getSourceFile()), end: call.getEnd() },
      })),
      summary,
    });
  }
  return {
    schema: "uneffect-bound-contract-summary/v1",
    status: blockers.length > 0 ? "unknown" : exports.length > 0 ? "verified" : "not-applicable",
    package: bundle.package,
    compiler: {
      producerTypeScriptVersion: bundle.compiler.typescriptVersion,
      consumerTypeScriptVersion: ts.version,
      consumerCompilerOptionsDigest: compilerOptionsDigest(program),
    },
    exports,
    blockers,
  };
}

function checkedSource(options: Pick<CreateContractSummaryBundleOptions, "fileName" | "source" | "program">): ts.SourceFile {
  const source = options.program.getSourceFile(options.fileName);
  if (!source || source.text !== options.source) throw new Error(`contract summary source does not match Program source ${options.fileName}`);
  const errors = [...options.program.getSyntacticDiagnostics(source), ...options.program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(`contract summary cannot use a Program with TypeScript errors in ${options.fileName}`);
  return source;
}

type DirectExportCallable = {
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  owner: ts.FunctionDeclaration | ts.MethodDeclaration | ts.PropertyAssignment | ts.ShorthandPropertyAssignment
    | ts.VariableStatement | ts.ExportAssignment;
  exportName: string;
  memberPath?: string[];
  functionName: string;
};

function targetSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function callableFromSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined, exportName: string): DirectExportCallable[] {
  if (!symbol) return [];
  const resolved = targetSymbol(checker, symbol);
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!declaration || declaration.getSourceFile().isDeclarationFile) return [];
  if (ts.isFunctionDeclaration(declaration) && declaration.body && declaration.name) return [{
    node: declaration, owner: declaration, exportName, functionName: declaration.name.text,
  }];
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || !declaration.initializer
    || !ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0
    || !ts.isVariableStatement(declaration.parent.parent)) return [];
  let initializer = declaration.initializer;
  while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
    || ts.isTypeAssertionExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? [{
    node: initializer, owner: declaration.parent.parent, exportName, functionName: declaration.name.text,
  }] : [];
}

function directExportCallables(statement: ts.Statement, checker: ts.TypeChecker): DirectExportCallable[] {
  if (ts.isFunctionDeclaration(statement)) {
    if (!statement.body || !statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) return [];
    const isDefault = statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword);
    if (!isDefault && !statement.name) return [];
    return [{ node: statement, owner: statement, exportName: isDefault ? "default" : statement.name!.text,
      functionName: statement.name?.text ?? "default" }];
  }
  if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    let expression = statement.expression;
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return [{
      node: expression, owner: statement, exportName: "default", functionName: expression.name?.text ?? "default",
    }];
    return [];
  }
  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    const external = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text : undefined;
    if (external !== undefined && !external.startsWith(".")) return [];
    return statement.exportClause.elements.flatMap((specifier): DirectExportCallable[] => {
      let symbol = external === undefined
        ? checker.getExportSpecifierLocalTargetSymbol(specifier) : checker.getSymbolAtLocation(specifier.name);
      return callableFromSymbol(checker, symbol, specifier.name.text);
    });
  }
  if (ts.isExportDeclaration(statement) && !statement.exportClause
    && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
    && statement.moduleSpecifier.text.startsWith(".")) {
    const dependency = checker.getSymbolAtLocation(statement.moduleSpecifier);
    const entry = checker.getSymbolAtLocation(statement.getSourceFile());
    if (!dependency || !entry) return [];
    const selected = new Map(checker.getExportsOfModule(entry).map((symbol) => [symbol.getName(), targetSymbol(checker, symbol)]));
    return checker.getExportsOfModule(dependency).flatMap((symbol): DirectExportCallable[] => {
      if (symbol.getName() === "default" || selected.get(symbol.getName()) !== targetSymbol(checker, symbol)) return [];
      return callableFromSymbol(checker, symbol, symbol.getName());
    });
  }
  if (!ts.isVariableStatement(statement)
    || !statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    || statement.declarationList.declarations.length !== 1
    || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return [];
  const declaration = statement.declarationList.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return [];
  const exportName = declaration.name.text;
  const frozen = resolveFrozenObjectLiteral(checker, declaration.name);
  if (frozen) return frozen.properties.flatMap((property): DirectExportCallable[] => {
    const propertyName = property.name;
    if (!propertyName || !(ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)
      || ts.isNumericLiteral(propertyName))) return [];
    const key = propertyName.text;
    const symbol = checker.getSymbolAtLocation(propertyName);
    const callable = symbol && stableCallableDeclaration(symbol);
    if (!callable || callable.getSourceFile().isDeclarationFile
      || !(ts.isFunctionDeclaration(callable) || ts.isMethodDeclaration(callable)
        || ts.isArrowFunction(callable) || ts.isFunctionExpression(callable))
      || !callable.body) return [];
    return [{
      node: callable,
      owner: ts.isMethodDeclaration(callable) ? callable
        : ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) ? property : statement,
      exportName,
      memberPath: [key],
      functionName: `${exportName}.${key}`,
    }];
  });
  let initializer = declaration.initializer;
  while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
    || ts.isTypeAssertionExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? [{ node: initializer, owner: statement, exportName: declaration.name.text, functionName: declaration.name.text }] : [];
}

function exportedCallables(source: ts.SourceFile, checker: ts.TypeChecker): DirectExportCallable[] {
  const unique = new Map<string, DirectExportCallable>();
  for (const exported of source.statements.flatMap((statement) => directExportCallables(statement, checker))) {
    const key = `${exported.exportName}\0${exported.memberPath?.join("\0") ?? ""}`;
    const previous = unique.get(key);
    if (!previous || previous.node === exported.node) unique.set(key, exported);
  }
  return [...unique.values()];
}

function summaryParameterNames(node: DirectExportCallable["node"]): string[] {
  return node.parameters.map((parameter, index) => ts.isIdentifier(parameter.name) ? parameter.name.text : `$arg${index}`);
}

function publicSignatures(program: ts.Program, node: DirectExportCallable["node"]): Array<{
  signature: string; digest: string; genericArity?: number;
}> {
  const checker = program.getTypeChecker();
  const name = ts.isFunctionDeclaration(node) && node.name ? node.name
    : ts.isMethodDeclaration(node) ? node.name
    : (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)
      && ts.isIdentifier(node.parent.name) ? node.parent.name
      : (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(node.parent)
        ? node.parent.name : undefined;
  const symbol = name ? checker.getSymbolAtLocation(name) : undefined;
  const signatures = symbol ? checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(symbol, node), ts.SignatureKind.Call) : [];
  const fallback = checker.getSignatureFromDeclaration(node);
  const selected = signatures.length > 0 ? signatures : fallback ? [fallback] : [];
  const unique = new Map<string, { signature: string; digest: string; genericArity?: number }>();
  for (const signature of selected) {
    const text = checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation);
    const genericArity = signature.typeParameters?.length ?? 0;
    unique.set(text, { signature: text, digest: sha256(text), ...(genericArity > 0 ? { genericArity } : {}) });
  }
  return [...unique.values()];
}

function describeExport(
  program: ts.Program,
  source: ts.SourceFile,
  exported: DirectExportCallable,
  moduleSpecifier: string,
  artifacts: readonly VerificationArtifact[],
  effectSummary?: EffectSummary,
  callableSummary?: CallableSummary,
  resourceSummary?: ResourceCallableSummary,
  resourceReturnMembers: readonly { readonly key: string; readonly operations: readonly ResourceCallableOperation[] }[] = [],
): ContractSummaryExportV1 | undefined {
  const { node, owner, exportName, functionName } = exported;
  if (!node.body) return undefined;
  const implementationSource = node.getSourceFile();
  const implementationErrors = [...program.getSyntacticDiagnostics(implementationSource), ...program.getSemanticDiagnostics(implementationSource)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (implementationErrors.length > 0) throw new Error(`contract summary cannot use a Program with TypeScript errors in ${implementationSource.fileName}`);
  const comments = implementationSource.text.slice(owner.getFullStart(), owner.getStart(implementationSource));
  const ensures = extractAnnotations(comments, "ensures");
  const effectDeclared = extractAnnotations(comments, "effect").length > 0;
  if (ensures.length === 0 && !effectDeclared && !resourceSummary?.operations.length && resourceReturnMembers.length === 0) return undefined;
  const requires = extractAnnotations(comments, "requires");
  const span = { start: node.getStart(implementationSource), end: node.getEnd() };
  const candidates = artifacts.filter((artifact) => artifact.source.fileName === implementationSource.fileName
    && artifact.obligation?.functionName === functionName && artifact.source.span.start >= span.start && artifact.source.span.end <= span.end);
  const covered = ensures.every((clause) => candidates.some((artifact) => artifact.obligation?.clause === "ensures" && artifact.obligation.source === clause));
  const verified = candidates.length > 0 && covered && candidates.every((artifact) => artifact.status === "verified"
    && (artifact.controlFlow?.relationalCalls?.every(({ evidence }) => evidence === "verified") ?? true));
  if (ensures.length > 0 && !verified) throw new Error(`${exportName} is not fully verified and cannot be published as a contract summary`);
  const callableEffectFallback = callableSummary && callableSummary.evidence !== "unknown"
    && callableSummary.unknownReasons.length === 0 && callableSummary.callbackParameters.length > 0;
  if (effectDeclared && effectSummary?.evidence !== "verified" && !callableEffectFallback) {
    throw new Error(`${exportName} Effect summary is not verified and cannot be published`);
  }
  const signatures = publicSignatures(program, node);
  const signatureText = signatures[0]?.signature;
  if (!signatureText) throw new Error(`${exportName} has no TypeChecker signature`);
  const declarationText = implementationSource.text.slice(span.start, span.end);
  return {
    symbol: { module: moduleSpecifier, export: exportName, ...(exported.memberPath ? { path: exported.memberPath } : {}) },
    functionName, evidence: "verified",
    declarationSpan: span, declarationDigest: sha256(declarationText),
    signature: signatureText, signatureDigest: sha256(signatureText),
    ...(signatures[0]?.genericArity ? { genericArity: signatures[0].genericArity } : {}),
    ...(signatures.length > 1 ? { overloads: signatures } : {}),
    parameters: summaryParameterNames(node),
    requires, ensures, artifactIds: candidates.map(({ obligationId }) => obligationId).sort(),
    ...(implementationSource.fileName !== source.fileName ? { implementation: {
      fileName: implementationSource.fileName, sourceDigest: sha256(implementationSource.text),
    } } : {}),
    ...(effectDeclared && (effectSummary || callableSummary) ? { effect: {
      effects: (effectSummary?.evidence === "verified" ? effectSummary.effects : callableSummary!.effects).map(formatEffect).sort(),
      parameters: summaryParameterNames(node),
      ...(callableSummary?.rejects.length ? { rejects: [...callableSummary.rejects].sort() } : {}),
      ...(callableSummary?.returnCallable ? { returnCallable: {
        effects: callableSummary.returnCallable.effects.map(formatEffect).sort(),
        ...(callableSummary.returnCallable.rejects.length ? { rejects: [...callableSummary.returnCallable.rejects].sort() } : {}),
        evidence: callableSummary.returnCallable.evidence,
      } } : {}),
      ...(callableSummary?.returnMembers?.length ? { returnMembers: callableSummary.returnMembers.map((member) => ({
        key: member.key, effects: member.effects.map(formatEffect).sort(),
        parameters: [...member.parameters],
        ...(member.returnsReceiver ? { returnsReceiver: true } : {}),
        ...(member.callbackParameters.length ? { callbacks: member.callbackParameters.map((callback) => ({
          index: callback.index, name: callback.name,
          ...(callback.path ? { path: callback.path } : {}),
          ...(callback.containerAccess ? { containerAccess: callback.containerAccess } : {}),
          cardinality: callback.cardinality, timing: callback.timing, completion: callback.completion,
          ...(callback.schedulingSource ? { schedulingSource: callback.schedulingSource } : {}),
          ...(callback.schedulingDelay !== undefined ? { schedulingDelay: callback.schedulingDelay } : {}),
          ...(callback.effectBound ? { effectBound: callback.effectBound } : {}),
        })) } : {}),
        ...(member.rejects.length ? { rejects: [...member.rejects].sort() } : {}), evidence: member.evidence,
      })) } : {}),
      ...(callableSummary?.callbackParameters.length ? { callbacks: callableSummary.callbackParameters.map((callback) => ({
        index: callback.index,
        name: callback.name,
        ...(callback.path ? { path: callback.path } : {}),
        ...(callback.containerAccess ? { containerAccess: callback.containerAccess } : {}),
        cardinality: callback.cardinality,
        timing: callback.timing,
        completion: callback.completion,
        ...(callback.schedulingSource ? { schedulingSource: callback.schedulingSource } : {}),
        ...(callback.schedulingDelay !== undefined ? { schedulingDelay: callback.schedulingDelay } : {}),
        ...(callback.effectBound ? { effectBound: callback.effectBound } : {}),
      })) } : {}),
    } } : {}),
    ...(resourceSummary?.operations.length || resourceReturnMembers.length ? { resource: {
      evidence: "trusted" as const, operations: resourceSummary?.operations.map((operation) => ({ ...operation })) ?? [],
      ...(resourceReturnMembers.length ? { returnMembers: resourceReturnMembers.map((member) => ({
        key: member.key, operations: member.operations.map((operation) => ({ ...operation })),
      })) } : {}),
    } } : {}),
  };
}

export function createContractSummaryBundle(options: CreateContractSummaryBundleOptions): ContractSummaryBundleV1 {
  if (!options.packageName || !options.packageVersion) throw new Error("contract summary requires package name and version");
  const moduleSpecifier = packageModuleSpecifier(options.packageName, options.moduleSpecifier);
  const source = checkedSource(options);
  const effectAnalysis = analyzeProgramEffects(options.program, {
    requireAnnotations: false, builtinRegistry: options.builtinRegistry,
  });
  const effectSummaries = effectAnalysis.summaries;
  const callableSummaries = analyzeCallableSummaries(options.program, effectAnalysis, options.builtinRegistry).summaries;
  const resourceSummaries = analyzeResourceCallableSummaries(options.program);
  if (resourceSummaries.diagnostics.length > 0) throw new Error(`contract summary has invalid resource annotations: ${resourceSummaries.diagnostics.map(({ message }) => message).join("; ")}`);
  const checker = options.program.getTypeChecker();
  const exports = exportedCallables(source, checker).flatMap((exported) => {
    const node = exported.node;
    const implementationSource = node.getSourceFile();
    const callable = callableSummaries.find((summary) => summary.fileName === implementationSource.fileName
      && summary.span.start === node.getStart(implementationSource) && summary.span.end === node.getEnd());
    const resourceReturnMembers = callable?.returnMembers?.flatMap((member) => {
      const resource = resourceSummaries.summaries.find((summary) => summary.id === member.declarationId);
      return resource?.operations.length ? [{ key: member.key, operations: resource.operations }] : [];
    }) ?? [];
    return [describeExport(options.program, source, exported, moduleSpecifier, options.artifacts,
      effectSummaries.find((summary) => summary.fileName === implementationSource.fileName && summary.span
        && summary.span.start === node.getStart(implementationSource) && summary.span.end === node.getEnd()),
      callable,
      resourceSummaries.summaries.find((summary) => summary.id === `${implementationSource.fileName}:${node.getStart(implementationSource)}`),
      resourceReturnMembers)]
      .filter((item): item is ContractSummaryExportV1 => item !== undefined);
  });
  if (exports.length === 0) throw new Error("contract summary has no fully verified exported function contracts");
  const runtimeArtifacts = runtimeArtifactLedger(options.runtimeArtifacts);
  const typescriptEmit = typescriptEmitLedger(options.program, options.typescriptEmit);
  const unsigned: Omit<ContractSummaryBundleV1, "contentDigest"> = {
    schema: "uneffect-contract-summary/v1",
    package: { name: options.packageName, version: options.packageVersion },
    compiler: { typescriptVersion: ts.version, compilerOptionsDigest: compilerOptionsDigest(options.program) },
    producer: { fileName: options.fileName, sourceDigest: sha256(options.source) },
    ...(options.builtinRegistry?.modules?.length
      ? { modules: options.builtinRegistry.modules.map((module) => ({ ...module })) }
      : {}),
    ...(runtimeArtifacts ? { runtimeArtifacts } : {}),
    ...(typescriptEmit ? { typescriptEmit } : {}),
    exports: exports.sort((left, right) => left.symbol.export.localeCompare(right.symbol.export)),
  };
  return { ...unsigned, contentDigest: bundleDigest(unsigned) };
}

export function validateContractSummaryBundle(bundle: ContractSummaryBundleV1, options: ValidateContractSummaryBundleOptions): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  let moduleSpecifier = options.packageName;
  try { moduleSpecifier = packageModuleSpecifier(options.packageName, options.moduleSpecifier); }
  catch (cause) { errors.push(cause instanceof Error ? cause.message : String(cause)); }
  const { contentDigest, ...unsigned } = bundle;
  if (bundle.schema !== "uneffect-contract-summary/v1") errors.push(`unsupported contract summary schema ${bundle.schema}`);
  if (bundleDigest(unsigned) !== contentDigest) errors.push("contract summary content digest does not match its payload");
  if (canonical(bundle.modules ?? []) !== canonical(options.builtinRegistry?.modules ?? [])) {
    errors.push("contract summary semantics-module ledger does not match the validation registry");
  }
  try {
    if (canonical(bundle.runtimeArtifacts ?? []) !== canonical(runtimeArtifactLedger(options.runtimeArtifacts) ?? [])) {
      errors.push("contract summary runtime artifact ledger does not match validation artifacts");
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause));
  }
  try {
    if (canonical(bundle.typescriptEmit) !== canonical(typescriptEmitLedger(options.program, options.typescriptEmit))) {
      errors.push("contract summary TypeScript emit ledger does not match validation emit");
    }
  } catch (cause) {
    errors.push(cause instanceof Error ? cause.message : String(cause));
  }
  if (bundle.package.name !== options.packageName) errors.push(`contract summary package name ${bundle.package.name} does not match ${options.packageName}`);
  if (bundle.package.version !== options.packageVersion) errors.push(`contract summary package version ${bundle.package.version} does not match ${options.packageVersion}`);
  if (bundle.compiler.typescriptVersion !== ts.version) errors.push(`contract summary TypeScript ${bundle.compiler.typescriptVersion} does not match ${ts.version}`);
  if (bundle.compiler.compilerOptionsDigest !== compilerOptionsDigest(options.program)) errors.push("contract summary compiler options digest does not match the consumer Program");
  if (bundle.producer.fileName !== options.fileName) errors.push(`contract summary producer ${bundle.producer.fileName} does not match ${options.fileName}`);
  if (bundle.producer.sourceDigest !== sha256(options.source)) errors.push("contract summary source digest does not match producer source");
  let source: ts.SourceFile | undefined;
  try { source = checkedSource(options); } catch (cause) { errors.push(cause instanceof Error ? cause.message : String(cause)); }
  const effectAnalysis = source ? analyzeProgramEffects(options.program, {
    requireAnnotations: false, builtinRegistry: options.builtinRegistry,
  }) : undefined;
  const effectSummaries = effectAnalysis?.summaries ?? [];
  const callableSummaries = source ? analyzeCallableSummaries(options.program, effectAnalysis, options.builtinRegistry).summaries : [];
  const resourceSummaries = source ? analyzeResourceCallableSummaries(options.program) : { summaries: [], diagnostics: [] };
  for (const diagnostic of resourceSummaries.diagnostics) errors.push(`invalid resource annotation: ${diagnostic.message}`);
  if (source) for (const item of bundle.exports) {
    if (item.symbol.module !== moduleSpecifier) errors.push(`contract summary module ${item.symbol.module} does not match ${moduleSpecifier}`);
    const checker = options.program.getTypeChecker();
    const exported = exportedCallables(source, checker).find(({ node, exportName, memberPath }) =>
      exportName === item.symbol.export
      && canonical(memberPath) === canonical(item.symbol.path)
      && node.getSourceFile().fileName === (item.implementation?.fileName ?? source.fileName)
      && node.getStart(node.getSourceFile()) === item.declarationSpan.start && node.getEnd() === item.declarationSpan.end);
    if (!exported) { errors.push(`contract summary export ${item.symbol.export} does not match a direct exported callable declaration`); continue; }
    const declaration = exported.node;
    const implementationSource = declaration.getSourceFile();
    if (item.implementation && item.implementation.sourceDigest !== sha256(implementationSource.text)) {
      errors.push(`contract summary implementation source digest for ${item.symbol.export} does not match Program source`);
    }
    if (!item.implementation && implementationSource.fileName !== source.fileName) {
      errors.push(`contract summary export ${item.symbol.export} is missing cross-file implementation evidence`);
    }
    const declarationText = implementationSource.text.slice(item.declarationSpan.start, item.declarationSpan.end);
    if (sha256(declarationText) !== item.declarationDigest) errors.push(`contract summary declaration digest for ${item.symbol.export} does not match source`);
    const signatures = publicSignatures(options.program, declaration);
    const signatureText = signatures[0]?.signature;
    if (!signatureText || signatureText !== item.signature || sha256(signatureText) !== item.signatureDigest
      || signatures[0]?.genericArity !== item.genericArity
      || canonical(signatures.length > 1 ? signatures : undefined) !== canonical(item.overloads)) {
      errors.push(`contract summary signature for ${item.symbol.export} does not match TypeChecker`);
    }
    const leading = implementationSource.text.slice(exported.owner.getFullStart(), exported.owner.getStart(implementationSource));
    const declaresEffect = extractAnnotations(leading, "effect").length > 0;
    const callable = callableSummaries.find((summary) => summary.fileName === implementationSource.fileName
      && summary.span.start === declaration.getStart(implementationSource) && summary.span.end === declaration.getEnd());
    const resource = resourceSummaries.summaries.find((summary) => summary.id === `${implementationSource.fileName}:${declaration.getStart(implementationSource)}`);
    const resourceReturnMembers = callable?.returnMembers?.flatMap((member) => {
      const memberResource = resourceSummaries.summaries.find((summary) => summary.id === member.declarationId);
      return memberResource?.operations.length ? [{ key: member.key, operations: memberResource.operations }] : [];
    }) ?? [];
    const expectedResource = resource?.operations.length || resourceReturnMembers.length ? {
      evidence: "trusted" as const, operations: resource?.operations ?? [],
      ...(resourceReturnMembers.length ? { returnMembers: resourceReturnMembers } : {}),
    } : undefined;
    if (canonical(expectedResource) !== canonical(item.resource)) errors.push(`contract summary resource payload for ${item.symbol.export} does not match producer declaration`);
    if (declaresEffect !== Boolean(item.effect)) {
      errors.push(`contract summary Effect payload for ${item.symbol.export} does not match its declaration`);
    } else if (item.effect) {
      const actual = effectSummaries.find((summary) => summary.fileName === implementationSource.fileName && summary.span
        && summary.span.start === declaration.getStart(implementationSource) && summary.span.end === declaration.getEnd());
      const callableFallback = callable && callable.evidence !== "unknown"
        && callable.unknownReasons.length === 0 && callable.callbackParameters.length > 0;
      const effects = (actual?.evidence === "verified" ? actual.effects : callableFallback ? callable.effects : undefined)
        ?.map(formatEffect).sort();
      const parameters = summaryParameterNames(declaration);
      const rejects = callable?.rejects.length ? [...callable.rejects].sort() : undefined;
      const returnCallable = callable?.returnCallable ? {
        effects: callable.returnCallable.effects.map(formatEffect).sort(),
        ...(callable.returnCallable.rejects.length ? { rejects: [...callable.returnCallable.rejects].sort() } : {}),
        evidence: callable.returnCallable.evidence,
      } : undefined;
      const returnMembers = callable?.returnMembers?.length ? callable.returnMembers.map((member) => ({
        key: member.key, effects: member.effects.map(formatEffect).sort(),
        parameters: [...member.parameters],
        ...(member.returnsReceiver ? { returnsReceiver: true } : {}),
        ...(member.callbackParameters.length ? { callbacks: member.callbackParameters.map((callback) => ({
          index: callback.index, name: callback.name,
          ...(callback.path ? { path: callback.path } : {}),
          ...(callback.containerAccess ? { containerAccess: callback.containerAccess } : {}),
          cardinality: callback.cardinality, timing: callback.timing, completion: callback.completion,
          ...(callback.schedulingSource ? { schedulingSource: callback.schedulingSource } : {}),
          ...(callback.schedulingDelay !== undefined ? { schedulingDelay: callback.schedulingDelay } : {}),
          ...(callback.effectBound ? { effectBound: callback.effectBound } : {}),
        })) } : {}),
        ...(member.rejects.length ? { rejects: [...member.rejects].sort() } : {}), evidence: member.evidence,
      })) : undefined;
      const callbacks = callable?.callbackParameters.length ? callable.callbackParameters.map((callback) => ({
        index: callback.index, name: callback.name,
        ...(callback.path ? { path: callback.path } : {}),
        ...(callback.containerAccess ? { containerAccess: callback.containerAccess } : {}),
        cardinality: callback.cardinality, timing: callback.timing, completion: callback.completion,
        ...(callback.schedulingSource ? { schedulingSource: callback.schedulingSource } : {}),
        ...(callback.schedulingDelay !== undefined ? { schedulingDelay: callback.schedulingDelay } : {}),
        ...(callback.effectBound ? { effectBound: callback.effectBound } : {}),
      })) : undefined;
      if (!effects || canonical(effects) !== canonical(item.effect.effects)
        || canonical(parameters) !== canonical(item.effect.parameters)
        || canonical(rejects) !== canonical(item.effect.rejects)
        || canonical(returnCallable) !== canonical(item.effect.returnCallable)
        || canonical(returnMembers) !== canonical(item.effect.returnMembers)
        || canonical(callbacks) !== canonical(item.effect.callbacks)) {
        errors.push(`contract summary Effect payload for ${item.symbol.export} does not match verified producer evidence`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
