import type { AssuranceAssessment } from "./assurance.js";
import { formatEffect } from "./capabilities.js";
import type { CheckResult } from "./check.js";
import type { VerificationArtifact } from "./contracts.js";
import { reportDiagnostic, type ReportedDiagnostic } from "./diagnostics.js";

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
  };
}
