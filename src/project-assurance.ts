import type { VerifyUneffectProjectResult } from "./project-verification.js";
import { formatEffect, unresolvedCapabilityReasons } from "./capabilities.js";
import type { TypeScriptProjectProvenance } from "./typescript-project.js";

export type ProjectAssuranceDomain = "typescript" | "effect" | "contract" | "typed-array" | "ownership" | "iterator" | "resource" | "instrument" | "assumption" | "temporal" | "module-initialization" | "coverage";

export interface ProjectAssuranceBlocker {
  domain: ProjectAssuranceDomain;
  classification: "unknown" | "violation";
  fileName: string;
  subject: string;
  message: string;
}

export interface ProjectAssuranceCoverage {
  checkedFiles: number;
  effectSummaries: number;
  contractObligations: number;
  typedArrayObligations: number;
  trustedTypedArrayObligations: number;
  iteratorObligations: number;
  resourceProtocolObligations: number;
  temporalProperties: number;
  moduleInitializationModels: number;
}

export interface ProjectAssuranceAssessment {
  status: "verified" | "assumed" | "unknown" | "violated";
  passed: boolean;
  /** Number of explicit trusted boundaries in the accompanying assumption ledger. */
  assumptions: number;
  blockers: ProjectAssuranceBlocker[];
  coverage: ProjectAssuranceCoverage;
  /** Claims established only when `passed` is true. */
  claims: readonly string[];
  /** Boundaries deliberately outside the assessment, even when it passes. */
  exclusions: readonly string[];
}

export const PROJECT_ASSURANCE_SELECTED_FILES_EXCLUSION = "this assessment covers only explicitly supplied files and analyses represented in this result";
export const PROJECT_ASSURANCE_SINGLE_DOMAIN_EXCLUSION = "this result covers one tsconfig compiler domain; referenced domains require workspace aggregation";

type AssessmentInput = Omit<VerifyUneffectProjectResult, "assurance">;

/**
 * Collapse every project verifier into one conservative acceptance decision.
 * This is evidence aggregation, not a whole-program proof.
 */
