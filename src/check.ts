import { readFile } from "node:fs/promises";
import ts from "typescript";
import { analyzeAsyncSafetyInProgram } from "./async-safety.js";
import { attachContractEffectBoundaries, verifyContractObligations, type VerificationArtifact } from "./contracts.js";
import { fromTypeScriptDiagnostic, type CheckerDiagnostic, type OwnershipCheckerDiagnostic, type ResourceCheckerDiagnostic, type TypedArrayCheckerDiagnostic, type TypeScriptCheckerDiagnostic } from "./diagnostics.js";
import { analyzeProgramEffects, type EffectSummary, type ExternalFunctionEffectContract, type ExternalModuleEffectContract } from "./effects.js";
import { analyzeReactProgram } from "./react-semantics.js";
import type { BuiltinContractRegistry } from "./builtin-contracts.js";
import type { TypeScriptProjectProvenance } from "./typescript-project.js";
import { collectAssumptionLedger, mergeAssumptionLedger, type AssumptionEntry, type AssumptionLedger } from "./assumptions.js";
import { analyzeTrustedScriptSinks } from "./trusted-types.js";
import type { AssumptionRegistry } from "./assumption-registry.js";
import { verifyTypedArraySafetyInTypeScriptProgram, type TypedArrayProgramSafetyResult } from "./typed-array-safety.js";
import { analyzeOwnership, type OwnershipDiagnostic } from "./ownership.js";
import { analyzeCallableSummaries } from "./callable-summary.js";
import { invalidateTransferredTypedArrayEvidence } from "./project-verification.js";
import { collectIteratorChecks, type IteratorCheckEvidence } from "./iterator-check.js";
import { bindContractSummaryBundleToProgram, boundContractSummaryEffectContracts, boundContractSummaryResourceContracts, type ContractSummaryBundleV1 } from "./contract-summary.js";
import { analyzeResourceCallableSummaries, analyzeResourceLifecyclesInSource, type ResourceLifecycleEvidence } from "./resource-callable-typescript.js";

export interface CheckOptions {
  /** `gradual` (default) reports unknown effects as warnings; `strict` fails on them. */
  mode?: "gradual" | "strict";
  /** `false` only reports functions that already carry an effect declaration. */
  requireAnnotations?: boolean;
  /** Reusable host; `createCheckHost()` shares parsed library files across many one-file programs. */
  host?: ts.CompilerHost;
  /** Caller-owned, versioned semantic contracts. Defaults to Uneffect's registry. */
  builtinRegistry?: BuiltinContractRegistry;
  /** Caller-owned review records referenced by source-level trust IDs. */
  assumptionRegistry?: AssumptionRegistry;
  /** Consumer compiler semantics, normally loaded from its tsconfig.json. */
  compilerOptions?: ts.CompilerOptions;
  /** Exact project/compiler identity used to qualify TypeChecker-derived assurance. */
  project?: TypeScriptProjectProvenance;
  /** Native TypeScript project-reference edges for this compiler domain. */
  projectReferences?: readonly ts.ProjectReference[];
  /** Reuse the exact Program used to resolve cross-project declaration identities. */
  program?: ts.Program;
  /** Verified child-program function contracts keyed by resolved declaration id. */
  externalFunctionEffects?: ReadonlyMap<string, ExternalFunctionEffectContract>;
  /** Verified child-program module-evaluation contracts keyed by declaration file. */
  externalModuleEffects?: ReadonlyMap<string, ExternalModuleEffectContract>;
  /** Producer-verified package contracts bound to installed declarations. */
  contractSummaryBundles?: readonly ContractSummaryBundleV1[];
}

export interface CheckResult {
  diagnostics: CheckerDiagnostic[];
  /** Source text per absolute file name, so a report can quote the offending line. */
  sources: Map<string, string>;
  /** Evidence for what was checked, including the obligations that were proved. */
  artifacts: VerificationArtifact[];
  summaries: EffectSummary[];
  /** Every trusted semantic input used by this exact check boundary. */
  assumptions: AssumptionLedger;
  typedArrays: TypedArrayProgramSafetyResult;
  ownership: Array<OwnershipDiagnostic & { fileName: string }>;
  asyncIterators: IteratorCheckEvidence[];
  resourceProtocols: ResourceLifecycleEvidence[];
  errors: number;
  warnings: number;
  project?: TypeScriptProjectProvenance;
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
};

