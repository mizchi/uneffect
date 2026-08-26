import type { AssuranceAssessment } from "./assurance.js";
import { formatEffect } from "./capabilities.js";
import type { CheckResult } from "./check.js";
import type { VerificationArtifact } from "./contracts.js";
import { reportDiagnostic, type ReportedDiagnostic } from "./diagnostics.js";
import type { TypeScriptProjectProvenance } from "./typescript-project.js";
import type { AssuranceProfile, AssuranceStatus } from "./assurance.js";
import type { TypeScriptWorkspace } from "./typescript-project.js";

export interface CheckReportEffect {
  id?: string;
  fileName?: string;
  span?: { start: number; end: number };
  functionName: string;
  effects: string[];
  evidence: "verified" | "trusted" | "inferred" | "unknown";
  iteratorEffectParameters?: Array<{ index: number; name: string; convertsThrowToRejection: boolean }>;
  iteratorEffectBounds?: Array<{ index: number; name: string; effects: string[] }>;
}

/** Stable CLI interchange shape. Internal TypeScript nodes and solver objects are never exposed. */
export interface CheckJsonReport {
  schema: "uneffect-check/v1";
  outcome: "passed" | "failed";
  counts: { errors: number; warnings: number };
  diagnostics: ReportedDiagnostic[];
  effects: CheckReportEffect[];
  contracts: VerificationArtifact[];
  assurance: AssuranceAssessment | null;
  project: TypeScriptProjectProvenance | null;
}

export interface WorkspaceCheckBlocker {
  kind: string;
  classification: "unknown" | "violation";
  projectFile: string;
  message: string;
  reference?: string;
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
  configs: Array<TypeScriptProjectProvenance & { rootFiles: string[] }>;
  projects: CheckJsonReport[];
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
      ...(summary.iteratorEffectParameters === undefined ? {} : { iteratorEffectParameters: summary.iteratorEffectParameters }),
      ...(summary.iteratorEffectBounds === undefined ? {} : {
        iteratorEffectBounds: summary.iteratorEffectBounds.map((bound) => ({
          index: bound.index, name: bound.name, effects: bound.effects.map(formatEffect),
        })),
      }),
    })),
    contracts: result.artifacts,
    assurance: assurance ?? null,
    project: result.project ?? null,
  };
}

/** Aggregate independent compiler domains without pretending they formed one TypeScript Program. */
export function createCheckWorkspaceJsonReport(
  workspace: TypeScriptWorkspace,
  projects: CheckJsonReport[],
  profile?: AssuranceProfile,
  options: { requireFreshBuildArtifacts?: boolean } = {},
): CheckWorkspaceJsonReport {
  const blockers: WorkspaceCheckBlocker[] = workspace.blockers.map((blocker) => ({
    kind: blocker.kind, classification: blocker.classification, projectFile: blocker.projectFile, message: blocker.message,
    ...(blocker.reference === undefined ? {} : { reference: blocker.reference }),
  }));
  if (options.requireFreshBuildArtifacts && workspace.buildArtifacts.status !== "fresh") blockers.push({
    kind: "build-artifact", classification: "unknown", projectFile: workspace.rootProjectFile,
    message: workspace.buildArtifacts.status === "stale"
      ? "TypeScript SolutionBuilder reports stale or missing composite build artifacts"
      : "TypeScript SolutionBuilder did not establish composite build-artifact freshness",
  });
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
        ...(options.requireFreshBuildArtifacts ? ["TypeScript SolutionBuilder reports current composite build artifacts"] : []),
      ] : [],
      exclusions: [
        "referenced projects are checked as separate Programs; no cross-project whole-program proof is claimed",
        ...(options.requireFreshBuildArtifacts ? [] : ["composite build-artifact freshness was observed but not required"]),
        "declaration output content integrity and semantic equivalence are not independently validated",
        ...new Set(projects.flatMap((project) => project.assurance?.exclusions ?? [])),
      ],
    };
  })();
  return {
    schema: "uneffect-workspace-check/v1", outcome: failed ? "failed" : "passed",
    rootProjectFile: workspace.rootProjectFile, references: workspace.references, buildOrder: workspace.buildOrder,
    buildArtifacts: workspace.buildArtifacts,
    configs: workspace.projects.map((project) => ({ ...project.provenance, rootFiles: project.fileNames })), projects, blockers, assurance,
  };
}
