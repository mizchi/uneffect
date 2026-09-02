import ts from "typescript";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachContractEffectBoundaries, reconcileContractArtifacts, verifyContractObligations, type ContractDiagnostic, type VerificationArtifact } from "./contracts.js";
import { bindContractSummaryBundleToProgram, boundContractSummaryEffectContracts, boundContractSummaryResourceContracts, type ContractSummaryBundleV1 } from "./contract-summary.js";
import { instrumentRuntimeAssertions, type InstrumentDiagnostic } from "./instrument.js";
import { analyzeOwnership, type OwnershipDiagnostic } from "./ownership.js";
import { analyzeCallableSummaries } from "./callable-summary.js";
import { verifyTypedArraySafetyInProgram, type TypedArrayDiagnostic, type TypedArrayProgramSafetyResult } from "./typed-array-safety.js";
import { resolveRegionIdentity } from "./region-alias.js";
import { collectAssumptionLedger, mergeAssumptionLedger, type AssumptionEntry, type AssumptionLedger, type AssumptionPolicy, type AssumptionPolicyDiagnostic } from "./assumptions.js";
import { generateTemporalModel } from "./temporal-model.js";
import { resolveTemporalDslLink } from "./temporal-dsl.js";
import { prepareCapabilityDslLinks } from "./capability-dsl.js";
import { prepareContractDslLinks } from "./contract-dsl.js";
import { extractLocatedAnnotations } from "./annotations.js";
import { resolveRefinementDslLink } from "./refinement-dsl.js";
import type { RefinementBindingManifest } from "./refinement-bindings.js";
import { hasProjectCallableAliasContracts, instrumentContractPredicates, relocateProjectCallableAliasContracts } from "./contract-runtime.js";
import { analyzeProgramEffects, type EffectAnalysisResult, type EffectDiagnostic, type ExternalFunctionEffectContract, type ExternalModuleEffectContract } from "./effects.js";
import { fromTypeScriptDiagnostic, type AsyncIteratorCheckerDiagnostic, type ResourceCheckerDiagnostic, type TypeScriptCheckerDiagnostic } from "./diagnostics.js";
import { collectIteratorChecks, type IteratorCheckEvidence } from "./iterator-check.js";
import { analyzeResourceCallableSummaries, analyzeResourceLifecyclesInSource, type ResourceLifecycleEvidence } from "./resource-callable-typescript.js";
import {
  assessProjectVerification,
  PROJECT_ASSURANCE_SELECTED_FILES_EXCLUSION,
  PROJECT_ASSURANCE_SINGLE_DOMAIN_EXCLUSION,
  type ProjectAssuranceAssessment,
} from "./project-assurance.js";
import type { BuiltinContractRegistry } from "./builtin-contracts.js";
import type { AssumptionRegistry } from "./assumption-registry.js";
import { analyzeModuleInitializationOrder, type ModuleInitializationOrder } from "./module-initialization.js";
import { loadTypeScriptWorkspace, type TypeScriptProject, type TypeScriptProjectProvenance, type TypeScriptWorkspaceBlocker } from "./typescript-project.js";
import { composeWorkspaceEffects, inspectDeclarationOutputs, type CompletedEffectProject, type WorkspaceEffectCompositionBlocker, type WorkspaceEffectLink } from "./workspace-effects.js";
import {
  analyzeProjectRefinements, composeWorkspaceRefinements,
  type CompletedRefinementProject, type WorkspaceRefinementCompositionBlocker, type WorkspaceRefinementLink,
} from "./workspace-refinements.js";
import { inspectBuildOutputs, mergeBuildOutputIntegrity, type BuildOutputIntegrity } from "./build-output-integrity.js";
import type { Z3ExecutionOptions } from "./z3.js";
import {
  composeWorkspaceModuleInitialization,
  type CompletedModuleInitializationProject,
  type WorkspaceModuleInitializationComposition,
} from "./workspace-module-initialization.js";
import {
  validateDeclarationTransformManifest,
  type DeclarationTransformManifest,
} from "./declaration-transforms.js";

export interface VerifyUneffectProjectBaseOptions {
  runtimeAssertions?: "off" | "fallback";
  temporalRuntime?: "web" | "node";
  nodeTopLevelMode?: "commonjs" | "esm";
  temporalRoot?: string;
  assumptionPolicy?: AssumptionPolicy;
  /** Caller-owned review records referenced by source-level trust IDs. */
  assumptionRegistry?: AssumptionRegistry;
  /** Caller-owned, versioned semantic contracts. Defaults to Uneffect's registry. */
  builtinRegistry?: BuiltinContractRegistry;
  /** Opt in to source-mapped ESM initialization-order evidence for one entry module. */
  moduleInitializationEntry?: string;
  /** Apply one solver policy to every Z3-backed project verification domain. */
  z3?: Z3ExecutionOptions;
  /** Producer-verified package contracts to bind to installed declarations. */
  contractSummaryBundles?: readonly ContractSummaryBundleV1[];
}

export interface VerifyUneffectProjectOptions extends VerifyUneffectProjectBaseOptions {
  files: Record<string, string>;
  projectFile?: never;
}

export interface VerifyUneffectWorkspaceOptions extends VerifyUneffectProjectBaseOptions {
  projectFile: string;
  files?: never;
  /** Require SolutionBuilder freshness, or exact same-compiler runtime/declaration output bytes. */
  buildArtifacts?: "ignore" | "require-fresh" | "require-exact";
  /** Bind generated TypeScript to exact spans in non-TypeScript source files. */
  declarationTransforms?: DeclarationTransformManifest;
}

