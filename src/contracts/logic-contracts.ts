export type LogicSort = "Int" | "Real" | "Bool";
export type NumericDomain = "int" | "nat" | "float" | "bool";
export type LogicExpression =
  | { kind: "variable"; name: string }
  | { kind: "integer"; value: string }
  | { kind: "real"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "conditional"; test: LogicExpression; consequent: LogicExpression; alternate: LogicExpression }
  | { kind: "unary"; operator: "not" | "negate" | "floor" | "ceil"; operand: LogicExpression }
  | { kind: "binary"; operator: string; left: LogicExpression; right: LogicExpression };

export interface ObligationVariable { name: string; sort: LogicSort; domain: NumericDomain }
/** How a source-level name (`result`, a local, a loop snapshot) is defined over the obligation variables. */
export interface ObligationBinding { name: string; expression: LogicExpression }
export interface ContractControlFlowEvidence {
  schema: "uneffect-contract-control-flow/v1";
  /** Stable identity of the source completion point shared by clauses proved at that point. */
  blockId: string;
  completion: "return" | "call" | "loop-entry" | "loop-back-edge" | "synthetic";
  /** Conditions assumed by the solver on the path reaching this completion point. */
  pathConditions: LogicExpression[];
  narrowing?: {
    source: "typescript-typechecker";
    typescriptVersion: string;
    programDigest: string;
    facts: string[];
  };
  exceptionFlow?: {
    schema: "uneffect-contract-exception-flow/v1";
    discharged: ContractThrowEdge[];
    escapes: ContractThrowEdge[];
  };
  relationalCalls?: ContractRelationalCallEvidence[];
  effectBoundary?: {
    schema: "uneffect-contract-effect-boundary/v1";
    evidence: "verified" | "trusted" | "inferred" | "unknown";
    inferred: string[];
    discharged: string[];
    escaping: string[];
    blockers: string[];
  };
}
export interface ContractRelationalCallEvidence {
  schema: "uneffect-contract-relational-call/v1";
  evidence: "verified" | "trusted";
  typescriptVersion: string;
  functionName: string;
  clauses: string[];
  preconditions?: string[];
  callSpan: { start: number; end: number };
  declarationFileName: string;
  declarationDigest: string;
  declarationSpan: { start: number; end: number };
}
export interface ContractThrowEdge {
  kind: "synchronous-throw" | "promise-rejection";
  evidence?: "verified" | "trusted";
  effect: string;
  originSpan: { start: number; end: number };
  handlerSpan?: { start: number; end: number };
  payload?: LogicExpression;
}
export interface InvariantObligation {
  id: string;
  kind: "postcondition" | "call-precondition" | "loop-init" | "loop-preserve";
  fileName: string;
  functionName: string;
  span: { start: number; end: number };
  variables: ObligationVariable[];
  assumptions: LogicExpression[];
  goal: LogicExpression;
  source: string;
  bindings: ObligationBinding[];
  /** Readable aliases for generated variables, e.g. `count_i_loop_84` displayed as `i@loop`. */
  displayNames: Record<string, string>;
  controlFlow: ContractControlFlowEvidence;
}
