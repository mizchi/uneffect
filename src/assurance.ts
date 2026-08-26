import type { CheckResult } from "./check.js";

export type AssuranceProfile = "no-unknown" | "declared";
export type AssuranceStatus = "verified" | "assumed" | "unknown" | "violated";

export interface AssuranceBlocker {
  kind: "effect" | "contract" | "coverage" | "typescript";
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
  "no emitted effect summary is unknown",
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
  result: Pick<CheckResult, "artifacts" | "summaries"> & Partial<Pick<CheckResult, "sources" | "diagnostics">>,
  profile: AssuranceProfile,
): AssuranceAssessment {
  const blockers: AssuranceBlocker[] = [];
  const coveredFiles = new Set<string>();
  for (const summary of result.summaries) if (summary.fileName) coveredFiles.add(summary.fileName);
  for (const artifact of result.artifacts) coveredFiles.add(artifact.source.fileName);
  const selectedFiles = [...(result.sources?.keys() ?? [])];
  const uncoveredFiles = selectedFiles.filter((fileName) => !coveredFiles.has(fileName));
  const coverage: AssuranceCoverage = {
    effectSummaries: result.summaries.length,
    contractArtifacts: result.artifacts.length,
    checkedFiles: selectedFiles.length,
    uncoveredFiles,
  };
  if (coverage.effectSummaries === 0 && coverage.contractArtifacts === 0) blockers.push({
    kind: "coverage", classification: "unknown", fileName: "<assessment>", functionName: "<coverage>",
    message: "no effect summary or contract artifact was emitted; the assurance claim would be vacuous",
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
      message: `${summary.functionName}: effect summary is unknown`,
    });
    else if (profile === "declared" && summary.evidence !== "verified") blockers.push({
      kind: "effect", classification: "unknown", fileName: summary.fileName ?? "<unknown>", functionName: summary.functionName,
      message: `${summary.functionName}: effect summary is ${summary.evidence}, not declaration-checked`,
    });
  }
  for (const artifact of result.artifacts) if (artifact.status !== "verified") blockers.push({
    kind: "contract", classification: artifact.status === "counterexample" ? "violation" : "unknown", fileName: artifact.source.fileName,
    functionName: artifact.obligation?.functionName ?? "<contract>",
    message: `${artifact.obligation?.functionName ?? "contract"}: contract evidence is ${artifact.status}, not verified`,
  });
  const claims = profile === "declared"
    ? [...commonClaims, "every emitted function effect summary is declaration-checked"]
    : [...commonClaims];
  const exclusions = profile === "no-unknown"
    ? [...commonExclusions, "inferred effects need not have an explicit upper-bound declaration"]
    : [...commonExclusions];
  const hasTrustedSummary = result.summaries.some((summary) => summary.evidence === "trusted");
  if (hasTrustedSummary) exclusions.push(
    "trusted effect summaries depend on reviewed contracts and are assumptions, not verified implementations",
  );
  if (result.summaries.some((summary) => summary.iteratorEffectParameters?.some((parameter) =>
    !summary.iteratorEffectBounds?.some((bound) => bound.index === parameter.index)))) {
    exclusions.push("unbounded iterator-effect parameters describe caller-supplied lazy effects and are not a closed concrete effect set");
  }
  const status: AssuranceStatus = blockers.some((blocker) => blocker.classification === "violation")
    ? "violated" : blockers.length > 0 ? "unknown" : hasTrustedSummary ? "assumed" : "verified";
  return { profile, status, passed: blockers.length === 0, blockers, coverage, claims, exclusions };
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatAssuranceAssessment(assessment: AssuranceAssessment): string {
  const header = `assurance ${assessment.profile}: ${assessment.passed ? "passed" : "failed"} (${assessment.status})`;
  const scope = "  scope: emitted evidence for explicitly checked files and opted-in annotations only";
  const coverage = `  coverage: ${countLabel(assessment.coverage.effectSummaries, "effect summary", "effect summaries")}, ${countLabel(assessment.coverage.contractArtifacts, "contract artifact")}, ${countLabel(assessment.coverage.checkedFiles, "selected file")}`;
  return `${[
    header,
    scope,
    coverage,
    ...assessment.claims.map((claim) => `  claim${assessment.passed ? "" : " (not established)"}: ${claim}`),
    ...assessment.exclusions.map((exclusion) => `  excluded: ${exclusion}`),
    ...assessment.blockers.map((blocker) => `  blocker: ${blocker.message}`),
  ].join("\n")}\n`;
}
