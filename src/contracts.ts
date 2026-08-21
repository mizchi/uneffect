import ts from "typescript";
import { init } from "z3-solver";
import { generateObligationSmt, lowerInvariantProgram, type InvariantObligation } from "./invariant-ir.js";

export interface VerificationArtifact {
  obligationId: string;
  status: "verified" | "counterexample" | "unknown" | "unsupported";
  evidence: "verified" | "unknown";
  source: { fileName: string; span: { start: number; end: number } };
  counterexample?: { raw: string; assignments: Record<string, string> };
  message?: string;
}

export interface ContractDiagnostic {
  fileName: string;
  functionName: string;
  clause: "requires" | "ensures" | "invariant" | "unsupported";
  line: number;
  message: string;
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

function unsupportedOwner(fileName: string, text: string): { functionName: string; span: { start: number; end: number }; line: number } {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && Boolean(node.name));
  return { functionName: fn?.name?.text ?? "<file>", span: fn ? { start: fn.getStart(source), end: fn.getEnd() } : { start: 0, end: text.length }, line: fn ? lineAt(source, fn.getStart(source)) : 1 };
}

/** Verify every lowered obligation. Unsupported syntax and solver unknown are explicit non-proofs. */
export async function verifyContractObligations(fileName: string, text: string): Promise<ContractVerificationResult> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let obligations: InvariantObligation[];
  try {
    obligations = lowerInvariantProgram(fileName, text);
  } catch (cause) {
    const owner = unsupportedOwner(fileName, text);
    const message = cause instanceof Error ? cause.message : String(cause);
    const artifact: VerificationArtifact = { obligationId: "unsupported", status: "unsupported", evidence: "unknown", source: { fileName, span: owner.span }, message };
    return { artifacts: [artifact], diagnostics: [{ fileName, functionName: owner.functionName, clause: "unsupported", line: owner.line, message, artifact }] };
  }

  const { Context } = await init();
  const ctx: any = new Context(`uneffect_${Date.now()}_${Math.random()}`);
  const diagnostics: ContractDiagnostic[] = [];
  const artifacts: VerificationArtifact[] = [];
  for (const obligation of obligations) {
    const solver = new ctx.Solver();
    solver.fromString(generateObligationSmt(obligation, false));
    const status = String(await solver.check());
    const base = { obligationId: obligation.id, source: { fileName, span: obligation.span } };
    if (status === "unsat") {
      artifacts.push({ ...base, status: "verified", evidence: "verified" });
    } else if (status === "sat") {
      const model = solver.model().toString();
      const artifact: VerificationArtifact = { ...base, status: "counterexample", evidence: "unknown", counterexample: { raw: model, assignments: parseAssignments(model) } };
      artifacts.push(artifact);
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: clauseOf(obligation), line: lineAt(source, obligation.span.start), message: obligation.kind === "postcondition" ? `postcondition may fail: ${obligation.source}` : `loop ${obligation.kind === "loop-init" ? "invariant is not established" : "invariant is not preserved"}`, model, obligationId: obligation.id, artifact });
    } else {
      const artifact: VerificationArtifact = { ...base, status: "unknown", evidence: "unknown", message: `Z3 returned ${status}` };
      artifacts.push(artifact);
      diagnostics.push({ fileName, functionName: obligation.functionName, clause: "unsupported", line: lineAt(source, obligation.span.start), message: artifact.message!, obligationId: obligation.id, artifact });
    }
  }
  return { diagnostics, artifacts };
}

export async function verifyContracts(fileName: string, text: string): Promise<ContractDiagnostic[]> {
  return (await verifyContractObligations(fileName, text)).diagnostics;
}
