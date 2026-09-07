import { executeZ3, type Z3ExecutionOptions } from "../backends/z3.js";
import { generateObligationSmt } from "./obligations.js";
import { describeObligation, explainCounterexample, obligationRule } from "./contract-explanations.js";
import type { InvariantObligation } from "./logic-contracts.js";
import type { VerificationArtifact, ContractDiagnostic, ContractVerificationResult } from "./verification-contracts.js";

function parseAssignments(model: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of model.matchAll(/\(define-fun\s+([^\s()]+)\s*\(\)\s+[^\s()]+\s+([^()\s]+|\([^)]*\))\)/g)) result[match[1]!] = match[2]!;
  return result;
}

function clauseOf(obligation: InvariantObligation): ContractDiagnostic["clause"] {
  return obligation.kind === "postcondition" ? "ensures" : obligation.kind === "call-precondition" ? "requires" : "invariant";
}

/** Discharge neutral obligations; frontend lowering and interprocedural reconciliation stay outside. */
export async function solveContractObligations(fileName: string, obligations: readonly InvariantObligation[],
  lineAt: (position: number) => number, z3?: Z3ExecutionOptions): Promise<ContractVerificationResult> {
  if (obligations.length === 0) return { diagnostics: [], artifacts: [] };
  const diagnostics: ContractDiagnostic[] = [];
  const artifacts: VerificationArtifact[] = [];
  for (const obligation of obligations) {
    const execution = await executeZ3(generateObligationSmt(obligation, false), { ...z3, produceModel: true });
    const status = execution.status;
    const solver = { backend: execution.backend, version: execution.version, attempts: execution.attempts };
    const base = { obligationId: obligation.id, source: { fileName, span: obligation.span }, obligation: { functionName: obligation.functionName, clause: clauseOf(obligation), source: obligation.source }, solver, controlFlow: obligation.controlFlow };
    if (status === "unsat") {
      artifacts.push({ ...base, status: "verified", evidence: "verified" });
    } else if (status === "sat") {
      const model = execution.model ?? "";
      const assignments = parseAssignments(model);
      const artifact: VerificationArtifact = { ...base, status: "counterexample", evidence: "unknown", counterexample: { raw: model, assignments } };
      artifacts.push(artifact);
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: clauseOf(obligation), line: lineAt(obligation.span.start), message: describeObligation(obligation), notes: [{ label: "rule", detail: obligationRule(obligation) }, ...explainCounterexample(obligation, assignments)], model, obligationId: obligation.id, artifact });
    } else {
      const detail = status === "error" ? `${execution.failureKind ?? "infrastructure failure"}: ${execution.stderr}` : status;
      const artifact: VerificationArtifact = { ...base, status: "unknown", evidence: "unknown", message: `Z3 returned ${detail} for ${clauseOf(obligation)} ${obligation.source}` };
      artifacts.push(artifact);
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: "unsupported", line: lineAt(obligation.span.start), message: artifact.message!, notes: [{ label: "because", detail: "the solver neither proved nor refuted this obligation, so the contract carries no evidence" }, { label: "hint", detail: "simplify the clause (nonlinear arithmetic and unbounded multiplication are the usual causes) or split it into smaller obligations" }], obligationId: obligation.id, artifact });
    }
  }
  return { diagnostics, artifacts };
}
