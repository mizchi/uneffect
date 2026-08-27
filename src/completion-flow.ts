/** Completion kinds shared by refinement, Promise, and resource control flow. */
export type CompletionKind = "normal" | AbruptCompletion;
export type AbruptCompletion = "return" | "throw" | LoopTransferKind;
export type LoopTransferKind = "break" | "continue";

/**
 * A loop transfer either targets the nearest lexical loop or a named owner.
 * Consumers must retain this identity until the matching CFG boundary consumes
 * it; treating an unresolved transfer as normal completion is unsound.
 */
export type CompletionTarget =
  | { readonly kind: "nearest-loop" }
  | { readonly kind: "label"; readonly label: string };

export interface TargetedCompletion {
  readonly completion: CompletionKind;
  readonly target?: CompletionTarget;
}

/** Path-oriented form used by concrete TypeScript CFG consumers. */
export interface CompletionPath<Condition> extends TargetedCompletion {
  readonly controlConditions: readonly Condition[];
}

/**
 * Predicate-lattice form used when several completion paths have already been
 * joined. Payload and snapshot stay attached to their abrupt edge.
 */
export interface PredicateCompletionSummary<Predicate, Value, Snapshot> {
  readonly kind: "mixed";
  readonly returnWhen?: Predicate;
  readonly throwWhen?: Predicate;
  readonly breakWhen?: Predicate;
  readonly continueWhen?: Predicate;
  readonly breakLabels?: ReadonlyMap<string, Predicate>;
  readonly continueLabels?: ReadonlyMap<string, Predicate>;
  readonly throwValue?: Value;
  readonly throwLocals?: Snapshot;
  readonly returnLocals?: Snapshot;
  readonly breakLocals?: Snapshot;
  readonly continueLocals?: Snapshot;
}

export type CompletionSummary<Predicate, Value, Snapshot> =
  | CompletionKind
  | PredicateCompletionSummary<Predicate, Value, Snapshot>;

export function loopTransferTarget(label?: string): CompletionTarget {
  return label === undefined ? { kind: "nearest-loop" } : { kind: "label", label };
}

export function isLoopTransfer(completion: CompletionKind): completion is LoopTransferKind {
  return completion === "break" || completion === "continue";
}

/** True only when this exact lexical loop owns the transfer. */
export function isTransferOwnedByLoop(
  completion: TargetedCompletion,
  ownerLabel?: string,
): boolean {
  if (!isLoopTransfer(completion.completion) || !completion.target) return false;
  return completion.target.kind === "nearest-loop"
    || completion.target.label === ownerLabel;
}

export function formatTargetedCompletion(completion: TargetedCompletion): string {
  if (!isLoopTransfer(completion.completion)) return completion.completion;
  return completion.target?.kind === "label"
    ? `${completion.completion} ${completion.target.label}`
    : completion.completion;
}