export function assessProjectVerification(
  result: AssessmentInput,
  checkedFiles: readonly string[],
  project?: TypeScriptProjectProvenance,
): ProjectAssuranceAssessment {
  const blockers: ProjectAssuranceBlocker[] = [];
  const add = (domain: ProjectAssuranceDomain, classification: "unknown" | "violation", fileName: string, subject: string, message: string): void => {
    blockers.push({ domain, classification, fileName, subject, message });
  };

  if (project && project.compiler.parity !== "exact") add(
    "typescript", "unknown", project.projectFile, "compiler-parity",
    project.compiler.reason ?? "consumer TypeScript compiler parity is unknown",
  );

  for (const diagnostic of result.diagnostics) {
    if ("domain" in diagnostic && diagnostic.domain === "typescript") {
      if (diagnostic.severity === "error") add("typescript", "violation", diagnostic.fileName, `TS${diagnostic.typescriptCode}`, diagnostic.message);
      continue;
    }
    if ("effect" in diagnostic && "severity" in diagnostic) {
      if (diagnostic.severity === "error") add("effect", "violation", diagnostic.fileName, diagnostic.functionName, diagnostic.message);
      continue;
    }
    if ("kind" in diagnostic && diagnostic.kind === "ownership") {
      add("ownership", "violation", diagnostic.fileName, diagnostic.resource, diagnostic.message);
      continue;
    }
    if ("kind" in diagnostic && diagnostic.kind === "assumption-policy") {
      add("assumption", "violation", diagnostic.fileName, diagnostic.functionName, diagnostic.message);
      continue;
    }
    if ("parameter" in diagnostic && "line" in diagnostic) {
      add("instrument", "unknown", diagnostic.fileName, diagnostic.parameter, diagnostic.message);
    }
  }

  for (const summary of result.effects.summaries) {
    if (summary.evidence === "unknown") {
      add("effect", "unknown", summary.fileName ?? "<unknown>", summary.functionName,
        `${summary.functionName}: effect evidence is unknown${summary.unknownReasons?.length
          ? ` (${summary.unknownReasons.map((reason) => `${reason.code}: ${reason.message}`).join("; ")})` : ""}`);
    }
    for (const effect of summary.effects) for (const reason of unresolvedCapabilityReasons(effect)) {
      add("effect", "unknown", summary.fileName ?? "<unknown>", summary.functionName,
        `${summary.functionName}: ${formatEffect(effect)} has unknown capability scope (${reason})`);
    }
  }
  for (const obligation of result.obligations) if (obligation.result !== "verified") {
    add("contract", obligation.result === "counterexample" ? "violation" : "unknown", obligation.source.fileName, obligation.obligation?.functionName ?? obligation.obligationId,
      obligation.message ?? `contract evidence is ${obligation.result}`);
  }
  for (const [fileName, file] of Object.entries(result.typedArrays.files)) for (const obligation of file.obligations) {
    if (obligation.result === "counterexample" || obligation.result === "unknown") {
      add("typed-array", obligation.result === "counterexample" ? "violation" : "unknown", fileName, obligation.functionName, `${obligation.kind} evidence is ${obligation.result}`);
    }
  }
  for (const property of result.temporal?.properties ?? []) if (property.result !== "verified") {
    add("temporal", property.result === "counterexample" ? "violation" : "unknown", property.fileName, property.name, property.output || `temporal property is ${property.result}`);
  }
  for (const iterator of result.asyncIterators) {
    if (iterator.status === "unsatisfied") add("iterator", "violation", iterator.fileName, iterator.owner,
      `${iterator.owner}: iterator does not reach an accepted terminal state`);
    else if (iterator.status === "unknown" || iterator.evidence === "unknown") add("iterator", "unknown", iterator.fileName, iterator.owner,
      `${iterator.owner}: iterator cleanup evidence is unknown (${iterator.unknownReasons.join(", ") || "resource transition"})`);
  }
  for (const resource of result.resourceProtocols) {
    if (resource.status === "unsatisfied") add("resource", "violation", resource.fileName, resource.owner,
      `${resource.owner}: ${resource.resource} does not reach an accepted terminal state`);
    else if (resource.status === "unknown" || resource.evidence === "unknown") add("resource", "unknown", resource.fileName, resource.owner,
      `${resource.owner}: resource lifecycle evidence is unknown for ${resource.resource}`);
  }
  for (const unknown of result.moduleInitialization?.unknowns ?? []) {
    add("module-initialization", "unknown", unknown.fileName, unknown.kind, unknown.detail);
  }

  const coveredFiles = new Set(result.effects.summaries.flatMap((summary) => summary.fileName ? [summary.fileName] : []));
  for (const obligation of result.obligations) coveredFiles.add(obligation.source.fileName);
  for (const fileName of Object.keys(result.typedArrays.files)) coveredFiles.add(fileName);
  for (const iterator of result.asyncIterators) coveredFiles.add(iterator.fileName);
  for (const resource of result.resourceProtocols) coveredFiles.add(resource.fileName);
  for (const fileName of checkedFiles) if (!coveredFiles.has(fileName)) {
    add("coverage", "unknown", fileName, "<coverage>", "no effect summary, contract obligation, or typed-array obligation was emitted for this file");
  }
  if (checkedFiles.length === 0) add("coverage", "unknown", "<project>", "<coverage>", "the project contains no selected files");

  const typedArrayObligations = Object.values(result.typedArrays.files).flatMap((file) => file.obligations);
  const coverage: ProjectAssuranceCoverage = {
    checkedFiles: checkedFiles.length,
    effectSummaries: result.effects.summaries.length,
    contractObligations: result.obligations.length,
    typedArrayObligations: typedArrayObligations.length,
    trustedTypedArrayObligations: typedArrayObligations.filter((item) => item.result === "trusted").length,
    iteratorObligations: result.asyncIterators.length,
    resourceProtocolObligations: result.resourceProtocols.length,
    temporalProperties: result.temporal?.properties.length ?? 0,
    moduleInitializationModels: result.moduleInitialization ? 1 : 0,
  };
  const candidateClaims = [
    "selected TypeScript sources have no syntax, semantic, or compiler-option errors",
    "no emitted effect summary or capability scope is unknown and no effect upper bound is violated",
    "every emitted contract obligation is verified",
    "every emitted typed-array obligation is verified or explicitly trusted",
    "no modeled ownership violation was found",
    ...(result.asyncIterators.length > 0 ? ["every emitted iterator resource scenario reaches an accepted terminal state"] : []),
    ...(result.resourceProtocols.length > 0 ? ["every emitted general resource protocol reaches an accepted terminal state"] : []),
    "runtime assertion generation emitted no unsupported-boundary diagnostic",
    "the configured assumption policy has no violation",
    ...(result.temporal ? ["every emitted temporal property is verified for its attributed source"] : []),
    ...(result.moduleInitialization ? ["the selected ESM module-initialization partial-order extraction is proof-grade"] : []),
    ...(project ? ["the compiler domain resolves the exact analyzer TypeScript version"] : []),
  ];
  const hasOpenIteratorEffect = result.effects.summaries.some((summary) => summary.iteratorEffectParameters?.some((parameter) =>
    !summary.iteratorEffectBounds?.some((bound) => bound.index === parameter.index)));
  const exclusions = [
    PROJECT_ASSURANCE_SELECTED_FILES_EXCLUSION,
    ...(project ? [PROJECT_ASSURANCE_SINGLE_DOMAIN_EXCLUSION]
      : ["the in-memory project API does not establish consumer tsconfig or TypeScript package-version parity"]),
    "inferred effects need not have an explicit declaration",
    ...(hasOpenIteratorEffect ? ["unbounded iterator-effect parameters describe caller-supplied lazy effects and are not a closed concrete effect set"] : []),
    "trusted typed-array, builtin, and module-initialization contracts remain assumptions, not derived proofs",
    "emitted JavaScript is an adoption artifact and is not itself verified",
    ...(result.temporal ? [] : ["temporal behavior was not checked because no temporal runtime was selected"]),
    ...(result.moduleInitialization ? result.moduleInitialization.exclusions : ["ESM module-initialization order was not checked because no entry module was selected"]),
  ];
  const assumptions = result.assumptions.entries.length;
  const status: ProjectAssuranceAssessment["status"] = blockers.some((blocker) => blocker.classification === "violation")
    ? "violated" : blockers.length > 0 ? "unknown" : assumptions > 0 ? "assumed" : "verified";
  const claims = blockers.length === 0 ? candidateClaims : [];
  return { status, passed: blockers.length === 0, assumptions, blockers, coverage, claims, exclusions };
}
