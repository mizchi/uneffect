import ts from "typescript";
import type { DiagnosticNote } from "./diagnostics.js";
import { describeObligation, explainCounterexample, obligationRule } from "./contract-explanations.js";
import { generateObligationSmt, InvariantLoweringError, lowerInvariantProgram, type ContractControlFlowEvidence, type InvariantObligation } from "./invariant-ir.js";
import { executeZ3, type Z3Execution, type Z3ExecutionOptions } from "./z3.js";
import { formatEffect } from "./capabilities.js";
import type { EffectSummary } from "./effects.js";

export interface VerificationArtifact {
  obligationId: string;
  status: "verified" | "counterexample" | "unknown" | "unsupported";
  evidence: "verified" | "unknown";
  source: { fileName: string; span: { start: number; end: number } };
  counterexample?: { raw: string; assignments: Record<string, string> };
  message?: string;
  /** Concrete solver runtime and preserved fallback attempts for proof provenance. */
  solver?: Pick<Z3Execution, "backend" | "version" | "attempts">;
  /** The obligation this artifact discharges, so evidence can be reported without re-lowering. */
  obligation?: { functionName: string; clause: ContractDiagnostic["clause"]; source: string };
  /** Versioned path evidence identifying the source completion point proved by this artifact. */
  controlFlow?: ContractControlFlowEvidence;
}

export interface ContractDiagnostic {
  fileName: string;
  functionName: string;
  clause: "requires" | "ensures" | "invariant" | "unsupported";
  line: number;
  message: string;
  notes?: DiagnosticNote[];
  model?: string;
  obligationId?: string;
  artifact?: VerificationArtifact;
}

export interface ContractVerificationResult {
  diagnostics: ContractDiagnostic[];
  artifacts: VerificationArtifact[];
}

/** Bind a proved contract path to the Program effect summary covering that exact source return. */
export function attachContractEffectBoundaries(artifacts: readonly VerificationArtifact[], summaries: readonly EffectSummary[]): VerificationArtifact[] {
  return artifacts.map((artifact) => {
    if (!artifact.controlFlow) return artifact;
    const summary = summaries.find((candidate) => candidate.fileName === artifact.source.fileName && candidate.span
      && candidate.span.start <= artifact.source.span.start && candidate.span.end >= artifact.source.span.end);
    if (!summary) return artifact;
    const discharged = [...new Set(artifact.controlFlow.exceptionFlow?.discharged.map(({ effect }) => effect) ?? [])].sort();
    const escaping = [...new Set(artifact.controlFlow.exceptionFlow?.escapes.map(({ effect }) => effect) ?? [])].sort();
    const inferred = summary.effects.map(formatEffect).sort();
    const blockers = escaping.filter((effect) => !inferred.includes(effect)).map((effect) => `escaping ${effect} is absent from the inferred Effect summary`);
    const joined: VerificationArtifact = { ...artifact, controlFlow: { ...artifact.controlFlow, effectBoundary: {
      schema: "uneffect-contract-effect-boundary/v1",
      evidence: blockers.length > 0 ? "unknown" : summary.evidence,
      inferred,
      discharged,
      escaping,
      blockers,
    } } };
    return blockers.length === 0 ? joined : { ...joined, status: "unknown", evidence: "unknown", message: blockers.join("; ") };
  });
}

function parseAssignments(model: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of model.matchAll(/\(define-fun\s+([^\s()]+)\s*\(\)\s+[^\s()]+\s+([^()\s]+|\([^)]*\))\)/g)) result[match[1]!] = match[2]!;
  return result;
}

function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(Math.min(position, source.text.length)).line + 1;
}

function clauseOf(obligation: InvariantObligation): ContractDiagnostic["clause"] {
  return obligation.kind === "postcondition" ? "ensures" : "invariant";
}

/** Locate a lowering rejection at the construct that caused it, falling back to the first contracted function. */
function unsupportedOwner(source: ts.SourceFile, cause: unknown): { functionName: string; span: { start: number; end: number }; line: number } {
  if (cause instanceof InvariantLoweringError && cause.span) {
    return { functionName: cause.functionName ?? "<file>", span: cause.span, line: lineAt(source, cause.span.start) };
  }
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && Boolean(node.name));
  return { functionName: fn?.name?.text ?? "<file>", span: fn ? { start: fn.getStart(source), end: fn.getEnd() } : { start: 0, end: source.text.length }, line: fn ? lineAt(source, fn.getStart(source)) : 1 };
}

/** Verify every lowered obligation. Unsupported syntax and solver unknown are explicit non-proofs. */
export async function verifyContractObligations(fileName: string, text: string, z3?: Z3ExecutionOptions, program?: ts.Program): Promise<ContractVerificationResult> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let obligations: InvariantObligation[];
  try {
    obligations = lowerInvariantProgram(fileName, text, program);
  } catch (cause) {
    const owner = unsupportedOwner(source, cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    const artifact: VerificationArtifact = { obligationId: "unsupported", status: "unsupported", evidence: "unknown", source: { fileName, span: owner.span }, message };
    const construct = text.slice(owner.span.start, owner.span.end).split(/\r?\n/u)[0]!.trim();
    const notes: DiagnosticNote[] = [
      { label: "construct", detail: construct.length > 80 ? `${construct.slice(0, 77)}...` : construct },
      { label: "because", detail: "the contract is not checked at all while this construct is outside the verified subset; no obligation was generated for this function" },
    ];
    if (cause instanceof InvariantLoweringError && cause.hint) notes.push({ label: "hint", detail: cause.hint });
    return { artifacts: [artifact], diagnostics: [{ fileName, functionName: owner.functionName, clause: "unsupported", line: owner.line, message: `${owner.functionName} has no verified contract: ${message}`, notes, artifact }] };
  }

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
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: clauseOf(obligation), line: lineAt(source, obligation.span.start), message: describeObligation(obligation), notes: [{ label: "rule", detail: obligationRule(obligation) }, ...explainCounterexample(obligation, assignments)], model, obligationId: obligation.id, artifact });
    } else {
      const detail = status === "error" ? `${execution.failureKind ?? "infrastructure failure"}: ${execution.stderr}` : status;
      const artifact: VerificationArtifact = { ...base, status: "unknown", evidence: "unknown", message: `Z3 returned ${detail} for ${clauseOf(obligation)} ${obligation.source}` };
      artifacts.push(artifact);
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: "unsupported", line: lineAt(source, obligation.span.start), message: artifact.message!, notes: [{ label: "because", detail: "the solver neither proved nor refuted this obligation, so the contract carries no evidence" }, { label: "hint", detail: "simplify the clause (nonlinear arithmetic and unbounded multiplication are the usual causes) or split it into smaller obligations" }], obligationId: obligation.id, artifact });
    }
  }
  return { diagnostics, artifacts };
}

export async function verifyContracts(fileName: string, text: string): Promise<ContractDiagnostic[]> {
  return (await verifyContractObligations(fileName, text)).diagnostics;
}
