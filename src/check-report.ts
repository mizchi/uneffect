import type { AssuranceAssessment } from "./assurance.js";
import { formatEffect } from "./capabilities.js";
import type { CheckResult } from "./check.js";
import type { VerificationArtifact } from "./contracts.js";
import { reportDiagnostic, type ReportedDiagnostic } from "./diagnostics.js";
import type { TypeScriptProjectProvenance } from "./typescript-project.js";
import type { AssuranceProfile, AssuranceStatus } from "./assurance.js";
import type { TypeScriptWorkspace } from "./typescript-project.js";
import type { DeclarationOutputIntegrity, WorkspaceEffectComposition } from "./workspace-effects.js";
import type { WorkspaceRefinementComposition, WorkspaceRefinementLink } from "./workspace-refinements.js";
import type { CorsaEffectParityResult } from "./corsa-effect-parity.js";
import type { WorkspaceModuleInitializationComposition } from "./workspace-module-initialization.js";
import type { BuildOutputIntegrity } from "./build-output-integrity.js";
import type { EffectUnknownReason } from "./effects.js";
import type { AssumptionLedger } from "./assumptions.js";
import type { TypedArrayObligation, TypedArraySafetyStatistics, TypedArrayWindowProvenance } from "./typed-array-safety.js";
import type { OwnershipDiagnostic } from "./ownership.js";
import type { IteratorCheckEvidence } from "./iterator-check.js";

export interface CheckReportEffect {
  id?: string;
  fileName?: string;
  span?: { start: number; end: number };
  functionName: string;
  effects: string[];
  evidence: "verified" | "trusted" | "inferred" | "unknown";
  unknownReasons?: EffectUnknownReason[];
  parameters?: string[];
  iteratorEffectParameters?: Array<{ index: number; name: string; convertsThrowToRejection: boolean }>;
  iteratorEffectBounds?: Array<{ index: number; name: string; effects: string[] }>;
}

export interface CheckReportResourceProtocol {
  fileName: string;
  owner: string;
  resource: string;
  kind: string;
  status: "satisfied" | "unsatisfied" | "unknown";
  evidence: "verified" | "trusted" | "unknown";
  authority: "callable-contract" | "builtin-catalog" | "mixed";
  state: string;
  transitionKinds: string[];
}

/** Stable CLI interchange shape. Internal TypeScript nodes and solver objects are never exposed. */
export interface CheckJsonReport {
  schema: "uneffect-check/v1";
  outcome: "passed" | "failed";
  counts: { errors: number; warnings: number };
  diagnostics: ReportedDiagnostic[];
  effects: CheckReportEffect[];
  contracts: VerificationArtifact[];
  assumptions: AssumptionLedger;
  typedArrays: { obligations: TypedArrayObligation[]; windows: TypedArrayWindowProvenance[]; statistics: TypedArraySafetyStatistics };
  ownership: Array<OwnershipDiagnostic & { fileName: string }>;
  asyncIterators: IteratorCheckEvidence[];
  resourceProtocols: CheckReportResourceProtocol[];
  corsaEffectParity?: CorsaEffectParityResult;
  assurance: AssuranceAssessment | null;
  project: TypeScriptProjectProvenance | null;
}

export interface WorkspaceCheckBlocker {
  kind: string;
  classification: "unknown" | "violation";
  projectFile: string;
  message: string;
  reference?: string;
  subject?: string;
}

export interface WorkspaceCheckAssurance {
  profile: AssuranceProfile;
  status: AssuranceStatus;
  passed: boolean;
  blockers: WorkspaceCheckBlocker[];
  claims: string[];
  exclusions: string[];
}

