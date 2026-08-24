import ts from "typescript";
import type { DiagnosticNote } from "./diagnostics.js";
import { init } from "z3-solver";
import { describeObligation, explainCounterexample, obligationRule } from "./contract-explanations.js";
import { generateObligationSmt, InvariantLoweringError, lowerInvariantProgram, type InvariantObligation } from "./invariant-ir.js";

export interface VerificationArtifact {
  obligationId: string;
  status: "verified" | "counterexample" | "unknown" | "unsupported";
  evidence: "verified" | "unknown";
  source: { fileName: string; span: { start: number; end: number } };
  counterexample?: { raw: string; assignments: Record<string, string> };
  message?: string;
  /** The obligation this artifact discharges, so evidence can be reported without re-lowering. */
  obligation?: { functionName: string; clause: ContractDiagnostic["clause"]; source: string };
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
export async function verifyContractObligations(fileName: string, text: string): Promise<ContractVerificationResult> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let obligations: InvariantObligation[];
  try {
    obligations = lowerInvariantProgram(fileName, text);
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
  const { Context } = await init();
  const ctx: any = new Context(`uneffect_${Date.now()}_${Math.random()}`);
  const diagnostics: ContractDiagnostic[] = [];
  const artifacts: VerificationArtifact[] = [];
  for (const obligation of obligations) {
    const solver = new ctx.Solver();
    solver.fromString(generateObligationSmt(obligation, false));
    const status = String(await solver.check());
    const base = { obligationId: obligation.id, source: { fileName, span: obligation.span }, obligation: { functionName: obligation.functionName, clause: clauseOf(obligation), source: obligation.source } };
    if (status === "unsat") {
      artifacts.push({ ...base, status: "verified", evidence: "verified" });
    } else if (status === "sat") {
      const model = solver.model().toString();
      const assignments = parseAssignments(model);
      const artifact: VerificationArtifact = { ...base, status: "counterexample", evidence: "unknown", counterexample: { raw: model, assignments } };
      artifacts.push(artifact);
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: clauseOf(obligation), line: lineAt(source, obligation.span.start), message: describeObligation(obligation), notes: [{ label: "rule", detail: obligationRule(obligation) }, ...explainCounterexample(obligation, assignments)], model, obligationId: obligation.id, artifact });
    } else {
      const artifact: VerificationArtifact = { ...base, status: "unknown", evidence: "unknown", message: `Z3 returned ${status} for ${clauseOf(obligation)} ${obligation.source}` };
      artifacts.push(artifact);
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: "unsupported", line: lineAt(source, obligation.span.start), message: artifact.message!, notes: [{ label: "because", detail: "the solver neither proved nor refuted this obligation, so the contract carries no evidence" }, { label: "hint", detail: "simplify the clause (nonlinear arithmetic and unbounded multiplication are the usual causes) or split it into smaller obligations" }], obligationId: obligation.id, artifact });
    }
  }
  return { diagnostics, artifacts };
}

export async function verifyContracts(fileName: string, text: string): Promise<ContractDiagnostic[]> {
  return (await verifyContractObligations(fileName, text)).diagnostics;
}