/** A compiler host that keeps library declarations parsed once across repeated single-file programs. */
export function createCheckHost(options: ts.CompilerOptions = compilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options), cache = new Map<string, ts.SourceFile | undefined>();
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!fileName.endsWith(".d.ts")) return read(fileName, languageVersion, onError, shouldCreate);
    if (!cache.has(fileName)) cache.set(fileName, read(fileName, languageVersion, onError, shouldCreate));
    return cache.get(fileName);
  };
  return host;
}

export function createCheckProgram(fileNames: readonly string[], options: CheckOptions = {}): ts.Program {
  const effectiveCompilerOptions = options.compilerOptions ?? compilerOptions;
  return ts.createProgram({
    rootNames: [...fileNames], options: effectiveCompilerOptions, host: options.host,
    projectReferences: options.projectReferences,
  });
}

/** Run every checker the CLI runs — effects, contracts, async safety — over one set of files. */
export async function checkFiles(fileNames: readonly string[], options: CheckOptions = {}): Promise<CheckResult> {
  const program = options.program ?? createCheckProgram(fileNames, options);
  const contractSummaryBindings = (options.contractSummaryBundles ?? []).map((bundle) =>
    bindContractSummaryBundleToProgram(bundle, program));
  const packageEffects = boundContractSummaryEffectContracts(contractSummaryBindings);
  const externalFunctionEffects = new Map([...(options.externalFunctionEffects ?? []), ...packageEffects]);
  const analyzedEffects = analyzeProgramEffects(program, {
    mode: options.mode ?? "gradual", requireAnnotations: options.requireAnnotations ?? true,
    builtinRegistry: options.builtinRegistry,
    externalFunctionEffects,
    externalModuleEffects: options.externalModuleEffects,
  });
  const effects = {
    summaries: analyzedEffects.summaries.filter((summary) => !summary.fileName?.endsWith(".uneffect.ts")),
    diagnostics: analyzedEffects.diagnostics.filter((diagnostic) => !diagnostic.fileName.endsWith(".uneffect.ts")),
  };
  const react = analyzeReactProgram(program);
  const diagnostics: CheckerDiagnostic[] = [];
  for (const fileName of fileNames) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    diagnostics.push(
      ...program.getSyntacticDiagnostics(source).map((diagnostic) => fromTypeScriptDiagnostic(diagnostic, "syntax")),
      ...program.getSemanticDiagnostics(source).map((diagnostic) => fromTypeScriptDiagnostic(diagnostic, "semantic")),
    );
  }
  diagnostics.push(...program.getOptionsDiagnostics().map((diagnostic) => fromTypeScriptDiagnostic(diagnostic, "options")));
  const invalidSources = new Set(diagnostics.filter((diagnostic): diagnostic is TypeScriptCheckerDiagnostic =>
    "domain" in diagnostic && diagnostic.domain === "typescript" && diagnostic.severity === "error" && diagnostic.fileName !== "<typescript-options>")
    .map((diagnostic) => diagnostic.fileName));
  for (const summary of effects.summaries) if (summary.fileName && invalidSources.has(summary.fileName)) summary.evidence = "unknown";
  diagnostics.push(...effects.diagnostics);
  const sources = new Map<string, string>(), artifacts: VerificationArtifact[] = [];
  const contractSummaryAssumptions: AssumptionEntry[] = contractSummaryBindings.flatMap((binding) => binding.exports.flatMap((item) =>
    item.callSites.map((call) => ({
      id: `package-contract:${binding.package.name}@${binding.package.version}:${call.fileName}:${call.span.start}`,
      evidence: "trusted" as const,
      domain: "package-contract" as const,
      reason: "persisted producer contract authority is not authenticated by declaration binding",
      dependency: { module: binding.package.name, packageVersion: binding.package.version },
      scope: { fileName: call.fileName, functionName: item.exportName, span: call.span },
    }))));
  for (const binding of contractSummaryBindings) if (binding.status === "unknown") {
    const fileName = fileNames[0] ?? "<project>";
    for (const message of binding.blockers) {
      const artifact: VerificationArtifact = {
        obligationId: `contract-summary:${binding.package.name}:${artifacts.length}`,
        status: "unknown", evidence: "unknown", source: { fileName, span: { start: 0, end: 0 } }, message,
      };
      artifacts.push(artifact);
      diagnostics.push({
        fileName, functionName: "<package-contract>", clause: "unsupported", line: 1,
        message, obligationId: artifact.obligationId, artifact,
        notes: [{ label: "because", detail: "the supplied package contract summary did not authenticate against the declaration selected by this TypeScript Program" }],
      });
    }
  }
  const asyncIterators: IteratorCheckEvidence[] = [];
  const resourceProtocols: ResourceLifecycleEvidence[] = [];
  const resourceAssumptions: AssumptionEntry[] = [];
  const localResourceCallableAnalysis = analyzeResourceCallableSummaries(program);
  const resourceCallableAnalysis = {
    summaries: [...localResourceCallableAnalysis.summaries, ...boundContractSummaryResourceContracts(contractSummaryBindings)],
    diagnostics: localResourceCallableAnalysis.diagnostics,
  };
  const iteratorAssumptions: AssumptionEntry[] = [];
  for (const fileName of fileNames) {
    if (fileName.endsWith(".uneffect.ts")) continue;
    const text = await readFile(fileName, "utf8");
    sources.set(fileName, text);
    const contracts = await verifyContractObligations(fileName, text, undefined, program, {
      externalContractBindings: contractSummaryBindings.flatMap((binding) => binding.exports),
    });
    diagnostics.push(...contracts.diagnostics);
    artifacts.push(...attachContractEffectBoundaries(contracts.artifacts, effects.summaries));
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile) {
      diagnostics.push(...analyzeTrustedScriptSinks(program, sourceFile));
      diagnostics.push(...(react.get(sourceFile.fileName)?.diagnostics ?? []));
      diagnostics.push(...analyzeAsyncSafetyInProgram(program, sourceFile).diagnostics);
      const iterator = collectIteratorChecks(program, sourceFile, options.mode ?? "gradual", !invalidSources.has(fileName));
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
        domain: "resource", kind: diagnostic.kind,
        severity: diagnostic.kind === "unknown-analysis" && options.mode !== "strict" ? "warning" : "error",
        fileName: diagnostic.fileName,
        line: sourceFile.getLineAndCharacterOfPosition(diagnostic.span.start).line + 1,
        functionName: diagnostic.functionName, message: diagnostic.message,
        notes: [{ label: "resource", detail: diagnostic.resource }, { label: "state", detail: diagnostic.state }],
      })));
    }
  }
  const typedFiles: TypedArrayProgramSafetyResult["files"] = {};
  const ownership: Array<OwnershipDiagnostic & { fileName: string }> = [];
  const typedArrayCandidate = (text: string): boolean => /\b(?:BoundedUint8Array|BoundedUint32Array|BoundedDataView|BoundedArrayBuffer|FixedArrayBuffer|u8Table|u32Table|U8|U32|I32|F32)\b/u.test(text);
  const ownershipCandidate = (text: string): boolean => /\b(?:structuredClone|postMessage|DataView|subarray|slice)\b/u.test(text);
  const needsOwnership = fileNames.some((fileName) => {
    const source = program.getSourceFile(fileName);
    return source ? ownershipCandidate(source.text) : false;
  });
  const callableSummaries = needsOwnership ? analyzeCallableSummaries(program, analyzedEffects).summaries : [];
  const functionAt = (source: ts.SourceFile, position: number): string => {
    let name = "<module>";
    const visit = (node: ts.Node): void => {
      if (position < node.getStart(source) || position > node.getEnd()) return;
      if (ts.isFunctionLike(node) && "name" in node && node.name && ts.isIdentifier(node.name)) name = node.name.text;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return name;
  };
  for (const fileName of fileNames) {
    if (fileName.endsWith(".uneffect.ts")) continue;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    const typed = typedArrayCandidate(sourceFile.text)
      ? await verifyTypedArraySafetyInTypeScriptProgram(program, sourceFile, undefined, options.assumptionRegistry)
      : { obligations: [], diagnostics: [], windows: [], statistics: { solverQueries: 0 } };
    if (invalidSources.has(fileName)) {
      for (const obligation of typed.obligations) obligation.result = "unknown";
      for (const window of typed.windows) window.result = "unknown";
    }
    typedFiles[fileName] = typed;
    if (!invalidSources.has(fileName) && ownershipCandidate(sourceFile.text)) {
      const found = analyzeOwnership(program, sourceFile, callableSummaries, externalFunctionEffects);
      ownership.push(...found.map((diagnostic) => ({ ...diagnostic, fileName })));
      diagnostics.push(...found.map((diagnostic): OwnershipCheckerDiagnostic => ({
        domain: "ownership", kind: "invalid-transition", severity: diagnostic.state === "unknown" && options.mode !== "strict" ? "warning" : "error", fileName,
        line: sourceFile.getLineAndCharacterOfPosition(diagnostic.span.start).line + 1,
        functionName: functionAt(sourceFile, diagnostic.span.start), message: diagnostic.message,
        notes: [{ label: "state", detail: diagnostic.state }, { label: "resource", detail: diagnostic.resource }],
      })));
    }
  }
  const typedArrays: TypedArrayProgramSafetyResult = {
    files: typedFiles,
    obligations: Object.values(typedFiles).flatMap((result) => result.obligations),
    diagnostics: Object.values(typedFiles).flatMap((result) => result.diagnostics),
    windows: Object.values(typedFiles).flatMap((result) => result.windows),
    statistics: { solverQueries: Object.values(typedFiles).reduce((total, result) => total + result.statistics.solverQueries, 0) },
  };
  invalidateTransferredTypedArrayEvidence(program, Object.fromEntries(sources), typedArrays, ownership.map((diagnostic) => ({
    ...diagnostic, kind: "ownership" as const,
  })));
  typedArrays.diagnostics = Object.values(typedFiles).flatMap((result) => result.diagnostics);
  for (const [fileName, typed] of Object.entries(typedFiles)) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    diagnostics.push(...typed.diagnostics.map((diagnostic): TypedArrayCheckerDiagnostic => ({
      domain: "typed-array", kind: diagnostic.kind,
      severity: typed.obligations.find((obligation) => obligation.kind === diagnostic.kind
        && obligation.span.start === diagnostic.span.start)?.result === "unknown" && options.mode !== "strict" ? "warning" : "error",
      fileName,
      line: sourceFile.getLineAndCharacterOfPosition(diagnostic.span.start).line + 1,
      functionName: diagnostic.functionName, message: diagnostic.message,
      notes: [{ label: "obligation", detail: diagnostic.kind }],
    })));
  }
  const errors = diagnostics.filter((diagnostic) => !("severity" in diagnostic) || diagnostic.severity === "error").length;
  const collectedAssumptions = collectAssumptionLedger(program, Object.fromEntries(sources), typedArrays, {}, options.builtinRegistry, options.assumptionRegistry).ledger;
  const assumptions = mergeAssumptionLedger(program, collectedAssumptions, [...iteratorAssumptions, ...resourceAssumptions, ...contractSummaryAssumptions]).ledger;
  return {
    diagnostics, sources, artifacts, summaries: effects.summaries, assumptions, typedArrays, ownership, asyncIterators, resourceProtocols, errors, warnings: diagnostics.length - errors,
    ...(options.project === undefined ? {} : { project: options.project }),
  };
}
