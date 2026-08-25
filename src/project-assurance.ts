import type { VerifyUneffectProjectResult } from "./project-verification.js";

export type ProjectAssuranceDomain = "typescript" | "effect" | "contract" | "typed-array" | "ownership" | "instrument" | "assumption" | "temporal" | "coverage";

export interface ProjectAssuranceBlocker {
  domain: ProjectAssuranceDomain;
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
  temporalProperties: number;
}

export interface ProjectAssuranceAssessment {
  passed: boolean;
  blockers: ProjectAssuranceBlocker[];
  coverage: ProjectAssuranceCoverage;
  /** Claims established only when `passed` is true. */
  claims: readonly string[];
  /** Boundaries deliberately outside the assessment, even when it passes. */
  exclusions: readonly string[];
}

type AssessmentInput = Omit<VerifyUneffectProjectResult, "assurance">;

/**
 * Collapse every project verifier into one conservative acceptance decision.
 * This is evidence aggregation, not a whole-program proof.
 */
export function assessProjectVerification(
  result: AssessmentInput,
  checkedFiles: readonly string[],
): ProjectAssuranceAssessment {
  const blockers: ProjectAssuranceBlocker[] = [];
  const add = (domain: ProjectAssuranceDomain, fileName: string, subject: string, message: string): void => {
    blockers.push({ domain, fileName, subject, message });
  };

  for (const diagnostic of result.diagnostics) {
    if ("domain" in diagnostic && diagnostic.domain === "typescript") {
      if (diagnostic.severity === "error") add("typescript", diagnostic.fileName, `TS${diagnostic.typescriptCode}`, diagnostic.message);
      continue;
    }
    if ("effect" in diagnostic && "severity" in diagnostic) {
      if (diagnostic.severity === "error") add("effect", diagnostic.fileName, diagnostic.functionName, diagnostic.message);
      continue;
    }
    if ("kind" in diagnostic && diagnostic.kind === "ownership") {
      add("ownership", diagnostic.fileName, diagnostic.resource, diagnostic.message);
      continue;
    }
    if ("kind" in diagnostic && diagnostic.kind === "assumption-policy") {
      add("assumption", diagnostic.fileName, diagnostic.functionName, diagnostic.message);
      continue;
    }
    if ("parameter" in diagnostic && "line" in diagnostic) {
      add("instrument", diagnostic.fileName, diagnostic.parameter, diagnostic.message);
    }
  }

  for (const summary of result.effects.summaries) if (summary.evidence === "unknown") {
    add("effect", summary.fileName ?? "<unknown>", summary.functionName, `${summary.functionName}: effect evidence is unknown`);
  }
  for (const obligation of result.obligations) if (obligation.result !== "verified") {
    add("contract", obligation.source.fileName, obligation.obligation?.functionName ?? obligation.obligationId,
      obligation.message ?? `contract evidence is ${obligation.result}`);
  }
  for (const [fileName, file] of Object.entries(result.typedArrays.files)) for (const obligation of file.obligations) {
    if (obligation.result === "counterexample" || obligation.result === "unknown") {
      add("typed-array", fileName, obligation.functionName, `${obligation.kind} evidence is ${obligation.result}`);
    }
  }
  for (const property of result.temporal?.properties ?? []) if (property.result !== "verified") {
    add("temporal", property.fileName, property.name, property.output || `temporal property is ${property.result}`);
  }

  const coveredFiles = new Set(result.effects.summaries.flatMap((summary) => summary.fileName ? [summary.fileName] : []));
  for (const obligation of result.obligations) coveredFiles.add(obligation.source.fileName);
  for (const fileName of Object.keys(result.typedArrays.files)) coveredFiles.add(fileName);
  for (const fileName of checkedFiles) if (!coveredFiles.has(fileName)) {
    add("coverage", fileName, "<coverage>", "no effect summary, contract obligation, or typed-array obligation was emitted for this file");
  }
  if (checkedFiles.length === 0) add("coverage", "<project>", "<coverage>", "the project contains no selected files");

  const typedArrayObligations = Object.values(result.typedArrays.files).flatMap((file) => file.obligations);
  const coverage: ProjectAssuranceCoverage = {
    checkedFiles: checkedFiles.length,
    effectSummaries: result.effects.summaries.length,
    contractObligations: result.obligations.length,
    typedArrayObligations: typedArrayObligations.length,
    trustedTypedArrayObligations: typedArrayObligations.filter((item) => item.result === "trusted").length,
    temporalProperties: result.temporal?.properties.length ?? 0,
  };
  const claims = [
    "selected TypeScript sources have no syntax, semantic, or compiler-option errors",
    "no emitted effect summary is unknown and no effect upper bound is violated",
    "every emitted contract obligation is verified",
    "every emitted typed-array obligation is verified or explicitly trusted",
    "no modeled ownership violation was found",
    "runtime assertion generation emitted no unsupported-boundary diagnostic",
    "the configured assumption policy has no violation",
    ...(result.temporal ? ["every emitted temporal property is verified for its attributed source"] : []),
  ];
  const hasOpenIteratorEffect = result.effects.summaries.some((summary) => summary.iteratorEffectParameters?.some((parameter) =>
    !summary.iteratorEffectBounds?.some((bound) => bound.index === parameter.index)));
  const exclusions = [
    "this assessment covers only explicitly supplied files and analyses represented in this result",
    "inferred effects need not have an explicit declaration",
    ...(hasOpenIteratorEffect ? ["unbounded iterator-effect parameters describe caller-supplied lazy effects and are not a closed concrete effect set"] : []),
    "trusted typed-array and builtin contracts remain assumptions, not derived proofs",
    "emitted JavaScript is an adoption artifact and is not itself verified",
    ...(result.temporal ? [] : ["temporal behavior was not checked because no temporal runtime was selected"]),
  ];
  return { passed: blockers.length === 0, blockers, coverage, claims, exclusions };
}