export interface ProjectVerificationObligation extends VerificationArtifact {
  backend: "z3";
  result: VerificationArtifact["status"];
}

export interface VerifyUneffectProjectResult {
  obligations: ProjectVerificationObligation[];
  diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic | TypedArrayDiagnostic | ProjectOwnershipDiagnostic | AsyncIteratorCheckerDiagnostic | ResourceCheckerDiagnostic | AssumptionPolicyDiagnostic | EffectDiagnostic | TypeScriptCheckerDiagnostic>;
  emittedFiles: Record<string, string>;
  typedArrays: TypedArrayProgramSafetyResult;
  ownership: { diagnostics: ProjectOwnershipDiagnostic[] };
  asyncIterators: IteratorCheckEvidence[];
  resourceProtocols: ResourceLifecycleEvidence[];
  assumptions: AssumptionLedger;
  effects: EffectAnalysisResult;
  refinements: ProjectRefinementVerification;
  assurance: ProjectAssuranceAssessment;
  temporal?: ProjectTemporalVerification;
  moduleInitialization?: ModuleInitializationOrder;
}

export interface ProjectWorkspaceVerificationBlocker {
  kind: string;
  classification: "unknown" | "violation";
  projectFile: string;
  message: string;
  reference?: string;
  subject?: string;
}

export interface ProjectWorkspaceAssurance {
  status: "verified" | "assumed" | "unknown" | "violated";
  passed: boolean;
  assumptions: number;
  blockers: ProjectWorkspaceVerificationBlocker[];
  claims: readonly string[];
  exclusions: readonly string[];
}

export interface ProjectWorkspaceVerificationDomain {
  project: TypeScriptProjectProvenance;
  rootFiles: string[];
  verification: VerifyUneffectProjectResult;
}

export interface VerifyUneffectWorkspaceResult {
  schema: "uneffect-project-workspace/v1";
  rootProjectFile: string;
  references: Array<{ from: string; to: string }>;
  buildOrder: string[];
  buildArtifacts: { status: "fresh" | "stale" | "unknown"; observations: Array<{ code: number; message: string }> };
  outputIntegrity: BuildOutputIntegrity;
  configs: Array<TypeScriptProjectProvenance & { rootFiles: string[] }>;
  projects: ProjectWorkspaceVerificationDomain[];
  effectComposition: { status: "not-applicable" | "verified" | "unknown"; links: WorkspaceEffectLink[]; blockers: WorkspaceEffectCompositionBlocker[] };
  refinementComposition: { status: "not-applicable" | "verified" | "unknown"; links: WorkspaceRefinementLink[]; blockers: WorkspaceRefinementCompositionBlocker[] };
  moduleInitializationComposition?: WorkspaceModuleInitializationComposition;
  blockers: ProjectWorkspaceVerificationBlocker[];
  assurance: ProjectWorkspaceAssurance;
}

export interface ProjectOwnershipDiagnostic extends OwnershipDiagnostic {
  fileName: string;
  kind: "ownership";
}

export interface ProjectTemporalProperty {
  fileName: string;
  name: string;
  result: "verified" | "counterexample" | "error";
  output: string;
}

export interface ProjectTemporalModel {
  fileName: string;
  kind: "user-temporal" | "web-event-loop" | "node-event-loop" | "promise-chains" | "promise-ownership" | "abortable-fetch" | "resource-lifecycle" | "resource-host-lifecycle";
  module?: string;
  owner?: string;
  quint: string;
}

export interface ProjectTemporalVerification {
  sourceLanguage: "uneffect-ts";
  backend: "quint";
  models: ProjectTemporalModel[];
  properties: ProjectTemporalProperty[];
}

export interface ProjectRefinementLinkEvidence {
  schema: "uneffect-refinement-link/v1";
  implementationFile: string;
  specificationFile: string;
  reference: string;
  attachmentSpan: { start: number; end: number };
  implementationDigest: string;
  specificationDigest: string;
  typescriptVersion: string;
}

export interface ProjectRefinementVerification {
  manifests: RefinementBindingManifest[];
  links: ProjectRefinementLinkEvidence[];
}

function sourceDigest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function javascriptPath(fileName: string): string {
  return fileName.replace(/\.(?:mts|cts|tsx|ts)$/, ".js");
}

