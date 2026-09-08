import type { DiagnosticNote } from "../support/diagnostic-contracts.js";
import type { Z3Execution } from "../backends/z3.js";
import type { ContractControlFlowEvidence } from "./logic-contracts.js";

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
  /** Bounded native body proof; independent of effect and workspace summary evidence. */
  native?: {
    coverage: "boolean-and-constant-return" | "boolean-branching" | "safe-integer-arithmetic";
    compilerRevision: string;
    compilerDigest: string;
    sourceDigest: string;
  };
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
