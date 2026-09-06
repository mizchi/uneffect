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
  | { readonly kind: "nearest-breakable" }
  | { readonly kind: "label"; readonly label: string };

export interface TargetedCompletion {
  readonly completion: CompletionKind;
  readonly target?: CompletionTarget;
}

/** A finite, de-duplicated set of control completions for structural CFGs. */
export type CompletionSet = readonly TargetedCompletion[];

function completionKey(value: TargetedCompletion): string {
  if (!isLoopTransfer(value.completion)) return value.completion;
  if (value.target?.kind === "label") return `${value.completion}:label:${value.target.label}`;
  return `${value.completion}:${value.target?.kind ?? "unresolved"}`;
}

export function completionSet(...values: readonly TargetedCompletion[]): CompletionSet {
  const unique = new Map<string, TargetedCompletion>();
  for (const value of values) unique.set(completionKey(value), value);
  return [...unique.values()];
}

function unionCompletions(...sets: readonly CompletionSet[]): CompletionSet {
  return completionSet(...sets.flat());
}

/** Evaluate the successor only for paths that completed normally. */
export function sequenceCompletions(
  incoming: CompletionSet,
  successor: () => CompletionSet,
): CompletionSet {
  const abrupt = incoming.filter((value) => value.completion !== "normal");
  return incoming.some((value) => value.completion === "normal")
    ? unionCompletions(abrupt, successor())
    : completionSet(...abrupt);
}

/** Replace each represented throw path with the catch block's completions. */
export function catchCompletions(
  incoming: CompletionSet,
  handler: () => CompletionSet,
): CompletionSet {
  return completionSet(...routeCatchPaths(incoming, (value) => value.completion, handler));
}

/** Route catch for a domain path while retaining its attached payload. */
export function routeCatchPaths<Path>(
  incoming: readonly Path[],
  completionOf: (path: Path) => CompletionKind,
  handler: () => readonly Path[],
): Path[] {
  const retained = incoming.filter((value) => completionOf(value) !== "throw");
  return incoming.some((value) => completionOf(value) === "throw")
    ? [...retained, ...handler()]
    : retained;
}

/**
 * Apply ECMAScript finally completion precedence. A normal finalizer preserves
 * the incoming completion; every abrupt finalizer path overrides it.
 */
export function finallyCompletions(
  incoming: CompletionSet,
  finalizer: CompletionSet,
): CompletionSet {
  return completionSet(...routeFinallyPaths(incoming, finalizer, (value) => value.completion));
}

/** Apply finally precedence to domain paths without discarding their payload. */
export function routeFinallyPaths<Path>(
  incoming: readonly Path[],
  finalizer: readonly Path[],
  completionOf: (path: Path) => CompletionKind,
): Path[] {
  const abrupt = finalizer.filter((value) => completionOf(value) !== "normal");
  return finalizer.some((value) => completionOf(value) === "normal")
    ? [...incoming, ...abrupt]
    : abrupt;
}

/** Consume transfers owned by one loop, retaining transfers to outer owners. */
export function consumeLoopCompletions(
  incoming: CompletionSet,
  ownerLabel?: string,
): CompletionSet {
  const retained = incoming.filter((value) => !isTransferOwnedByLoop(value, ownerLabel));
  const ownsBreak = incoming.some((value) => value.completion === "break" && isTransferOwnedByLoop(value, ownerLabel));
  return ownsBreak ? unionCompletions(retained, completionSet({ completion: "normal" })) : completionSet(...retained);
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

export function breakTransferTarget(label?: string): CompletionTarget {
  return label === undefined ? { kind: "nearest-breakable" } : { kind: "label", label };
}

export function continueTransferTarget(label?: string): CompletionTarget {
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
    || (completion.completion === "break" && completion.target.kind === "nearest-breakable")
    || (completion.target.kind === "label" && completion.target.label === ownerLabel);
}

export function formatTargetedCompletion(completion: TargetedCompletion): string {
  if (!isLoopTransfer(completion.completion)) return completion.completion;
  return completion.target?.kind === "label"
    ? `${completion.completion} ${completion.target.label}`
    : completion.completion;
}