export interface CheckWorkspaceJsonReport {
  schema: "uneffect-workspace-check/v1";
  outcome: "passed" | "failed";
  rootProjectFile: string;
  references: Array<{ from: string; to: string }>;
  buildOrder: string[];
  buildArtifacts: { status: "fresh" | "stale" | "unknown"; observations: Array<{ code: number; message: string }> };
  outputIntegrity: BuildOutputIntegrity;
  configs: Array<TypeScriptProjectProvenance & { rootFiles: string[] }>;
  projects: CheckJsonReport[];
  effectComposition: {
    status: "not-applicable" | "verified" | "unknown";
    links: Array<{
      kind: "function" | "module"; fromProject: string; toProject: string; callerFile: string; callee: string; declarationFile: string;
      evidence: "verified" | "trusted" | "inferred" | "unknown"; effects: string[]; parameters?: readonly string[];
      iteratorEffectParameters?: ReadonlyArray<{ index: number; name: string; convertsThrowToRejection: boolean }>;
      iteratorEffectBounds?: ReadonlyArray<{ index: number; name: string; effects: readonly string[] }>;
      mutationRoots?: ReadonlyArray<
        { kind: "export"; root: string; exportName: string; identity: string }
        | { kind: "ambient"; root: "globalThis"; identity: "ecmascript:realm.globalThis" }
      >;
      declarationIntegrity: DeclarationOutputIntegrity;
    }>;
    blockers: WorkspaceCheckBlocker[];
  };
  refinementComposition: {
    status: "not-applicable" | "verified" | "unknown";
    links: WorkspaceRefinementLink[];
    blockers: WorkspaceCheckBlocker[];
  };
  moduleInitializationComposition?: WorkspaceModuleInitializationComposition;
  blockers: WorkspaceCheckBlocker[];
  assurance: WorkspaceCheckAssurance | null;
}

export function createCheckJsonReport(result: CheckResult, assurance?: AssuranceAssessment): CheckJsonReport {
  const passed = result.errors === 0 && (assurance?.passed ?? true);
  return {
    schema: "uneffect-check/v1",
    outcome: passed ? "passed" : "failed",
    counts: { errors: result.errors, warnings: result.warnings },
    diagnostics: result.diagnostics.map(reportDiagnostic),
    effects: result.summaries.map((summary) => ({
      ...(summary.id === undefined ? {} : { id: summary.id }),
      ...(summary.fileName === undefined ? {} : { fileName: summary.fileName }),
      ...(summary.span === undefined ? {} : { span: summary.span }),
      functionName: summary.functionName,
      effects: summary.effects.map(formatEffect),
      evidence: summary.evidence,
      ...(summary.unknownReasons === undefined ? {} : { unknownReasons: summary.unknownReasons }),
      ...(summary.parameters === undefined ? {} : { parameters: summary.parameters }),
      ...(summary.iteratorEffectParameters === undefined ? {} : { iteratorEffectParameters: summary.iteratorEffectParameters }),
      ...(summary.iteratorEffectBounds === undefined ? {} : {
        iteratorEffectBounds: summary.iteratorEffectBounds.map((bound) => ({
          index: bound.index, name: bound.name, effects: bound.effects.map(formatEffect),
        })),
      }),
    })),
    contracts: result.artifacts,
    assumptions: result.assumptions,
    typedArrays: {
      obligations: result.typedArrays.obligations,
      windows: result.typedArrays.windows,
      statistics: result.typedArrays.statistics,
    },
    ownership: result.ownership,
    asyncIterators: result.asyncIterators,
    resourceProtocols: result.resourceProtocols.map((resource) => ({
      fileName: resource.fileName, owner: resource.owner, resource: resource.resource, kind: resource.kind,
      status: resource.status, evidence: resource.evidence, authority: resource.authority, state: resource.state,
      transitionKinds: resource.transitions.map((transition) => transition.kind),
    })),
    ...(result.corsaEffectParity === undefined ? {} : { corsaEffectParity: result.corsaEffectParity }),
    assurance: assurance ?? null,
    project: result.project ?? null,
  };
}

