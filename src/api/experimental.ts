/**
 * Experimental low-level projections.
 *
 * These APIs expose intermediate async models and backend-specific Quint text.
 * They may change without compatibility guarantees while async observations
 * are being lowered into the unified temporal model.
 */
export * from "./all.js";
export {
  analyzeAsyncPatterns,
  analyzeAsyncPatternsInProgram,
  generateAsyncPatternsQuint,
  generateNodeEventLoopQuint,
  generateWebEventLoopQuint,
} from "../async/async-patterns.js";
export type {
  AbortCompositionPattern,
  AsyncPatternModel,
  PromiseCombinatorPattern,
  TimerCancellation,
  TimerHandleEscape,
  TimerPattern,
} from "../async/async-patterns.js";
export {
  analyzePromiseChains,
  analyzePromiseChainsInProgram,
  generatePromiseChainsQuint,
} from "../async/promise-chains.js";
export type {
  PromiseChainModel,
  PromiseChainPattern,
  PromiseExecutorEvent,
  PromiseExecutorPattern,
  PromiseExecutorSettlement,
  PromiseHandlerReturn,
  PromiseReactionKind,
  PromiseReactionPattern,
  PromiseThenablePattern,
} from "../async/promise-chains.js";
export { generateResourceSafetyQuint, generateUnifiedAsyncQuint } from "../async/async-safety.js";
export { generateResourceTemporalProductQuint } from "../resources/resource-temporal-product.js";
export type { GenerateResourceTemporalProductQuintOptions } from "../resources/resource-temporal-product.js";
