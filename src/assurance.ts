import type { CheckResult } from "./check.js";
import { formatEffect, unresolvedCapabilityReasons } from "./capabilities.js";
import type { AssumptionLedger } from "./assumptions.js";

export type AssuranceProfile = "no-unknown" | "declared" | "verified";
export type AssuranceStatus = "verified" | "assumed" | "unknown" | "violated";

export interface AssuranceBlocker {
  kind: "effect" | "contract" | "typed-array" | "ownership" | "async-iterator" | "resource" | "coverage" | "typescript" | "assumption";
  classification: "unknown" | "violation";
  fileName: string;
  functionName: string;
  message: string;
}

export interface AssuranceCoverage {
  effectSummaries: number;
  contractArtifacts: number;
  checkedFiles: number;
  uncoveredFiles: string[];
  assumptions: number;
  typedArrayObligations: number;
  typedArrayWindows: number;
  ownershipDiagnostics: number;
  asyncIteratorObligations: number;
  resourceProtocolObligations: number;
}

export interface AssuranceAssessment {
  profile: AssuranceProfile;
  /** `passed` is retained for compatibility; `status` preserves why it passed or failed. */
  status: AssuranceStatus;
  passed: boolean;
  blockers: AssuranceBlocker[];
  /** Counts the proof-relevant artifacts on which this assessment is based. */
  coverage: AssuranceCoverage;
  /** Claims established only when `passed` is true. */
  claims: readonly string[];
  /** Scope deliberately not established by this profile, even when it passes. */
  exclusions: readonly string[];
}

const commonClaims = [
  "selected TypeScript sources have no syntax, semantic, or compiler-option errors",
  "no emitted effect summary or capability scope is unknown",
  "every emitted contract artifact is verified",
] as const;

const commonExclusions = [
  "unannotated semantic domains are not checked by this profile",
  "module summaries are may-effect sets and do not prove exact import or top-level-await temporal ordering",
  "dependencies, dynamically loaded code, native addons, and unmodeled host behavior are outside the explicitly checked file boundary",
  "a verified bounded or assumption-dependent artifact is not an unbounded or assumption-free proof",
] as const;

/**
 * Assess only evidence emitted for the explicitly checked files. This does not
 * turn unannotated semantic domains or unsupported whole-program behavior into
 * a proof claim.
 */