function inMemoryProgram(
  files: Readonly<Record<string, string>>,
  configuredCompilerOptions?: ts.CompilerOptions,
  projectReferences?: readonly ts.ProjectReference[],
): ts.Program {
  const compilerOptions: ts.CompilerOptions = configuredCompilerOptions ?? {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    types: ["node"],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const selfPackageEntry = [join(moduleDirectory, "index.ts"), join(moduleDirectory, "index.d.ts")]
    .find((candidate) => ts.sys.fileExists(candidate));
  const selfSpecEntry = [join(moduleDirectory, "spec.ts"), join(moduleDirectory, "spec.d.ts")]
    .find((candidate) => ts.sys.fileExists(candidate));
  const virtualDirectories = new Set(Object.keys(files).flatMap((fileName) => {
    const directories: string[] = [];
    for (let current = dirname(fileName); current !== dirname(current); current = dirname(current)) directories.push(current);
    return directories;
  }));
  host.fileExists = (fileName) => Object.hasOwn(files, fileName) || ts.sys.fileExists(fileName);
  host.directoryExists = (directory) => virtualDirectories.has(directory) || ts.sys.directoryExists(directory);
  host.readFile = (fileName) => files[fileName] ?? ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, fresh) => Object.hasOwn(files, fileName)
    ? ts.createSourceFile(fileName, files[fileName]!, languageVersion, true, ts.ScriptKind.TS)
    : originalGetSourceFile(fileName, languageVersion, onError, fresh);
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    if (moduleName === "@mizchi/uneffect" && selfPackageEntry) return {
      resolvedFileName: selfPackageEntry,
      extension: selfPackageEntry.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
      isExternalLibraryImport: true,
    };
    if (moduleName === "@mizchi/uneffect/spec" && selfSpecEntry) return {
      resolvedFileName: selfSpecEntry,
      extension: selfSpecEntry.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
      isExternalLibraryImport: true,
    };
    if ((moduleName.startsWith("./") || moduleName.startsWith("../")) && moduleName.endsWith(".js")) {
      const virtualTypeScript = join(dirname(containingFile), moduleName.slice(0, -3) + ".ts");
      const selected = Object.keys(files).find((fileName) => resolve(fileName) === resolve(virtualTypeScript));
      if (selected) return { resolvedFileName: selected, extension: ts.Extension.Ts };
    }
    return ts.resolveModuleName(moduleName, containingFile, compilerOptions, host).resolvedModule;
  });
  return ts.createProgram({ rootNames: Object.keys(files), options: compilerOptions, host, projectReferences });
}

