import { createHash } from "node:crypto";
import ts from "typescript";
import { analyzeIteratorCleanupInProgram, type AsyncIteratorCleanup } from "./async-iterator-cleanup.js";
import type { AssumptionEntry } from "./assumptions.js";
import type { AsyncIteratorCheckerDiagnostic } from "./diagnostics.js";
import { evaluateResourceProtocol } from "./resource-protocol.js";

export interface IteratorCheckEvidence extends AsyncIteratorCleanup {
  fileName: string;
  status: "satisfied" | "unsatisfied" | "unknown";
  evidence: "exact" | "trusted" | "unknown";
}

export interface IteratorCheckResult {
  evidence: IteratorCheckEvidence[];
  diagnostics: AsyncIteratorCheckerDiagnostic[];
  assumptions: AssumptionEntry[];
}

/** One shared iterator ownership decision used by CLI and project verification. */
export function collectIteratorChecks(
  program: ts.Program,
  source: ts.SourceFile,
  mode: "gradual" | "strict" = "strict",
  sourceValid = true,
): IteratorCheckResult {
  const evidence: IteratorCheckEvidence[] = [];
  const diagnostics: AsyncIteratorCheckerDiagnostic[] = [];
  const assumptions: AssumptionEntry[] = [];
  for (const cleanup of analyzeIteratorCleanupInProgram(program, source)) {
    const evaluations = cleanup.scenarios.map((scenario) => evaluateResourceProtocol(scenario.model));
    const status = !sourceValid ? "unknown" as const
      : evaluations.some((evaluation) => evaluation.status === "unknown") ? "unknown" as const
      : evaluations.some((evaluation) => evaluation.status === "unsatisfied") ? "unsatisfied" as const : "satisfied" as const;
    const trusted = cleanup.scenarios.some((scenario) => scenario.model.transitions.some((transition) => transition.evidence === "trusted"));
    const itemEvidence = status !== "satisfied" || cleanup.unknownReasons.length > 0 ? "unknown" as const
      : trusted ? "trusted" as const : "exact" as const;
    const item: IteratorCheckEvidence = { ...cleanup, fileName: source.fileName, status, evidence: itemEvidence };
    evidence.push(item);
    if (itemEvidence === "trusted") {
      const input = {
        domain: "resource-callable" as const,
        reason: "trusted resource callable contract used by iterator ownership analysis",
        owner: "source declaration",
        scope: { fileName: source.fileName, functionName: cleanup.owner, span: cleanup.loopSpan },
      };
      assumptions.push({ ...input, id: createHash("sha256").update(JSON.stringify(input)).digest("hex"), evidence: "trusted" });
    }
    if (status === "satisfied" && cleanup.unknownReasons.length === 0) continue;
    const kind = status === "unsatisfied" ? "unclosed" as const : "unknown-cleanup" as const;
    const reasons = !sourceValid ? "TypeScript diagnostics invalidate source-level iterator evidence"
      : cleanup.unknownReasons.length > 0 ? cleanup.unknownReasons.join(", ")
      : evaluations.flatMap((evaluation) => evaluation.diagnostics.map((diagnostic) => diagnostic.message)).join("; ") || status;
    diagnostics.push({
      domain: "async-iterator", kind,
      severity: kind === "unclosed" || mode === "strict" ? "error" : "warning",
      fileName: source.fileName,
      line: source.getLineAndCharacterOfPosition(cleanup.loopSpan.start).line + 1,
      functionName: cleanup.owner,
      message: kind === "unclosed" ? `${cleanup.owner} leaves ${cleanup.iterable} without a required terminal iterator state`
        : `${cleanup.owner} has unknown iterator cleanup evidence: ${reasons}`,
      notes: [{ label: "resource", detail: cleanup.resource }, { label: "because", detail: reasons }],
    });
  }
  return { evidence, diagnostics, assumptions };
}
