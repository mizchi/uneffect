import { formatEffect } from "./capabilities.js";
import type { AssuranceAssessment } from "./assurance.js";
import type { CorsaCheckResult } from "./corsa-check.js";
import type { EffectBaselineAssessment } from "./effect-baseline.js";

export interface CorsaCheckJsonReport {
  schema: "uneffect-check/v1";
  outcome: "passed" | "failed";
  counts: { errors: number; warnings: number };
  diagnostics: CorsaCheckResult["diagnostics"];
  effects: Array<{
    fileName?: string;
    span?: { start: number; end: number };
    functionName: string;
    effects: string[];
    evidence: CorsaCheckResult["summaries"][number]["evidence"];
    parameters?: string[];
    unknownReasons?: CorsaCheckResult["summaries"][number]["unknownReasons"];
  }>;
  contracts: [];
  assumptions: CorsaCheckResult["assumptions"];
  typedArrays: { obligations: []; windows: []; statistics: { solverQueries: number } };
  ownership: [];
  asyncIterators: [];
  resourceProtocols: [];
  assurance: AssuranceAssessment | null;
  project: CorsaCheckResult["project"];
  effectBaseline?: EffectBaselineAssessment;
}

export function createCorsaCheckJsonReport(
  result: CorsaCheckResult,
  assurance?: AssuranceAssessment,
): CorsaCheckJsonReport {
  const passed = result.errors === 0 && (assurance?.passed ?? true);
  return {
    schema: "uneffect-check/v1",
    outcome: passed ? "passed" : "failed",
    counts: { errors: result.errors, warnings: result.warnings },
    diagnostics: result.diagnostics,
    effects: result.summaries.map((summary) => ({
      ...(summary.fileName === undefined ? {} : { fileName: summary.fileName }),
      ...(summary.span === undefined ? {} : { span: summary.span }),
      functionName: summary.functionName,
      effects: summary.effects.map(formatEffect),
      evidence: summary.evidence,
      ...(summary.parameters === undefined ? {} : { parameters: summary.parameters }),
      ...(summary.unknownReasons === undefined ? {} : { unknownReasons: summary.unknownReasons }),
    })),
    contracts: [],
    assumptions: result.assumptions,
    typedArrays: {
      obligations: result.typedArrays.obligations,
      windows: result.typedArrays.windows,
      statistics: result.typedArrays.statistics,
    },
    ownership: [],
    asyncIterators: [],
    resourceProtocols: [],
    assurance: assurance ?? null,
    project: result.project,
  };
}

export function formatCorsaCheckEvidence(result: CorsaCheckResult): string {
  return result.summaries.map((summary) => {
    const effects = summary.effects.map(formatEffect).join(" | ") || "none";
    return `effects ${summary.functionName}: ${effects} (${summary.evidence})\n`;
  }).join("");
}
