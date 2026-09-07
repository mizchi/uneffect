/** AST-independent syntax views. Child nodes retain their frontend identity. */
export type ControlFlowExpression<E> =
  | { readonly kind: "unknown" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "call"; readonly callee: E; readonly arguments: readonly E[]; readonly conditional: boolean }
  | { readonly kind: "eager"; readonly operands: readonly E[] }
  | { readonly kind: "wrapped" | "not"; readonly operand: E }
  | { readonly kind: "binary"; readonly operator: string; readonly left: E; readonly right: E };

export type ControlFlowStatement<S, E> =
  | { readonly kind: "normal" | "throw" }
  | { readonly kind: "return"; readonly expression?: E }
  | { readonly kind: "break" | "continue"; readonly label?: string }
  | { readonly kind: "block"; readonly statements: readonly S[] }
  | { readonly kind: "if"; readonly condition: E; readonly consequent: S; readonly alternate?: S }
  | { readonly kind: "switch"; readonly condition: E; readonly clauses: readonly { readonly isDefault: boolean; readonly statements: readonly S[] }[] }
  | { readonly kind: "try"; readonly body: S; readonly handler?: S; readonly finalizer?: S }
  | { readonly kind: "loop"; readonly body: S; readonly condition?: E; readonly unconditional: boolean; readonly postTest: boolean }
  | { readonly kind: "label"; readonly label: string; readonly body: S }
  | { readonly kind: "expression"; readonly expressions: readonly E[]; readonly body?: S };

export interface ControlFlowSyntax<S, E> {
  statement(node: S): ControlFlowStatement<S, E>;
  expression(node: E): ControlFlowExpression<E>;
}

/** Facts must refer to the supplied frontend's original nodes. No name inference. */
export interface ControlFlowSemantics<E> {
  readonly isNeverCall?: (call: E) => boolean;
  readonly constantBoolean?: (expression: E) => boolean | undefined;
}

export type ContractExit = "normal" | "return" | "throw" | `break:${string}` | `continue:${string}`;

/** Top-level named function declarations only. This is not checker or body-proof evidence. */
export interface StructuralContractControlFlow {
  readonly fileName: string;
  readonly name: string;
  /** UTF-16 offsets; includes export modifiers. */
  readonly span: { readonly start: number; readonly end: number };
  readonly evidence: "structural";
  readonly exits: readonly ContractExit[];
  readonly mayFallThrough: boolean;
}