function verifyQuintInvariant(fileName: string, program: string, invariant: string, main?: string, displayName = invariant): ProjectTemporalProperty {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-project-quint-"));
  const path = join(directory, "model.qnt");
  try {
    writeFileSync(path, program);
    const verification = spawnSync("pnpm", ["exec", "quint", "run", path, ...(main ? [`--main=${main}`] : []), `--invariant=${invariant}`, "--max-steps=12", "--max-samples=500", "--seed=0x756e656666656374", "--verbosity=1"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = `${verification.stdout ?? ""}${verification.stderr ?? ""}`;
    const result = verification.error ? "error" : verification.status === 0 ? "verified" : /violation|counterexample/i.test(output) ? "counterexample" : "error";
    return { fileName, name: displayName, result, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface ProjectVerificationCompilerContext {
  project: TypeScriptProject;
  program?: ts.Program;
  externalFunctionEffects?: ReadonlyMap<string, ExternalFunctionEffectContract>;
  externalModuleEffects?: ReadonlyMap<string, ExternalModuleEffectContract>;
}

/** Correlate ownership invalidation with typed-array backing evidence by region identity. */
export function invalidateTransferredTypedArrayEvidence(
  program: ts.Program,
  files: Readonly<Record<string, string>>,
  typedArrays: TypedArrayProgramSafetyResult,
  ownershipDiagnostics: readonly ProjectOwnershipDiagnostic[],
): void {
  const checker = program.getTypeChecker();
  for (const ownership of ownershipDiagnostics) {
    if (ownership.operation !== "read" || !["detached", "transferred", "locked", "unknown"].includes(ownership.state)) continue;
    const result = typedArrays.files[ownership.fileName];
    const source = files[ownership.fileName];
    if (!result || source === undefined) continue;
    const sourceFile = program.getSourceFile(ownership.fileName);
    for (const obligation of result.obligations) {
      if (obligation.kind !== "dataview-backing-bounds" || obligation.span.end < ownership.span.end) continue;
      let sameRegion = source.slice(obligation.span.start, obligation.span.end).includes(ownership.resource);
      if (!sameRegion && ownership.regionId && sourceFile) {
        let backing: ts.Expression | undefined;
        const findBacking = (node: ts.Node): void => {
          if (backing || node.getStart(sourceFile) > obligation.span.start || node.getEnd() < obligation.span.end) return;
          if (ts.isNewExpression(node) && node.arguments?.[0]
            && node.getStart(sourceFile) <= obligation.span.start && node.getEnd() >= obligation.span.end) backing = node.arguments[0];
          ts.forEachChild(node, findBacking);
        };
        findBacking(sourceFile);
        const identity = backing ? resolveRegionIdentity(checker, backing) : undefined;
        sameRegion = identity?.status === "resolved" && identity.regionId === ownership.regionId;
      }
      if (!sameRegion) continue;
      obligation.result = ownership.state === "unknown" ? "unknown" : "counterexample";
      if (!result.diagnostics.some((item) => item.kind === obligation.kind && item.span.start === obligation.span.start)) result.diagnostics.push({
        fileName: ownership.fileName,
        functionName: obligation.functionName,
        kind: obligation.kind,
        span: obligation.span,
        message: ownership.state === "unknown"
          ? `fixed-buffer evidence for ${ownership.resource} is unknown after a conditional ownership transition`
          : `fixed-buffer evidence for ${ownership.resource} was invalidated after it became ${ownership.state}`,
      });
    }
  }
}

async function verifyUneffectProjectFiles(
  options: VerifyUneffectProjectOptions,
  compilerContext?: ProjectVerificationCompilerContext,
): Promise<VerifyUneffectProjectResult> {
  const obligations: ProjectVerificationObligation[] = [];
  const pendingContractObligations: ProjectVerificationObligation[] = [];
  const diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic | TypedArrayDiagnostic | ProjectOwnershipDiagnostic | AssumptionPolicyDiagnostic | EffectDiagnostic | TypeScriptCheckerDiagnostic | AsyncIteratorCheckerDiagnostic | ResourceCheckerDiagnostic> = [];
  const emittedFiles: Record<string, string> = {};
  const temporalModels: ProjectTemporalModel[] = [];
  const temporalProperties: ProjectTemporalProperty[] = [];
  const program = compilerContext?.program ?? inMemoryProgram(options.files, compilerContext?.project.compilerOptions, compilerContext?.project.projectReferences);
  const contractSummaryBindings = (options.contractSummaryBundles ?? []).map((bundle) =>
    bindContractSummaryBundleToProgram(bundle, program));
  const packageEffects = boundContractSummaryEffectContracts(contractSummaryBindings);
  const contractSummaryAssumptions: AssumptionEntry[] = contractSummaryBindings.flatMap((binding) => binding.exports.flatMap((item) =>
    item.callSites.map((call) => ({
      id: `package-contract:${binding.package.name}@${binding.package.version}:${call.fileName}:${call.span.start}`,
      evidence: "trusted" as const,
      domain: "package-contract" as const,
      reason: "persisted producer contract authority is not authenticated by declaration binding",
      dependency: { module: binding.package.name, packageVersion: binding.package.version },
      scope: { fileName: call.fileName, functionName: item.exportName, span: call.span },
    }))));
  const refinementManifests: RefinementBindingManifest[] = [];
  const refinementLinks: ProjectRefinementLinkEvidence[] = [];
  for (const [fileName, source] of Object.entries(options.files)) {
    const attachments = extractLocatedAnnotations(source, "refinement_from");
    if (attachments.length === 0) continue;
    const manifest = resolveRefinementDslLink(fileName, source, options.files, program);
    const attachment = attachments[0]!, quoted = /^(?:"([^"]+)"|'([^']+)')$/.exec(attachment.value)!;
    const reference = quoted[1] ?? quoted[2]!, hash = reference.lastIndexOf("#"), requested = reference.slice(0, hash);
    const specificationFile = posix.normalize(posix.join(posix.dirname(fileName), requested));
    refinementManifests.push(manifest);
    refinementLinks.push({
      schema: "uneffect-refinement-link/v1", implementationFile: fileName, specificationFile, reference,
      attachmentSpan: attachment.span, implementationDigest: sourceDigest(source),
      specificationDigest: sourceDigest(options.files[specificationFile]!), typescriptVersion: ts.version,
    });
  }
  const typedArrays = await verifyTypedArraySafetyInProgram(options.files, options.z3, options.assumptionRegistry);
  const preparedEffects = prepareCapabilityDslLinks(options.files, program);
  // `.uneffect.ts` modules are statically parsed and TypeChecked specification
  // inputs. They are never runtime entrypoints and must not contribute module
  // initialization effects merely because a tsconfig include pattern selects
  // them alongside implementation sources.
  const effectFiles = Object.fromEntries(Object.entries(preparedEffects.files)
    .filter(([fileName]) => !fileName.endsWith(".uneffect.ts")));
  const preparedContracts = prepareContractDslLinks(options.files, program);
  const contractFiles = preparedContracts.files;
  const needsAliasRelocation = options.runtimeAssertions === "fallback" && hasProjectCallableAliasContracts(contractFiles);
  const contractProgram = needsAliasRelocation && Object.entries(contractFiles).some(([name, source]) => source !== options.files[name])
    ? inMemoryProgram(contractFiles, { ...program.getCompilerOptions(), strict: true, noImplicitReturns: true, allowUnreachableCode: true }, compilerContext?.project.projectReferences)
    : program;
  const relocatedContracts = needsAliasRelocation ? relocateProjectCallableAliasContracts(contractFiles, contractProgram) : { files: contractFiles, diagnostics: [] };
  const runtimeContractFiles = relocatedContracts.files;
  diagnostics.push(...relocatedContracts.diagnostics);
  const effectProgram = Object.keys(effectFiles).length !== Object.keys(options.files).length
    || Object.entries(effectFiles).some(([name, source]) => source !== options.files[name])
    ? inMemoryProgram(effectFiles, compilerContext?.project.compilerOptions, compilerContext?.project.projectReferences)
    : program;
  const typescriptDiagnostics = Object.keys(options.files).flatMap((fileName) => {
    const source = program.getSourceFile(fileName);
    return source ? [
      ...program.getSyntacticDiagnostics(source).map((item) => fromTypeScriptDiagnostic(item, "syntax")),
      ...program.getSemanticDiagnostics(source).map((item) => fromTypeScriptDiagnostic(item, "semantic")),
    ] : [];
  });
  typescriptDiagnostics.push(...program.getOptionsDiagnostics().map((item) => fromTypeScriptDiagnostic(item, "options")));
  diagnostics.push(...typescriptDiagnostics);
  const invalidSources = new Set(typescriptDiagnostics
    .filter((item) => item.severity === "error" && item.fileName !== "<typescript-options>")
    .map((item) => item.fileName));
  if (typescriptDiagnostics.some((item) => item.kind === "options" && item.severity === "error")) {
    for (const fileName of Object.keys(options.files)) invalidSources.add(fileName);
  }
  for (const binding of contractSummaryBindings) if (binding.status === "unknown") {
    const fileName = Object.keys(options.files)[0] ?? "<project>";
    for (const message of binding.blockers) {
      const obligationId = `contract_summary_${createHash("sha256").update(`${binding.package.name}:${message}`).digest("hex").slice(0, 20)}`;
      const artifact: ProjectVerificationObligation = {
        obligationId, status: "unknown", evidence: "unknown", backend: "z3", result: "unknown",
        source: { fileName, span: { start: 0, end: 0 } }, message,
      };
      pendingContractObligations.push(artifact);
      diagnostics.push({
        fileName, functionName: "<package-contract>", clause: "unsupported", line: 1,
        message, obligationId, artifact,
        notes: [{ label: "because", detail: "the supplied package contract summary did not authenticate against the declaration selected by this TypeScript Program" }],
      });
    }
  }
  const analyzedEffects = analyzeProgramEffects(effectProgram, {
    requireAnnotations: false, builtinRegistry: options.builtinRegistry,
    externalFunctionEffects: new Map([...(compilerContext?.externalFunctionEffects ?? []), ...packageEffects]),
    externalModuleEffects: compilerContext?.externalModuleEffects,
    effectSchemas: preparedEffects.schemas,
  });
  const effects = {
    summaries: analyzedEffects.summaries.filter((summary) => !summary.fileName?.endsWith(".uneffect.ts")),
    diagnostics: analyzedEffects.diagnostics.filter((diagnostic) => !diagnostic.fileName.endsWith(".uneffect.ts")),
  };
  diagnostics.push(...effects.diagnostics);
  const callableSummaries = analyzeCallableSummaries(program, effectProgram === program ? analyzedEffects : undefined).summaries;
  const ownershipDiagnostics: ProjectOwnershipDiagnostic[] = [];
  const asyncIterators: IteratorCheckEvidence[] = [];
  const resourceProtocols: ResourceLifecycleEvidence[] = [];
  const resourceAssumptions: AssumptionEntry[] = [];
  const localResourceCallableAnalysis = analyzeResourceCallableSummaries(program);
  const resourceCallableAnalysis = {
    summaries: [...localResourceCallableAnalysis.summaries, ...boundContractSummaryResourceContracts(contractSummaryBindings)],
    diagnostics: localResourceCallableAnalysis.diagnostics,
  };
  const iteratorAssumptions: AssumptionEntry[] = [];
  for (const fileName of Object.keys(options.files)) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    ownershipDiagnostics.push(...analyzeOwnership(program, sourceFile, callableSummaries).map((diagnostic) => ({ ...diagnostic, fileName, kind: "ownership" as const })));
    if (fileName.endsWith(".uneffect.ts")) continue;
    const iterator = collectIteratorChecks(program, sourceFile, "strict", !invalidSources.has(fileName));
    asyncIterators.push(...iterator.evidence);
    diagnostics.push(...iterator.diagnostics);
    iteratorAssumptions.push(...iterator.assumptions);
    const lifecycle = analyzeResourceLifecyclesInSource(program, sourceFile, resourceCallableAnalysis, !invalidSources.has(fileName));
    resourceProtocols.push(...lifecycle.evidence);
    resourceAssumptions.push(...lifecycle.evidence.filter((item) => item.evidence === "trusted").map((item) => ({
      id: `resource-callable:${item.fileName}:${item.span.start}:${item.resource}`,
      evidence: "trusted" as const, domain: "resource-callable" as const,
      reason: "trusted resource callable contract used by general lifecycle analysis", owner: "source declaration",
      scope: { fileName: item.fileName, functionName: item.owner, span: item.span },
    })));
    diagnostics.push(...lifecycle.diagnostics.map((diagnostic): ResourceCheckerDiagnostic => ({
      domain: "resource", kind: diagnostic.kind, severity: "error", fileName: diagnostic.fileName,
      line: sourceFile.getLineAndCharacterOfPosition(diagnostic.span.start).line + 1,
      functionName: diagnostic.functionName, message: diagnostic.message,
      notes: [{ label: "resource", detail: diagnostic.resource }, { label: "state", detail: diagnostic.state }],
    })));
  }
  invalidateTransferredTypedArrayEvidence(program, options.files, typedArrays, ownershipDiagnostics);
  for (const [fileName, result] of Object.entries(typedArrays.files)) if (invalidSources.has(fileName)) {
    for (const obligation of result.obligations) obligation.result = "unknown";
  }
  typedArrays.obligations = Object.values(typedArrays.files).flatMap((result) => result.obligations);
  typedArrays.diagnostics = Object.values(typedArrays.files).flatMap((result) => result.diagnostics);
  diagnostics.push(...typedArrays.diagnostics, ...ownershipDiagnostics);
  const baseAssumptions = collectAssumptionLedger(effectProgram, effectFiles, typedArrays, options.assumptionPolicy, options.builtinRegistry, options.assumptionRegistry);
  const assumptions = mergeAssumptionLedger(program, baseAssumptions.ledger, [...iteratorAssumptions, ...resourceAssumptions, ...contractSummaryAssumptions], options.assumptionPolicy);
  diagnostics.push(...assumptions.diagnostics);
  const runtimeInputs = Object.fromEntries(Object.entries(options.files).map(([fileName, source]) => {
    const contractSource = runtimeContractFiles[fileName] ?? source;
    return [fileName, options.runtimeAssertions === "fallback" ? instrumentRuntimeAssertions(fileName, contractSource) : { code: source, diagnostics: [] }];
  }));
  const runtimeProgram = options.runtimeAssertions === "fallback"
    ? inMemoryProgram(Object.fromEntries(Object.entries(runtimeInputs).map(([fileName, result]) => [fileName, result.code])), {
      ...program.getCompilerOptions(), strict: true, noImplicitReturns: true, allowUnreachableCode: true,
    }, compilerContext?.project.projectReferences)
    : undefined;
  for (const [fileName, source] of Object.entries(options.files)) {
    if (fileName.endsWith(".uneffect.ts")) continue;
    const contractSource = contractFiles[fileName] ?? source;
    const verification = await verifyContractObligations(fileName, contractSource, options.z3, program, {
      externalContractBindings: contractSummaryBindings.flatMap((binding) => binding.exports),
    });
    const effectBoundArtifacts = attachContractEffectBoundaries(verification.artifacts, effects.summaries);
    pendingContractObligations.push(...effectBoundArtifacts.map((artifact) => invalidSources.has(fileName)
      ? { ...artifact, status: "unknown" as const, evidence: "unknown" as const, backend: "z3" as const, result: "unknown" as const, message: "TypeScript errors prevent proof-grade contract evidence for this source" }
      : { ...artifact, backend: "z3" as const, result: artifact.status }));
    diagnostics.push(...verification.diagnostics);
    const parameterInstrumented = runtimeInputs[fileName]!;
    const predicateInstrumented = options.runtimeAssertions === "fallback" ? instrumentContractPredicates(fileName, parameterInstrumented.code, {
      program: runtimeProgram, clauseProvenance: preparedContracts.provenance[fileName],
    }) : parameterInstrumented;
    const instrumented = { code: predicateInstrumented.code, diagnostics: [...parameterInstrumented.diagnostics, ...predicateInstrumented.diagnostics] };
    diagnostics.push(...instrumented.diagnostics);
    emittedFiles[javascriptPath(fileName)] = ts.transpileModule(instrumented.code, {
      fileName,
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText;
    if (options.temporalRuntime === "web" || options.temporalRuntime === "node") {
      const linkedTemporal = resolveTemporalDslLink(fileName, source, options.files, program);
      const model = generateTemporalModel({
        fileName,
        source,
        runtime: options.temporalRuntime,
        root: options.temporalRoot ?? "main",
        nodeTopLevelMode: options.nodeTopLevelMode ?? "commonjs",
        ...(linkedTemporal ? { linkedTemporal } : {}),
      });
      for (const projection of model.models) {
        temporalModels.push({ fileName, kind: projection.kind, module: projection.module, owner: projection.owner, quint: projection.quint });
        for (const property of projection.properties) {
          const displayName = projection.owner ? `${projection.owner}.${property}` : property;
          temporalProperties.push(invalidSources.has(fileName)
            ? { fileName, name: displayName, result: "error", output: `TypeScript errors in ${fileName} prevent proof-grade temporal evidence` }
            : verifyQuintInvariant(fileName, projection.quint, property, projection.module, displayName));
        }
      }
    }
  }
  const reconciledContracts = reconcileContractArtifacts(new Map(Object.entries(contractFiles)), pendingContractObligations);
  obligations.push(...reconciledContracts.artifacts.map((artifact) => ({ ...artifact, backend: "z3" as const, result: artifact.status })));
  diagnostics.push(...reconciledContracts.diagnostics);
  const temporal = options.temporalRuntime === "web" || options.temporalRuntime === "node"
    ? { sourceLanguage: "uneffect-ts" as const, backend: "quint" as const, models: temporalModels, properties: temporalProperties }
    : undefined;
  const moduleInitialization = options.moduleInitializationEntry === undefined
    ? undefined : analyzeModuleInitializationOrder(program, options.moduleInitializationEntry);
  const partial = {
    obligations, diagnostics, emittedFiles, typedArrays, ownership: { diagnostics: ownershipDiagnostics }, asyncIterators, resourceProtocols, assumptions: assumptions.ledger, effects,
    refinements: { manifests: refinementManifests, links: refinementLinks },
    ...(temporal ? { temporal } : {}), ...(moduleInitialization ? { moduleInitialization } : {}),
  };
  return { ...partial, assurance: assessProjectVerification(partial, Object.keys(options.files), compilerContext?.project.provenance) };
}

function workspaceBlocker(blocker: TypeScriptWorkspaceBlocker): ProjectWorkspaceVerificationBlocker {
  return {
    kind: blocker.kind, classification: blocker.classification, projectFile: blocker.projectFile, message: blocker.message,
    ...(blocker.reference === undefined ? {} : { reference: blocker.reference }),
  };
}

function workspaceFiles(project: TypeScriptProject): { files: Record<string, string>; blocker?: ProjectWorkspaceVerificationBlocker } {
  const files: Record<string, string> = {};
  for (const fileName of project.fileNames) {
    const source = ts.sys.readFile(fileName);
    if (source === undefined) return { files, blocker: {
      kind: "source-read", classification: "unknown", projectFile: project.projectFile,
      subject: fileName, message: `cannot read selected TypeScript source ${fileName}`,
    } };
    files[fileName] = source;
  }
  return { files };
}

async function verifyUneffectWorkspace(options: VerifyUneffectWorkspaceOptions): Promise<VerifyUneffectWorkspaceResult> {
  const workspace = loadTypeScriptWorkspace(options.projectFile);
  const blockers = workspace.blockers.map(workspaceBlocker);
  const transformValidation = options.declarationTransforms === undefined
    ? undefined : validateDeclarationTransformManifest(options.declarationTransforms);
  if (transformValidation) for (const diagnostic of transformValidation.diagnostics) blockers.push({
    kind: "declaration-transform", classification: "violation", projectFile: workspace.rootProjectFile,
    subject: diagnostic.generatedFile, message: diagnostic.message,
  });
  if (options.buildArtifacts !== undefined && options.buildArtifacts !== "ignore" && workspace.buildArtifacts.status !== "fresh") blockers.push({
    kind: "build-artifact", classification: "unknown", projectFile: workspace.rootProjectFile,
    message: workspace.buildArtifacts.status === "stale"
      ? "TypeScript SolutionBuilder reports stale or missing composite build artifacts"
      : "TypeScript SolutionBuilder did not establish composite build-artifact freshness",
  });
  const projects: ProjectWorkspaceVerificationDomain[] = [];
  const effectLinks: WorkspaceEffectLink[] = [], effectBlockers: WorkspaceEffectCompositionBlocker[] = [];
  const refinementLinks: WorkspaceRefinementLink[] = [], refinementBlockers: WorkspaceRefinementCompositionBlocker[] = [];
  const completed: CompletedEffectProject[] = [];
  const completedRefinements: CompletedRefinementProject[] = [];
  const completedModuleInitialization: CompletedModuleInitializationProject[] = [];
  let moduleInitializationComposition: WorkspaceModuleInitializationComposition | undefined;
  const outputIntegrity: BuildOutputIntegrity = { status: options.buildArtifacts === "require-exact" ? "verified" : "not-checked", outputs: [] };
  const base: VerifyUneffectProjectBaseOptions = {
    ...(options.runtimeAssertions === undefined ? {} : { runtimeAssertions: options.runtimeAssertions }),
    ...(options.temporalRuntime === undefined ? {} : { temporalRuntime: options.temporalRuntime }),
    ...(options.nodeTopLevelMode === undefined ? {} : { nodeTopLevelMode: options.nodeTopLevelMode }),
    ...(options.temporalRoot === undefined ? {} : { temporalRoot: options.temporalRoot }),
    ...(options.assumptionPolicy === undefined ? {} : { assumptionPolicy: options.assumptionPolicy }),
    ...(options.assumptionRegistry === undefined ? {} : { assumptionRegistry: options.assumptionRegistry }),
    ...(options.builtinRegistry === undefined ? {} : { builtinRegistry: options.builtinRegistry }),
    ...(options.contractSummaryBundles === undefined ? {} : { contractSummaryBundles: options.contractSummaryBundles }),
  };
  for (const project of workspace.projects) {
    if (project.fileNames.length === 0) continue;
    const selected = workspaceFiles(project);
    if (selected.blocker) { blockers.push(selected.blocker); continue; }
    const moduleInitializationEntry = options.moduleInitializationEntry === undefined
      ? undefined : resolve(options.moduleInitializationEntry);
    const program = inMemoryProgram(selected.files, project.compilerOptions, project.projectReferences);
    if (options.buildArtifacts === "require-exact") {
      const integrity = inspectBuildOutputs(program, project.projectFile);
      mergeBuildOutputIntegrity(outputIntegrity, integrity);
      if (integrity.status !== "verified") {
        const failed = integrity.outputs.filter((output) => output.status !== "verified");
        if (failed.length === 0) blockers.push({ kind: "build-output", classification: "unknown", projectFile: project.projectFile, message: integrity.message ?? "build output integrity is unknown" });
        for (const output of failed) blockers.push({ kind: "build-output", classification: "unknown", projectFile: project.projectFile, subject: output.fileName, message: output.message ?? `${output.kind} output integrity is unknown` });
      }
    }
    const composition = composeWorkspaceEffects(program, project, completed);
    effectLinks.push(...composition.links);
    effectBlockers.push(...composition.blockers);
    blockers.push(...composition.blockers);
    const refinementComposition = composeWorkspaceRefinements(program, project, completedRefinements);
    refinementLinks.push(...refinementComposition.links);
    refinementBlockers.push(...refinementComposition.blockers);
    blockers.push(...refinementComposition.blockers);
    const verification = await verifyUneffectProjectFiles({
      ...base, files: selected.files,
      // Workspace module-order evidence is composed below so a matched child
      // declaration can discharge only its exact external-import boundary.
    }, { project, program, externalFunctionEffects: composition.contracts, externalModuleEffects: composition.moduleContracts });
    projects.push({ project: project.provenance, rootFiles: project.fileNames, verification });
    const declarationOutputs = inspectDeclarationOutputs(program, options.declarationTransforms && transformValidation
      ? { manifest: options.declarationTransforms, validation: transformValidation } : undefined);
    if (moduleInitializationEntry !== undefined && project.fileNames.includes(moduleInitializationEntry)) {
      moduleInitializationComposition = composeWorkspaceModuleInitialization(
        program, project, completedModuleInitialization, moduleInitializationEntry,
      );
      if (moduleInitializationComposition.evidence !== "verified") for (const unknown of moduleInitializationComposition.unknowns) blockers.push({
        kind: "module-initialization", classification: "unknown", projectFile: unknown.projectFile,
        subject: unknown.fileName, message: `${unknown.kind}: ${unknown.detail}`,
      });
    }
    completed.push({ project, summaries: verification.effects.summaries, declarationOutputs });
    const refinementAnalysis = analyzeProjectRefinements(program, project, refinementComposition.contracts);
    refinementBlockers.push(...refinementAnalysis.blockers);
    blockers.push(...refinementAnalysis.blockers);
    completedRefinements.push({ project, summaries: refinementAnalysis.summaries, declarationOutputs });
    completedModuleInitialization.push({ project, program, declarationOutputs });
    for (const blocker of verification.assurance.blockers) blockers.push({
      kind: blocker.domain, classification: blocker.classification, projectFile: project.projectFile,
      subject: blocker.subject, message: blocker.message,
    });
  }
  const checkedConfigs = new Set(projects.map((item) => item.project.projectFile));
  if (options.moduleInitializationEntry !== undefined && moduleInitializationComposition === undefined) blockers.push({
    kind: "module-initialization", classification: "unknown", projectFile: workspace.rootProjectFile,
    subject: resolve(options.moduleInitializationEntry),
    message: "module entry is not selected by any loaded TypeScript project",
  });
  for (const project of workspace.projects) if (!checkedConfigs.has(project.projectFile) && project.provenance.compiler.parity !== "exact") blockers.push({
    kind: "typescript", classification: "unknown", projectFile: project.projectFile,
    message: project.provenance.compiler.reason ?? "consumer TypeScript compiler parity is unknown",
  });
  const assumptions = projects.reduce((total, project) => total + project.verification.assurance.assumptions, 0);
  const status: ProjectWorkspaceAssurance["status"] = blockers.some((blocker) => blocker.classification === "violation")
    ? "violated" : blockers.length > 0 ? "unknown" : assumptions > 0 ? "assumed" : "verified";
  const assurance: ProjectWorkspaceAssurance = {
    status, passed: blockers.length === 0, assumptions, blockers,
    claims: blockers.length === 0 ? [
      "every referenced compiler domain passed project verification",
      "every selected source root belongs to exactly one TypeScript project",
      "every participating config resolves the exact analyzer TypeScript version",
      ...(effectLinks.length > 0 ? ["verified child-project function and module effects are composed into resolved parent calls and imports"] : []),
      ...(effectLinks.length > 0 ? ["every declaration consumed by Effect composition exactly matches a same-compiler in-memory re-emission"] : []),
      ...(refinementLinks.length > 0 ? ["verified child-project scalar refinement actions are composed through bounded resolved parent action call paths"] : []),
      ...(refinementLinks.length > 0 ? ["every declaration consumed by refinement composition exactly matches a same-compiler in-memory re-emission"] : []),
      ...(moduleInitializationComposition?.evidence === "verified" ? ["one exact cross-project straight-line top-level-await dependency preserves async module completion order"] : []),
      ...([...effectLinks, ...refinementLinks].some((link) => link.declarationIntegrity.transform) ? ["every transformed source consumed by cross-project composition is an exact embedded TypeScript span bound to transform and compiler identity"] : []),
      ...(outputIntegrity.status === "verified" ? ["every TypeScript-emitted declaration and runtime JavaScript output exactly matches same-compiler in-memory re-emission"] : []),
    ] : [],
    exclusions: [
      "this workspace assessment covers the selected source roots in every loaded tsconfig compiler domain",
      "contract, ownership, invariant, and temporal evidence is not composed across project boundaries",
      "cross-project refinement composition is limited to scalar direct calls or at most two write-screened sole-call local helpers with exact declarations",
      "cross-project inaccessible/non-exported, host-alias, and cross-realm Mutate identities, plus unbounded iterator effect parameters, are not composed",
      ...(options.buildArtifacts === "require-fresh" || options.buildArtifacts === "require-exact" ? [] : ["composite build-artifact freshness was observed but not required"]),
      ...(options.buildArtifacts === "require-exact" ? [] : ["emitted runtime JavaScript bytes were not compared with the analyzed TypeScript sources"]),
      "declaration byte equality trusts the exact selected TypeScript compiler and is not an independently checkable compiler proof",
      "embedded TypeScript transform evidence covers only the exact selected source span; surrounding host syntax and runtime semantics are not verified",
      ...new Set(projects.flatMap((project) => project.verification.assurance.exclusions).filter((exclusion) =>
        exclusion !== PROJECT_ASSURANCE_SELECTED_FILES_EXCLUSION
        && exclusion !== PROJECT_ASSURANCE_SINGLE_DOMAIN_EXCLUSION)),
    ],
  };
  return {
    schema: "uneffect-project-workspace/v1", rootProjectFile: workspace.rootProjectFile,
    references: workspace.references, buildOrder: workspace.buildOrder,
    buildArtifacts: workspace.buildArtifacts, outputIntegrity,
    configs: workspace.projects.map((project) => ({ ...project.provenance, rootFiles: project.fileNames })),
    projects,
    effectComposition: { status: effectBlockers.length > 0 ? "unknown" : effectLinks.length > 0 ? "verified" : "not-applicable", links: effectLinks, blockers: effectBlockers },
    refinementComposition: { status: refinementBlockers.length > 0 ? "unknown" : refinementLinks.length > 0 ? "verified" : "not-applicable", links: refinementLinks, blockers: refinementBlockers },
    ...(moduleInitializationComposition ? { moduleInitializationComposition } : {}),
    blockers, assurance,
  };
}

export function verifyUneffectProject(options: VerifyUneffectProjectOptions): Promise<VerifyUneffectProjectResult>;
export function verifyUneffectProject(options: VerifyUneffectWorkspaceOptions): Promise<VerifyUneffectWorkspaceResult>;
export function verifyUneffectProject(
  options: VerifyUneffectProjectOptions | VerifyUneffectWorkspaceOptions,
): Promise<VerifyUneffectProjectResult | VerifyUneffectWorkspaceResult> {
  return options.projectFile !== undefined ? verifyUneffectWorkspace(options) : verifyUneffectProjectFiles(options);
}
