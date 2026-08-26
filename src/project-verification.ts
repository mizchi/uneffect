import ts from "typescript";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAsyncPatterns, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "./async-patterns.js";
import { verifyContractObligations, type ContractDiagnostic, type VerificationArtifact } from "./contracts.js";
import { instrumentRuntimeAssertions, type InstrumentDiagnostic } from "./instrument.js";
import { analyzePromiseChains } from "./promise-chains.js";
import { analyzeOwnership, type OwnershipDiagnostic } from "./ownership.js";
import { verifyTypedArraySafetyInProgram, type TypedArrayDiagnostic, type TypedArrayProgramSafetyResult } from "./typed-array-safety.js";
import { collectAssumptionLedger, type AssumptionLedger, type AssumptionPolicy, type AssumptionPolicyDiagnostic } from "./assumptions.js";
import { extractAnnotations } from "./annotations.js";
import { parseTemporalComposition } from "./temporal-compose.js";
import { analyzeProgramEffects, type EffectAnalysisResult, type EffectDiagnostic, type ExternalFunctionEffectContract } from "./effects.js";
import { fromTypeScriptDiagnostic, type TypeScriptCheckerDiagnostic } from "./diagnostics.js";
import { assessProjectVerification, type ProjectAssuranceAssessment } from "./project-assurance.js";
import type { BuiltinContractRegistry } from "./builtin-contracts.js";
import { analyzeModuleInitializationOrder, type ModuleInitializationOrder } from "./module-initialization.js";
import { loadTypeScriptWorkspace, type TypeScriptProject, type TypeScriptProjectProvenance, type TypeScriptWorkspaceBlocker } from "./typescript-project.js";
import { composeWorkspaceEffects, type WorkspaceEffectCompositionBlocker, type WorkspaceEffectLink } from "./workspace-effects.js";

export interface VerifyUneffectProjectBaseOptions {
  runtimeAssertions?: "off" | "fallback";
  temporalRuntime?: "web" | "node";
  nodeTopLevelMode?: "commonjs" | "esm";
  temporalRoot?: string;
  assumptionPolicy?: AssumptionPolicy;
  /** Caller-owned, versioned semantic contracts. Defaults to Uneffect's registry. */
  builtinRegistry?: BuiltinContractRegistry;
  /** Opt in to source-mapped ESM initialization-order evidence for one entry module. */
  moduleInitializationEntry?: string;
}

export interface VerifyUneffectProjectOptions extends VerifyUneffectProjectBaseOptions {
  files: Record<string, string>;
  projectFile?: never;
}

export interface VerifyUneffectWorkspaceOptions extends VerifyUneffectProjectBaseOptions {
  projectFile: string;
  files?: never;
  /** Require TypeScript SolutionBuilder to report every composite output as current. */
  buildArtifacts?: "ignore" | "require-fresh";
}

export interface ProjectVerificationObligation extends VerificationArtifact {
  backend: "z3";
  result: VerificationArtifact["status"];
}

export interface VerifyUneffectProjectResult {
  obligations: ProjectVerificationObligation[];
  diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic | TypedArrayDiagnostic | ProjectOwnershipDiagnostic | AssumptionPolicyDiagnostic | EffectDiagnostic | TypeScriptCheckerDiagnostic>;
  emittedFiles: Record<string, string>;
  typedArrays: TypedArrayProgramSafetyResult;
  ownership: { diagnostics: ProjectOwnershipDiagnostic[] };
  assumptions: AssumptionLedger;
  effects: EffectAnalysisResult;
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
  configs: Array<TypeScriptProjectProvenance & { rootFiles: string[] }>;
  projects: ProjectWorkspaceVerificationDomain[];
  effectComposition: { status: "verified" | "unknown"; links: WorkspaceEffectLink[]; blockers: WorkspaceEffectCompositionBlocker[] };
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
  kind: "web-event-loop" | "node-event-loop";
  quint: string;
}

