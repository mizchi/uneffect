import type { CompletionKind } from "./completion.js";

export interface FlowJoinOptions<Key, Value, Condition> {
  readonly keys: Iterable<Key>;
  readonly condition: Condition;
  readonly original: (key: Key) => Value;
  readonly whenTrue: (key: Key) => Value | undefined;
  readonly whenFalse: (key: Key) => Value | undefined;
  readonly equivalent: (left: Value, right: Value) => boolean;
  readonly phi: (condition: Condition, whenTrue: Value, whenFalse: Value) => Value;
}

export interface FixedPointBudget {
  readonly name: string;
  readonly limit: number;
}

export type LatticeJoin<Value> =
  | { readonly status: "joined"; readonly value: Value }
  | { readonly status: "conflict"; readonly reason: string };

export interface FixedPointLattice<Value> {
  /* uneffect:effect InvokeUserCode */
  readonly bottom: () => Value;
  /* uneffect:effect InvokeUserCode */
  readonly equivalent: (left: Value, right: Value) => boolean;
  /* uneffect:effect InvokeUserCode */
  readonly join: (left: Value, right: Value) => LatticeJoin<Value>;
}

export interface BasicBlockTransfer<Value> {
  readonly to: string;
  readonly value: Value;
}

export interface BasicBlockEdge<Completion extends string = CompletionKind> {
  readonly to: string;
  readonly completion: Completion;
  readonly role?: "forward" | "branch" | "back-edge";
  readonly sourceSpan?: { readonly start: number; readonly end: number };
}

export interface BasicBlock<Value, Completion extends string = CompletionKind> {
  readonly id: string;
  readonly edges: readonly BasicBlockEdge<Completion>[];
  /* uneffect:effect InvokeUserCode */
  readonly transfer: (input: Value) => readonly BasicBlockTransfer<Value>[];
}

export interface BasicBlockFixedPointOptions<Value, Completion extends string = CompletionKind> {
  readonly entry: string;
  readonly initial: Value;
  readonly budget: FixedPointBudget;
  readonly lattice: FixedPointLattice<Value>;
  readonly blocks: readonly BasicBlock<Value, Completion>[];
}

export type BasicBlockFixedPointResult<Value> =
  | {
    readonly status: "converged";
    readonly iterations: number;
    readonly budget: FixedPointBudget;
    readonly states: ReadonlyMap<string, Value>;
  }
  | {
    readonly status: "unknown";
    readonly reason: "proof-budget-exhausted" | "lattice-conflict" | "invalid-cfg";
    readonly detail: string;
    readonly iterations: number;
    readonly budget: FixedPointBudget;
    readonly states: ReadonlyMap<string, Value>;
  };