export function assessCheckAssurance(
  result: Pick<CheckResult, "artifacts" | "summaries"> & Partial<Pick<CheckResult, "sources" | "diagnostics" | "project" | "typedArrays" | "ownership" | "asyncIterators" | "resourceProtocols">> & { assumptions?: AssumptionLedger },
  profile: AssuranceProfile,
): AssuranceAssessment {
  const blockers: AssuranceBlocker[] = [];
  const coveredFiles = new Set<string>();
  for (const summary of result.summaries) if (summary.fileName) coveredFiles.add(summary.fileName);
  for (const artifact of result.artifacts) coveredFiles.add(artifact.source.fileName);
  for (const [fileName, typed] of Object.entries(result.typedArrays?.files ?? {})) {
    if (typed.obligations.length || typed.windows.length) coveredFiles.add(fileName);
  }
  for (const iterator of result.asyncIterators ?? []) coveredFiles.add(iterator.fileName);
  for (const resource of result.resourceProtocols ?? []) coveredFiles.add(resource.fileName);
  const selectedFiles = [...(result.sources?.keys() ?? [])];
  const uncoveredFiles = selectedFiles.filter((fileName) => !coveredFiles.has(fileName));
  const coverage: AssuranceCoverage = {
    effectSummaries: result.summaries.length,
    contractArtifacts: result.artifacts.length,
    checkedFiles: selectedFiles.length,
    uncoveredFiles,
    assumptions: result.assumptions?.entries.length ?? 0,
    typedArrayObligations: result.typedArrays?.obligations.length ?? 0,
    typedArrayWindows: result.typedArrays?.windows.length ?? 0,
    ownershipDiagnostics: result.ownership?.length ?? 0,
    asyncIteratorObligations: result.asyncIterators?.length ?? 0,
    resourceProtocolObligations: result.resourceProtocols?.length ?? 0,
  };
  if (coverage.effectSummaries === 0 && coverage.contractArtifacts === 0
    && coverage.typedArrayObligations === 0 && coverage.typedArrayWindows === 0
    && coverage.asyncIteratorObligations === 0 && coverage.resourceProtocolObligations === 0) blockers.push({
    kind: "coverage", classification: "unknown", fileName: "<assessment>", functionName: "<coverage>",
    message: "no effect summary or contract artifact was emitted; the assurance claim would be vacuous",
  });
  if (result.project && result.project.compiler.parity !== "exact") blockers.push({
    kind: "typescript", classification: "unknown", fileName: result.project.projectFile, functionName: "<typescript-project>",
    message: result.project.compiler.reason ?? "consumer TypeScript compiler parity is unknown",
  });
  for (const diagnostic of result.diagnostics ?? []) if ("domain" in diagnostic && diagnostic.domain === "typescript" && diagnostic.severity === "error") blockers.push({
    kind: "typescript", classification: "violation", fileName: diagnostic.fileName, functionName: diagnostic.functionName,
    message: `${diagnostic.fileName}:${diagnostic.line}: ${diagnostic.message}`,
  });
  for (const diagnostic of result.diagnostics ?? []) if ("effect" in diagnostic && "severity" in diagnostic && diagnostic.severity === "error") blockers.push({
    kind: "effect", classification: "violation", fileName: diagnostic.fileName, functionName: diagnostic.functionName,
    message: diagnostic.message,
  });
  for (const fileName of uncoveredFiles) blockers.push({
    kind: "coverage", classification: "unknown", fileName, functionName: "<coverage>",
    message: `${fileName}: no proof-relevant evidence was emitted for this selected file`,
  });
  for (const summary of result.summaries) {
    if (summary.evidence === "unknown") blockers.push({
      kind: "effect", classification: "unknown", fileName: summary.fileName ?? "<unknown>", functionName: summary.functionName,
      message: `${summary.functionName}: effect summary is unknown${summary.unknownReasons?.length
        ? ` (${summary.unknownReasons.map((reason) => `${reason.code}: ${reason.message}`).join("; ")})` : ""}`,
    });
    else if ((profile === "declared" || profile === "verified") && summary.evidence !== "verified") blockers.push({
      kind: "effect", classification: "unknown", fileName: summary.fileName ?? "<unknown>", functionName: summary.functionName,
      message: `${summary.functionName}: effect summary is ${summary.evidence}, not declaration-checked`,
    });
    for (const effect of summary.effects) {
      const reasons = unresolvedCapabilityReasons(effect);
      if (reasons.length === 0) continue;
      blockers.push({
        kind: "effect", classification: "unknown", fileName: summary.fileName ?? "<unknown>", functionName: summary.functionName,
        message: `${summary.functionName}: ${formatEffect(effect)} contains an unknown capability scope (${reasons.join(", ")})`,
      });
    }
  }
  for (const artifact of result.artifacts) if (artifact.status !== "verified") blockers.push({
    kind: "contract", classification: artifact.status === "counterexample" ? "violation" : "unknown", fileName: artifact.source.fileName,
    functionName: artifact.obligation?.functionName ?? "<contract>",
    message: `${artifact.obligation?.functionName ?? "contract"}: contract evidence is ${artifact.status}, not verified`,
  });
  for (const obligation of result.typedArrays?.obligations ?? []) if (obligation.result === "unknown" || obligation.result === "counterexample") blockers.push({
    kind: "typed-array", classification: obligation.result === "counterexample" ? "violation" : "unknown",
    fileName: Object.entries(result.typedArrays?.files ?? {}).find(([, file]) => file.obligations.includes(obligation))?.[0] ?? "<typed-array>",
    functionName: obligation.functionName,
    message: `${obligation.functionName}: ${obligation.kind} evidence is ${obligation.result}`,
  });
  for (const window of result.typedArrays?.windows ?? []) if (window.result === "unknown") blockers.push({
    kind: "typed-array", classification: "unknown",
    fileName: Object.entries(result.typedArrays?.files ?? {}).find(([, file]) => file.windows.includes(window))?.[0] ?? "<typed-array>",
    functionName: window.functionName,
    message: `${window.functionName}: ${window.binding} window backing provenance is unknown`,
  });
  for (const diagnostic of result.ownership ?? []) blockers.push({
    kind: "ownership", classification: diagnostic.state === "unknown" ? "unknown" : "violation",
    fileName: diagnostic.fileName, functionName: "<ownership>", message: diagnostic.message,
  });
  for (const iterator of result.asyncIterators ?? []) {
    if (iterator.status === "unsatisfied") blockers.push({
      kind: "async-iterator", classification: "violation", fileName: iterator.fileName, functionName: iterator.owner,
      message: `${iterator.owner}: async iterator does not reach an accepted terminal state`,
    });
    else if (iterator.status === "unknown" || iterator.evidence === "unknown") blockers.push({
      kind: "async-iterator", classification: "unknown", fileName: iterator.fileName, functionName: iterator.owner,
      message: `${iterator.owner}: async-iterator cleanup evidence is unknown (${iterator.unknownReasons.join(", ") || "resource transition"})`,
    });
    else if (profile === "verified" && iterator.evidence === "trusted") blockers.push({
      kind: "async-iterator", classification: "unknown", fileName: iterator.fileName, functionName: iterator.owner,
      message: `${iterator.owner}: async-iterator ownership depends on a trusted callable contract`,
    });
  }
  for (const resource of result.resourceProtocols ?? []) {
    if (resource.status === "unsatisfied") blockers.push({
      kind: "resource", classification: "violation", fileName: resource.fileName, functionName: resource.owner,
      message: `${resource.owner}: ${resource.resource} does not reach an accepted terminal state`,
    });
    else if (resource.status === "unknown" || resource.evidence === "unknown") blockers.push({
      kind: "resource", classification: "unknown", fileName: resource.fileName, functionName: resource.owner,
      message: `${resource.owner}: resource lifecycle evidence is unknown for ${resource.resource}`,
    });
    else if (profile === "verified" && resource.evidence === "trusted") blockers.push({
      kind: "resource", classification: "unknown", fileName: resource.fileName, functionName: resource.owner,
      message: `${resource.owner}: resource lifecycle depends on a trusted callable contract`,
    });
  }
  if (profile === "verified") {
    if (!result.assumptions) blockers.push({
      kind: "assumption", classification: "unknown", fileName: "<assessment>", functionName: "<assumptions>",
      message: "the assumption ledger was not collected for this assurance boundary",
    });
    else for (const assumption of result.assumptions.entries) blockers.push({
      kind: "assumption", classification: "unknown", fileName: assumption.scope.fileName,
      functionName: assumption.scope.functionName ?? "<module>",
      message: `${assumption.domain} assumption: ${assumption.reason}`,
    });
  }
  const candidateClaims = profile === "declared" || profile === "verified"
    ? [...commonClaims, "every emitted function effect summary is declaration-checked"]
    : [...commonClaims];
  if (profile === "verified") candidateClaims.push("the emitted assumption ledger is empty");
  if (result.project?.compiler.parity === "exact") candidateClaims.push(
    "the consumer project and analyzer resolve the exact same TypeScript version",
  );
  if ((result.typedArrays?.obligations.length ?? 0) > 0) candidateClaims.push("every emitted typed-array obligation is verified or explicitly trusted");
  if ((result.typedArrays?.windows.length ?? 0) > 0) candidateClaims.push("every emitted typed-array window has non-unknown backing provenance");
  if ((result.asyncIterators?.length ?? 0) > 0) candidateClaims.push("every emitted async-iterator resource scenario reaches an accepted terminal state");
  if ((result.resourceProtocols?.length ?? 0) > 0) candidateClaims.push("every emitted general resource protocol reaches an accepted terminal state");
  const exclusions = profile === "no-unknown"
    ? [...commonExclusions, "inferred effects need not have an explicit upper-bound declaration"]
    : [...commonExclusions];
  if (!result.project) exclusions.push("consumer TypeScript compiler parity was not assessed because no --project boundary was supplied");
  const hasTrustedSummary = result.summaries.some((summary) => summary.evidence === "trusted");
  if (hasTrustedSummary) exclusions.push(
    "trusted effect summaries depend on reviewed contracts and are assumptions, not verified implementations",
  );
  if (result.summaries.some((summary) => summary.iteratorEffectParameters?.some((parameter) =>
    !summary.iteratorEffectBounds?.some((bound) => bound.index === parameter.index)))) {
    exclusions.push("unbounded iterator-effect parameters describe caller-supplied lazy effects and are not a closed concrete effect set");
  }
  const hasAssumptions = hasTrustedSummary || (result.assumptions?.entries.length ?? 0) > 0
    || (result.asyncIterators?.some((iterator) => iterator.evidence === "trusted") ?? false)
    || (result.resourceProtocols?.some((resource) => resource.evidence === "trusted") ?? false);
  const status: AssuranceStatus = blockers.some((blocker) => blocker.classification === "violation")
    ? "violated" : blockers.length > 0 ? "unknown" : hasAssumptions ? "assumed" : "verified";
  const claims = blockers.length === 0 ? candidateClaims : [];
  return { profile, status, passed: blockers.length === 0, blockers, coverage, claims, exclusions };
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatAssuranceAssessment(assessment: AssuranceAssessment): string {
  const header = `assurance ${assessment.profile}: ${assessment.passed ? "passed" : "failed"} (${assessment.status})`;
  const scope = "  scope: emitted evidence for explicitly checked files and opted-in annotations only";
  const coverage = `  coverage: ${countLabel(assessment.coverage.effectSummaries, "effect summary", "effect summaries")}, ${countLabel(assessment.coverage.contractArtifacts, "contract artifact")}, ${countLabel(assessment.coverage.typedArrayObligations, "typed-array obligation")}, ${countLabel(assessment.coverage.typedArrayWindows, "typed-array window")}, ${countLabel(assessment.coverage.ownershipDiagnostics, "ownership diagnostic")}, ${countLabel(assessment.coverage.asyncIteratorObligations, "async-iterator obligation")}, ${countLabel(assessment.coverage.resourceProtocolObligations, "resource-protocol obligation")}, ${countLabel(assessment.coverage.assumptions, "assumption")}, ${countLabel(assessment.coverage.checkedFiles, "selected file")}`;
  return `${[
    header,
    scope,
    coverage,
    ...assessment.claims.map((claim) => `  claim: ${claim}`),
    ...assessment.exclusions.map((exclusion) => `  excluded: ${exclusion}`),
    ...assessment.blockers.map((blocker) => `  blocker: ${blocker.message}`),
  ].join("\n")}\n`;
}
