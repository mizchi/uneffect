import * as v from "valibot";

declare const pathPatternBrand: unique symbol;
export type Path<Pattern extends string = string> = string & {
  readonly [pathPatternBrand]: Pattern;
};

export const IntSchema = v.pipe(v.number(), v.safeInteger(), v.brand("Int"));
export type Int = v.InferOutput<typeof IntSchema>;

export const NatSchema = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(0),
  v.brand("Int"),
  v.brand("Nat"),
);
export type Nat = v.InferOutput<typeof NatSchema>;

export const FloatSchema = v.pipe(v.number(), v.finite(), v.brand("Float"));
export type Float = v.InferOutput<typeof FloatSchema>;

export const parseInt = (input: unknown): Int => v.parse(IntSchema, input);
export const parseNat = (input: unknown): Nat => v.parse(NatSchema, input);
export const parseFloat = (input: unknown): Float => v.parse(FloatSchema, input);

export { analyzeEffectSummariesInProgram, analyzeEffects, analyzeEffectsInProgram, analyzeProgramEffects } from "./effects.js";
export type { EffectAnalysisOptions, EffectAnalysisResult, EffectDiagnostic, EffectSummary, EvidenceStatus } from "./effects.js";
export { capabilityPermits, effectSchema, formatEffect, parseEffectExpression, registerEffectSchema } from "./capabilities.js";
export type { AtomDomain, CapabilityAtom, CapabilityComparisonOptions, CapabilityEffect, CapabilitySet, Effect, EffectSchema } from "./capabilities.js";
export { instrumentOwnershipAssertions, instrumentRuntimeAssertions, optimizeOwnershipAssertions } from "./instrument.js";
export type { OwnershipAssertionInsertion, OwnershipInstrumentResult } from "./instrument.js";
export { verifyContractObligations, verifyContracts } from "./contracts.js";
export type { ContractDiagnostic, ContractVerificationResult, VerificationArtifact } from "./contracts.js";
export { generateObligationSmt, logicToSmt, lowerInvariantProgram, obligationFromSpec, parseLogicExpression, proveBooleanImplication } from "./invariant-ir.js";
export type { InvariantObligation, LogicExpression, LogicSort, NumericDomain, ObligationVariable } from "./invariant-ir.js";
export { parseSpec } from "./spec-ir.js";
export type {
  CapabilitySpec,
  InvariantSpec,
  ParsedSpec,
  TemporalAction,
  TemporalAssignment,
  TemporalProperty,
  TemporalLiveness,
  TemporalSpec,
  TemporalState,
  TemporalClock,
  LocatedEffect,
} from "./spec-ir.js";
export type { AnnotationDiagnostic, LocatedAnnotation, SourceSpan } from "./annotations.js";
export { extractLocatedAnnotations, validateUneffectAnnotations } from "./annotations.js";
export { generateQuint, generateSmtLib } from "./spec-backends.js";
export { generateComposedQuint, parseTemporalComposition } from "./temporal-compose.js";
export type { TemporalCall, TemporalComposition, TemporalFunctionSummary } from "./temporal-compose.js";
export { generateQuintExpression, generateRuntimeAssertionExpression, generateRuntimeAssertionStatement, parseTemporalExpression, typeCheckTemporalExpression } from "./temporal-expressions.js";
export type { TemporalBinaryOperator, TemporalExpression, TemporalValueType } from "./temporal-expressions.js";
export { projectDenoPermissions, resolveTargetTemp } from "./deno-permissions.js";
export type { DenoPermissionPolicy, DenoPermissionProjection, PermissionProjectionOptions, SandboxEscape, TargetProfile } from "./deno-permissions.js";
export { builtinContractRegistry, builtinSymbolId, findBuiltinContract } from "./builtin-contracts.js";
export type {
  BuiltinContract,
  BuiltinOperation,
  BuiltinContractRegistry,
  BuiltinSymbolKey,
  PathResultRefinement,
  FsBuiltinOperation,
  FetchBuiltinOperation,
  TimerBuiltinOperation,
  TimerClearBuiltinOperation,
  PromiseCombinator,
  PromiseCombinatorBuiltinOperation,
  StaticEffectBuiltinOperation,
  MutationBuiltinOperation,
  CloneBuiltinOperation,
  DomBuiltinOperation,
  DomOperation,
  DeclarationFingerprint,
} from "./builtin-contracts.js";
export { auditBuiltinDeclarationDrift, collectBuiltinCallRefinements, TypeScriptFrontendAdapter } from "./frontend-adapter.js";
export type { DeclarationDriftDiagnostic, FrontendSymbolAdapter, ResolvedCallSite } from "./frontend-adapter.js";
export { analyzeOwnership, checkOwnership, collectOwnershipEvents, generateOwnershipQuint } from "./ownership.js";
export type { OwnershipDiagnostic, OwnershipEvent, OwnershipOperation, OwnershipState } from "./ownership.js";
export { builtinContractDigest, createEvidenceArtifact, trustedSummary, validateOwnershipEvidence, verifyOwnershipObligationWithQuint, verifyOwnershipObligationWithZ3 } from "./evidence.js";
export type { EvidenceArtifact, EvidenceArtifactSummary, OwnershipEvidenceArtifact } from "./evidence.js";
export { applyOwnershipAssertionElision, applyStableReadReuse, evaluateOwnershipGuardElision, evaluatePropertyMangle, evaluateStableReadReuse } from "./optimizer.js";
export type { OptimizationDecision, OptimizationEvent, OptimizationObligation, OwnershipAssertionRewrite, OwnershipGuardElisionObligation, PropertyMangleObligation, StableReadReuseObligation, StableReadRewrite } from "./optimizer.js";
export { analyzeAsyncPatterns, analyzeAsyncPatternsInProgram, generateAsyncPatternsQuint } from "./async-patterns.js";
export type { AsyncPatternModel, PromiseCombinatorPattern, TimerCancellation, TimerPattern } from "./async-patterns.js";
export { analyzePromiseChains, analyzePromiseChainsInProgram, generatePromiseChainsQuint } from "./promise-chains.js";
export type { PromiseChainModel, PromiseChainPattern, PromiseExecutorEvent, PromiseExecutorPattern, PromiseExecutorSettlement, PromiseHandlerReturn, PromiseReactionKind, PromiseReactionPattern } from "./promise-chains.js";
export { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, composeResourceFailures, generateOwnershipObligationQuint, generateOwnershipObligationSmt, generateResourceSafetyQuint, generateUnifiedAsyncQuint } from "./async-safety.js";
export type { AsyncControlEdge, AsyncSafetyDiagnostic, AsyncSafetyOptions, AsyncSafetyResult, OwnershipGuardObligation, PromiseBinding, PromiseObservation, PromiseObservationKind, ResourceBinding, ResourceDisposal, ResourceError, ResourceExit } from "./async-safety.js";
export { resolveDisposalProtocol } from "./disposal-symbols.js";
export type { ResolvedDisposalProtocol } from "./disposal-symbols.js";
export { buildProgramCallGraph, instantiateCallbackEffects } from "./call-graph.js";
export type { CallableKind, CallGraphEdge, CallGraphNode, EffectParameter, InstantiatedCallbackEffects, InvocationTiming, ProgramCallGraph } from "./call-graph.js";
