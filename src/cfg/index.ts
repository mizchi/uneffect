/**
 * Compiler-independent control-flow primitives. No Uneffect domain, compiler,
 * solver, or host dependency is imported by this entrypoint.
 */
export { solveBasicBlockFixedPoint } from "./fixed-point.js";
export { joinFlowValues } from "./join.js";
export type {
  FlowJoinOptions, FixedPointBudget, LatticeJoin, FixedPointLattice, BasicBlockTransfer,
  BasicBlockEdge, BasicBlock, BasicBlockFixedPointOptions, BasicBlockFixedPointResult,
} from "./contracts.js";
export {
  completionSet, sequenceCompletions, catchCompletions, routeCatchPaths, finallyCompletions,
  routeFinallyPaths, consumeLoopCompletions, loopTransferTarget, breakTransferTarget,
  continueTransferTarget, isLoopTransfer, isTransferOwnedByLoop, formatTargetedCompletion,
} from "./completion.js";
export type {
  CompletionKind, AbruptCompletion, LoopTransferKind, CompletionTarget, TargetedCompletion,
  CompletionSet, CompletionPath, PredicateCompletionSummary, CompletionSummary,
} from "./completion.js";