export interface ProjectTemporalVerification {
  sourceLanguage: "uneffect-ts";
  backend: "quint";
  models: ProjectTemporalModel[];
  properties: ProjectTemporalProperty[];
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
    return ts.resolveModuleName(moduleName, containingFile, compilerOptions, host).resolvedModule;
  });
  return ts.createProgram({ rootNames: Object.keys(files), options: compilerOptions, host, projectReferences });
}

function verifyQuintInvariant(fileName: string, program: string, invariant: string): ProjectTemporalProperty {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-project-quint-"));
  const path = join(directory, "model.qnt");
  try {
    writeFileSync(path, program);
    const verification = spawnSync("pnpm", ["exec", "quint", "run", path, `--invariant=${invariant}`, "--max-steps=12", "--max-samples=500", "--seed=0x756e656666656374", "--verbosity=1"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = `${verification.stdout ?? ""}${verification.stderr ?? ""}`;
    const result = verification.error ? "error" : verification.status === 0 ? "verified" : /violation|counterexample/i.test(output) ? "counterexample" : "error";
    return { fileName, name: invariant, result, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface ProjectVerificationCompilerContext {
  project: TypeScriptProject;
  program?: ts.Program;
  externalFunctionEffects?: ReadonlyMap<string, ExternalFunctionEffectContract>;
}

async function verifyUneffectProjectFiles(
  options: VerifyUneffectProjectOptions,
  compilerContext?: ProjectVerificationCompilerContext,
): Promise<VerifyUneffectProjectResult> {
  const obligations: ProjectVerificationObligation[] = [];
  const diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic | TypedArrayDiagnostic | ProjectOwnershipDiagnostic | AssumptionPolicyDiagnostic | EffectDiagnostic | TypeScriptCheckerDiagnostic> = [];
  const emittedFiles: Record<string, string> = {};
  const temporalModels: ProjectTemporalModel[] = [];
  const temporalProperties: ProjectTemporalProperty[] = [];
  const typedArrays = await verifyTypedArraySafetyInProgram(options.files);
  const program = compilerContext?.program ?? inMemoryProgram(options.files, compilerContext?.project.compilerOptions, compilerContext?.project.projectReferences);
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
  const effects = analyzeProgramEffects(program, {
    requireAnnotations: false, builtinRegistry: options.builtinRegistry,
    externalFunctionEffects: compilerContext?.externalFunctionEffects,
  });
  diagnostics.push(...effects.diagnostics);
  const ownershipDiagnostics: ProjectOwnershipDiagnostic[] = [];
  for (const fileName of Object.keys(options.files)) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    ownershipDiagnostics.push(...analyzeOwnership(program, sourceFile).map((diagnostic) => ({ ...diagnostic, fileName, kind: "ownership" as const })));
  }
  for (const ownership of ownershipDiagnostics) {
    if (ownership.operation !== "read" || !["detached", "transferred", "locked"].includes(ownership.state)) continue;
    const result = typedArrays.files[ownership.fileName];
    const source = options.files[ownership.fileName];
    if (!result || source === undefined) continue;
    for (const obligation of result.obligations) {
      if (obligation.kind !== "dataview-backing-bounds" || obligation.span.end < ownership.span.end) continue;
      if (!source.slice(obligation.span.start, obligation.span.end).includes(ownership.resource)) continue;
      obligation.result = "counterexample";
      if (!result.diagnostics.some((item) => item.kind === obligation.kind && item.span.start === obligation.span.start)) result.diagnostics.push({
        fileName: ownership.fileName,
        functionName: obligation.functionName,
        kind: obligation.kind,
        span: obligation.span,
        message: `fixed-buffer evidence for ${ownership.resource} was invalidated after it became ${ownership.state}`,
      });
    }
  }
  for (const [fileName, result] of Object.entries(typedArrays.files)) if (invalidSources.has(fileName)) {
    for (const obligation of result.obligations) obligation.result = "unknown";
  }
  typedArrays.obligations = Object.values(typedArrays.files).flatMap((result) => result.obligations);
  typedArrays.diagnostics = Object.values(typedArrays.files).flatMap((result) => result.diagnostics);
  diagnostics.push(...typedArrays.diagnostics, ...ownershipDiagnostics);
  const assumptions = collectAssumptionLedger(program, options.files, typedArrays, options.assumptionPolicy, options.builtinRegistry);
  diagnostics.push(...assumptions.diagnostics);
  for (const [fileName, source] of Object.entries(options.files)) {
    const verification = await verifyContractObligations(fileName, source);
    obligations.push(...verification.artifacts.map((artifact) => invalidSources.has(fileName)
      ? { ...artifact, status: "unknown" as const, evidence: "unknown" as const, backend: "z3" as const, result: "unknown" as const, message: "TypeScript errors prevent proof-grade contract evidence for this source" }
      : { ...artifact, backend: "z3" as const, result: artifact.status }));
    diagnostics.push(...verification.diagnostics);
    const instrumented = options.runtimeAssertions === "fallback" ? instrumentRuntimeAssertions(fileName, source) : { code: source, diagnostics: [] };
    diagnostics.push(...instrumented.diagnostics);
    emittedFiles[javascriptPath(fileName)] = ts.transpileModule(instrumented.code, {
      fileName,
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText;
    if (options.temporalRuntime === "web") {
      const temporalComposition = extractAnnotations(source, "state").length > 0
        ? parseTemporalComposition(fileName, source, options.temporalRoot ?? "main")
        : undefined;
      const quint = generateWebEventLoopQuint(
        fileName.replace(/[^A-Za-z0-9_]/g, "_"),
        analyzeAsyncPatterns(fileName, source),
        {},
        analyzePromiseChains(fileName, source),
        temporalComposition,
      );
      temporalModels.push({ fileName, kind: "web-event-loop", quint });
      const verifyTemporalProperty = (name: string): ProjectTemporalProperty => invalidSources.has(fileName)
        ? { fileName, name, result: "error", output: `TypeScript errors in ${fileName} prevent proof-grade temporal evidence` }
        : verifyQuintInvariant(fileName, quint, name);
      temporalProperties.push(verifyTemporalProperty("eventLoopSafe"));
      for (const property of temporalComposition?.properties ?? []) temporalProperties.push(verifyTemporalProperty(property.name));
    } else if (options.temporalRuntime === "node") {
      const quint = generateNodeEventLoopQuint(fileName.replace(/[^A-Za-z0-9_]/g, "_"), analyzeAsyncPatterns(fileName, source), {
        topLevelMode: options.nodeTopLevelMode ?? "commonjs",
      }, analyzePromiseChains(fileName, source));
      temporalModels.push({ fileName, kind: "node-event-loop", quint });
      temporalProperties.push(invalidSources.has(fileName)
        ? { fileName, name: "nodeEventLoopSafe", result: "error", output: `TypeScript errors in ${fileName} prevent proof-grade temporal evidence` }
        : verifyQuintInvariant(fileName, quint, "nodeEventLoopSafe"));
    }
  }
  const temporal = options.temporalRuntime === "web" || options.temporalRuntime === "node"
    ? { sourceLanguage: "uneffect-ts" as const, backend: "quint" as const, models: temporalModels, properties: temporalProperties }
    : undefined;
  const moduleInitialization = options.moduleInitializationEntry === undefined
    ? undefined : analyzeModuleInitializationOrder(program, options.moduleInitializationEntry);
  const partial = {
    obligations, diagnostics, emittedFiles, typedArrays, ownership: { diagnostics: ownershipDiagnostics }, assumptions: assumptions.ledger, effects,
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
  if (options.buildArtifacts === "require-fresh" && workspace.buildArtifacts.status !== "fresh") blockers.push({
    kind: "build-artifact", classification: "unknown", projectFile: workspace.rootProjectFile,
    message: workspace.buildArtifacts.status === "stale"
      ? "TypeScript SolutionBuilder reports stale or missing composite build artifacts"
      : "TypeScript SolutionBuilder did not establish composite build-artifact freshness",
  });
  const projects: ProjectWorkspaceVerificationDomain[] = [];
  const effectLinks: WorkspaceEffectLink[] = [], effectBlockers: WorkspaceEffectCompositionBlocker[] = [];
  const completed: Array<{ project: TypeScriptProject; summaries: EffectAnalysisResult["summaries"] }> = [];
  const base: VerifyUneffectProjectBaseOptions = {
    ...(options.runtimeAssertions === undefined ? {} : { runtimeAssertions: options.runtimeAssertions }),
    ...(options.temporalRuntime === undefined ? {} : { temporalRuntime: options.temporalRuntime }),
    ...(options.nodeTopLevelMode === undefined ? {} : { nodeTopLevelMode: options.nodeTopLevelMode }),
    ...(options.temporalRoot === undefined ? {} : { temporalRoot: options.temporalRoot }),
    ...(options.assumptionPolicy === undefined ? {} : { assumptionPolicy: options.assumptionPolicy }),
    ...(options.builtinRegistry === undefined ? {} : { builtinRegistry: options.builtinRegistry }),
  };
  for (const project of workspace.projects) {
    if (project.fileNames.length === 0) continue;
    const selected = workspaceFiles(project);
    if (selected.blocker) { blockers.push(selected.blocker); continue; }
    const moduleInitializationEntry = options.moduleInitializationEntry === undefined
      ? undefined : resolve(options.moduleInitializationEntry);
    const program = inMemoryProgram(selected.files, project.compilerOptions, project.projectReferences);
    const composition = composeWorkspaceEffects(program, project, completed);
    effectLinks.push(...composition.links);
    effectBlockers.push(...composition.blockers);
    blockers.push(...composition.blockers);
    const verification = await verifyUneffectProjectFiles({
      ...base, files: selected.files,
      ...(moduleInitializationEntry !== undefined && project.fileNames.includes(moduleInitializationEntry)
        ? { moduleInitializationEntry } : {}),
    }, { project, program, externalFunctionEffects: composition.contracts });
    projects.push({ project: project.provenance, rootFiles: project.fileNames, verification });
    completed.push({ project, summaries: verification.effects.summaries });
    for (const blocker of verification.assurance.blockers) blockers.push({
      kind: blocker.domain, classification: blocker.classification, projectFile: project.projectFile,
      subject: blocker.subject, message: blocker.message,
    });
  }
  const checkedConfigs = new Set(projects.map((item) => item.project.projectFile));
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
      ...(effectLinks.length > 0 ? ["verified child-project function effects are composed into resolved parent call sites"] : []),
    ] : [],
    exclusions: [
      "contract, ownership, refinement, and temporal evidence is not composed across project boundaries",
      "cross-project Mutate regions and iterator effect parameters are not composed",
      ...(options.buildArtifacts === "require-fresh" ? [] : ["composite build-artifact freshness was observed but not required"]),
      "declaration output content integrity and semantic equivalence are not independently validated",
      ...new Set(projects.flatMap((project) => project.verification.assurance.exclusions)),
    ],
  };
  return {
    schema: "uneffect-project-workspace/v1", rootProjectFile: workspace.rootProjectFile,
    references: workspace.references, buildOrder: workspace.buildOrder,
    buildArtifacts: workspace.buildArtifacts,
    configs: workspace.projects.map((project) => ({ ...project.provenance, rootFiles: project.fileNames })),
    projects, effectComposition: { status: effectBlockers.length === 0 ? "verified" : "unknown", links: effectLinks, blockers: effectBlockers }, blockers, assurance,
  };
}

export function verifyUneffectProject(options: VerifyUneffectProjectOptions): Promise<VerifyUneffectProjectResult>;
export function verifyUneffectProject(options: VerifyUneffectWorkspaceOptions): Promise<VerifyUneffectWorkspaceResult>;
export function verifyUneffectProject(
  options: VerifyUneffectProjectOptions | VerifyUneffectWorkspaceOptions,
): Promise<VerifyUneffectProjectResult | VerifyUneffectWorkspaceResult> {
  return options.projectFile !== undefined ? verifyUneffectWorkspace(options) : verifyUneffectProjectFiles(options);
}
