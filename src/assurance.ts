import type { CheckResult } from "./check.js";

export type AssuranceProfile = "no-unknown" | "declared";

export interface AssuranceBlocker {
  kind: "effect" | "contract";
  fileName: string;
  functionName: string;
  message: string;
}

export interface AssuranceAssessment {
  profile: AssuranceProfile;
  passed: boolean;
  blockers: AssuranceBlocker[];
}

/**
 * Assess only evidence emitted for the explicitly checked files. This does not
 * turn unannotated semantic domains or unsupported whole-program behavior into
 * a proof claim.
 */
export function assessCheckAssurance(
  result: Pick<CheckResult, "artifacts" | "summaries">,
  profile: AssuranceProfile,
): AssuranceAssessment {
  const blockers: AssuranceBlocker[] = [];
  for (const summary of result.summaries) {
    if (summary.evidence === "unknown") blockers.push({
      kind: "effect", fileName: summary.fileName ?? "<unknown>", functionName: summary.functionName,
      message: `${summary.functionName}: effect summary is unknown`,
    });
    else if (profile === "declared" && summary.evidence !== "verified") blockers.push({
      kind: "effect", fileName: summary.fileName ?? "<unknown>", functionName: summary.functionName,
      message: `${summary.functionName}: effect summary is ${summary.evidence}, not declaration-checked`,
    });
  }
  for (const artifact of result.artifacts) if (artifact.status !== "verified") blockers.push({
    kind: "contract", fileName: artifact.source.fileName,
    functionName: artifact.obligation?.functionName ?? "<contract>",
    message: `${artifact.obligation?.functionName ?? "contract"}: contract evidence is ${artifact.status}, not verified`,
  });
  return { profile, passed: blockers.length === 0, blockers };
}

export function formatAssuranceAssessment(assessment: AssuranceAssessment): string {
  const header = `assurance ${assessment.profile}: ${assessment.passed ? "passed" : "failed"}`;
  const scope = "  scope: emitted evidence for explicitly checked files and opted-in annotations only";
  return `${[header, scope, ...assessment.blockers.map((blocker) => `  blocker: ${blocker.message}`)].join("\n")}\n`;
}