/** Aggregate independent compiler domains without pretending they formed one TypeScript Program. */
export function createCheckWorkspaceJsonReport(
  workspace: TypeScriptWorkspace,
  projects: CheckJsonReport[],
  profile?: AssuranceProfile,
  options: { requireFreshBuildArtifacts?: boolean; outputIntegrity?: BuildOutputIntegrity; additionalBlockers?: readonly WorkspaceCheckBlocker[]; moduleInitializationComposition?: WorkspaceModuleInitializationComposition } = {},
  effectComposition?: WorkspaceEffectComposition,
  refinementComposition?: WorkspaceRefinementComposition,
): CheckWorkspaceJsonReport {
  const blockers: WorkspaceCheckBlocker[] = workspace.blockers.map((blocker) => ({
    kind: blocker.kind, classification: blocker.classification, projectFile: blocker.projectFile, message: blocker.message,
    ...(blocker.reference === undefined ? {} : { reference: blocker.reference }),
  }));
  blockers.push(...(options.additionalBlockers ?? []));
  if (options.requireFreshBuildArtifacts && workspace.buildArtifacts.status !== "fresh") blockers.push({
    kind: "build-artifact", classification: "unknown", projectFile: workspace.rootProjectFile,
    message: workspace.buildArtifacts.status === "stale"
      ? "TypeScript SolutionBuilder reports stale or missing composite build artifacts"
      : "TypeScript SolutionBuilder did not establish composite build-artifact freshness",
  });
  const outputIntegrity = options.outputIntegrity ?? { status: "not-checked" as const, outputs: [] };
  if (outputIntegrity.status !== "not-checked" && outputIntegrity.status !== "verified") {
    const failed = outputIntegrity.outputs.filter((output) => output.status !== "verified");
    if (failed.length === 0) blockers.push({ kind: "build-output", classification: "unknown", projectFile: workspace.rootProjectFile, message: outputIntegrity.message ?? "build output integrity is unknown" });
    for (const output of failed) blockers.push({ kind: "build-output", classification: "unknown", projectFile: output.projectFile ?? workspace.rootProjectFile, subject: output.fileName, message: output.message ?? `${output.kind} output integrity is unknown` });
  }
  const compositionBlockers: WorkspaceCheckBlocker[] = (effectComposition?.blockers ?? []).map((blocker) => ({ ...blocker }));
  blockers.push(...compositionBlockers);
  const refinementCompositionBlockers: WorkspaceCheckBlocker[] = (refinementComposition?.blockers ?? []).map((blocker) => ({ ...blocker }));
  blockers.push(...refinementCompositionBlockers);
  if (options.moduleInitializationComposition?.evidence !== undefined
    && options.moduleInitializationComposition.evidence !== "verified") {
    for (const unknown of options.moduleInitializationComposition.unknowns) blockers.push({
      kind: "module-initialization", classification: "unknown", projectFile: unknown.projectFile,
      subject: unknown.fileName, message: `${unknown.kind}: ${unknown.detail}`,
    });
  }
  const checkedConfigs = new Set(projects.flatMap((project) => project.project ? [project.project.projectFile] : []));
  if (profile) for (const project of workspace.projects) if (!checkedConfigs.has(project.projectFile) && project.provenance.compiler.parity !== "exact") blockers.push({
    kind: "typescript", classification: "unknown", projectFile: project.projectFile,
    message: project.provenance.compiler.reason ?? "consumer TypeScript compiler parity is unknown",
  });
  for (const project of projects) {
    if (project.assurance) for (const blocker of project.assurance.blockers) blockers.push({
      kind: blocker.kind, classification: blocker.classification, projectFile: project.project?.projectFile ?? blocker.fileName,
      message: blocker.message,
    });
    else if (project.outcome === "failed") blockers.push({
      kind: "project", classification: "violation", projectFile: project.project?.projectFile ?? "<project>",
      message: "the compiler domain emitted error diagnostics",
    });
  }
  const failed = blockers.length > 0 || projects.some((project) => project.outcome === "failed");
  const assurance = profile === undefined ? null : (() => {
    const status: AssuranceStatus = blockers.some((blocker) => blocker.classification === "violation") ? "violated"
      : blockers.length > 0 ? "unknown"
      : projects.some((project) => project.assurance?.status === "assumed") ? "assumed" : "verified";
    return {
      profile, status, passed: blockers.length === 0,
      blockers,
      claims: blockers.length === 0 ? [
        "every referenced compiler domain passed its selected assurance profile",
        "every selected source root belongs to exactly one checked TypeScript project",
        "every project config resolves the exact analyzer TypeScript version",
        ...((effectComposition?.links.length ?? 0) > 0 ? ["verified child-project function and module effects are composed into resolved parent calls and imports"] : []),
        ...((effectComposition?.links.length ?? 0) > 0 ? ["every declaration consumed by Effect composition exactly matches a same-compiler in-memory re-emission"] : []),
        ...((refinementComposition?.links.length ?? 0) > 0 ? ["verified child-project scalar refinement actions are composed through bounded resolved parent action call paths"] : []),
        ...((refinementComposition?.links.length ?? 0) > 0 ? ["every declaration consumed by refinement composition exactly matches a same-compiler in-memory re-emission"] : []),
        ...(options.moduleInitializationComposition?.evidence === "verified"
          ? ["one exact cross-project straight-line top-level-await dependency preserves async module completion order"] : []),
        ...(refinementComposition?.links.some((link) => link.runtimeIdentity?.kind === "host"
          && link.runtimeIdentity.host === "node")
          ? ["Node global refinement identities match an explicit Node major and realm label backed by the corresponding @types/node ambient global symbol"] : []),
        ...([...(effectComposition?.links ?? []), ...(refinementComposition?.links ?? [])].some((link) => link.declarationIntegrity.transform) ? ["every transformed source consumed by cross-project composition is an exact embedded TypeScript span bound to transform and compiler identity"] : []),
        ...(options.requireFreshBuildArtifacts ? ["TypeScript SolutionBuilder reports current composite build artifacts"] : []),
        ...(outputIntegrity.status === "verified" ? ["every TypeScript-emitted declaration and runtime JavaScript output exactly matches same-compiler in-memory re-emission"] : []),
      ] : [],
      exclusions: [
        "referenced projects are checked as separate Programs; no cross-project whole-program proof is claimed",
        "cross-project refinement composition is limited to scalar direct calls or at most two write-screened sole-call local helpers with exact declarations",
        "cross-project inaccessible/non-exported, host-alias, and cross-realm Mutate identities, plus unbounded iterator effect parameters, are not composed",
        "runtime realm labels are explicit user contracts, not proof that deployment contexts share an ECMAScript Realm",
        ...(options.requireFreshBuildArtifacts ? [] : ["composite build-artifact freshness was observed but not required"]),
        ...(outputIntegrity.status === "verified" ? [] : ["emitted runtime JavaScript bytes were not compared with the analyzed TypeScript sources"]),
        "declaration byte equality trusts the exact selected TypeScript compiler and is not an independently checkable compiler proof",
        "embedded TypeScript transform evidence covers only the exact selected source span; surrounding host syntax and runtime semantics are not verified",
        ...new Set(projects.flatMap((project) => project.assurance?.exclusions ?? [])),
      ],
    };
  })();
  return {
    schema: "uneffect-workspace-check/v1", outcome: failed ? "failed" : "passed",
    rootProjectFile: workspace.rootProjectFile, references: workspace.references, buildOrder: workspace.buildOrder,
    buildArtifacts: workspace.buildArtifacts, outputIntegrity,
    configs: workspace.projects.map((project) => ({ ...project.provenance, rootFiles: project.fileNames })), projects, blockers, assurance,
    effectComposition: {
      status: compositionBlockers.length > 0 ? "unknown" : (effectComposition?.links.length ?? 0) > 0 ? "verified" : "not-applicable",
      links: (effectComposition?.links ?? []).map(({ iteratorEffectBounds, mutationRoots, ...link }) => ({
        ...link, effects: link.effects.map(formatEffect),
        ...(iteratorEffectBounds ? { iteratorEffectBounds: iteratorEffectBounds.map((bound) => ({
          index: bound.index, name: bound.name, effects: bound.effects.map(formatEffect),
        })) } : {}),
        ...(mutationRoots ? { mutationRoots: mutationRoots.map((root) => {
          if (root.kind === "ambient") return root;
          const { declarationKey: _declarationKey, ...publicRoot } = root;
          return publicRoot;
        }) } : {}),
      })),
      blockers: compositionBlockers,
    },
    refinementComposition: {
      status: refinementCompositionBlockers.length > 0 ? "unknown" : (refinementComposition?.links.length ?? 0) > 0 ? "verified" : "not-applicable",
      links: [...(refinementComposition?.links ?? [])],
      blockers: refinementCompositionBlockers,
    },
    ...(options.moduleInitializationComposition
      ? { moduleInitializationComposition: options.moduleInitializationComposition } : {}),
  };
}
