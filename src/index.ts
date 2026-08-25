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

export const U8Schema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(255), v.brand("U8"));
export type U8 = v.InferOutput<typeof U8Schema>;
export const U32Schema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(0xffff_ffff), v.brand("U32"));
export type U32 = v.InferOutput<typeof U32Schema>;
declare const i32Brand: unique symbol;
export type I32 = number & { readonly [i32Brand]: "I32" };
declare const f32Brand: unique symbol;
export type F32 = number & { readonly [f32Brand]: "F32" };
export const U8_BITS = 8 as const;
export const U8_MAX = 0xff as const;
export const U32_BITS = 32 as const;
export const U32_MAX = 0xffff_ffff as const;
export const I32_MIN = -0x8000_0000 as const;
export const I32_MAX = 0x7fff_ffff as const;
export const F32_BITS = 32 as const;

declare const boundedUint8ArrayBrand: unique symbol;
export type BoundedUint8Array<MaxLength extends number> = Uint8Array & { readonly [boundedUint8ArrayBrand]: MaxLength };
declare const boundedUint32ArrayBrand: unique symbol;
export type BoundedUint32Array<MaxLength extends number> = Uint32Array & { readonly [boundedUint32ArrayBrand]: MaxLength };
declare const boundedDataViewBrand: unique symbol;
export type BoundedDataView<MaxBytes extends number> = DataView & { readonly [boundedDataViewBrand]: MaxBytes };
declare const boundedArrayBufferBrand: unique symbol;
export type BoundedArrayBuffer<MaxBytes extends number> = ArrayBuffer & { readonly [boundedArrayBufferBrand]: MaxBytes };
declare const fixedArrayBufferBrand: unique symbol;
export type FixedArrayBuffer<Bytes extends number> = ArrayBuffer & { readonly [fixedArrayBufferBrand]: Bytes };
declare const boundedSetBrand: unique symbol;
export type BoundedSet<Element, MaxSize extends number> = Set<Element> & { readonly [boundedSetBrand]: MaxSize };
declare const boundedMapBrand: unique symbol;
export type BoundedMap<Key, Value, MaxSize extends number> = Map<Key, Value> & { readonly [boundedMapBrand]: MaxSize };
export function boundedUint8ArraySchema<MaxLength extends number>(maximum: MaxLength) {
  return v.pipe(
    v.instance(Uint8Array),
    v.maxLength(maximum, `Uint8Array length must be at most ${maximum}`),
  );
}
export const parseBoundedUint8Array = <MaxLength extends number>(input: unknown, maximum: MaxLength): BoundedUint8Array<MaxLength> =>
  v.parse(boundedUint8ArraySchema(maximum), input) as BoundedUint8Array<MaxLength>;
export function boundedUint32ArraySchema<MaxLength extends number>(maximum: MaxLength) {
  return v.pipe(v.instance(Uint32Array), v.maxLength(maximum, `Uint32Array length must be at most ${maximum}`));
}
export const parseBoundedUint32Array = <MaxLength extends number>(input: unknown, maximum: MaxLength): BoundedUint32Array<MaxLength> =>
  v.parse(boundedUint32ArraySchema(maximum), input) as BoundedUint32Array<MaxLength>;
export function parseBoundedDataView<MaxBytes extends number>(input: unknown, maximum: MaxBytes): BoundedDataView<MaxBytes> {
  const value = v.parse(v.instance(DataView), input);
  if (value.byteLength > maximum) throw new RangeError(`DataView byteLength must be at most ${maximum}`);
  return value as BoundedDataView<MaxBytes>;
}
export function parseBoundedArrayBuffer<MaxBytes extends number>(input: unknown, maximum: MaxBytes): BoundedArrayBuffer<MaxBytes> {
  const value = v.parse(v.instance(ArrayBuffer), input);
  if (value.maxByteLength > maximum) throw new RangeError(`ArrayBuffer maxByteLength must be at most ${maximum}`);
  return value as BoundedArrayBuffer<MaxBytes>;
}
export function parseFixedArrayBuffer<Bytes extends number>(input: unknown, bytes: Bytes): FixedArrayBuffer<Bytes> {
  const value = v.parse(v.instance(ArrayBuffer), input);
  if (value.resizable || value.byteLength !== bytes) throw new RangeError(`ArrayBuffer must be fixed at exactly ${bytes} bytes`);
  return value as FixedArrayBuffer<Bytes>;
}
export function parseBoundedSet<Element, MaxSize extends number>(
  input: unknown,
  maximum: MaxSize,
  parseElement: (input: unknown) => Element,
): BoundedSet<Element, MaxSize> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError(`Set maximum size must be a non-negative safe integer, got ${maximum}`);
  if (!(input instanceof Set)) throw new TypeError("Expected a Set");
  if (input.size > maximum) throw new RangeError(`Set size must be at most ${maximum}`);
  for (const value of input) parseElement(value);
  return input as BoundedSet<Element, MaxSize>;
}
export function parseBoundedMap<Key, Value, MaxSize extends number>(
  input: unknown,
  maximum: MaxSize,
  parseKey: (input: unknown) => Key,
  parseValue: (input: unknown) => Value,
): BoundedMap<Key, Value, MaxSize> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError(`Map maximum size must be a non-negative safe integer, got ${maximum}`);
  if (!(input instanceof Map)) throw new TypeError("Expected a Map");
  if (input.size > maximum) throw new RangeError(`Map size must be at most ${maximum}`);
  for (const [key, value] of input) { parseKey(key); parseValue(value); }
  return input as BoundedMap<Key, Value, MaxSize>;
}

export const parseInt = (input: unknown): Int => v.parse(IntSchema, input);
export const parseNat = (input: unknown): Nat => v.parse(NatSchema, input);
export const parseFloat = (input: unknown): Float => v.parse(FloatSchema, input);
export const parseU8 = (input: unknown): U8 => v.parse(U8Schema, input);
export const parseU32 = (input: unknown): U32 => v.parse(U32Schema, input);
/** Explicit ECMAScript machine-number coercions. Validation helpers remain separate. */
export const u8 = (value: number): U8 => (value & 0xff) as U8;
export const u32 = (value: number): U32 => (value >>> 0) as U32;
export const i32 = (value: number): I32 => (value | 0) as I32;
export const f32 = (value: number): F32 => Math.fround(value) as F32;
export type U8Table<Values extends readonly number[]> = { readonly [Index in keyof Values]: U8 };
export type U32Table<Values extends readonly number[]> = { readonly [Index in keyof Values]: U32 };
export const u8Table = <const Values extends readonly number[]>(values: Values): U8Table<Values> =>
  values.map((value) => parseU8(value)) as unknown as U8Table<Values>;
export const u32Table = <const Values extends readonly number[]>(values: Values): U32Table<Values> =>
  values.map((value) => parseU32(value)) as unknown as U32Table<Values>;
/** Backward-compatible descriptive alias for SHA-256-style modular normalization. */
export const toU32 = u32;

export { analyzeEffectSummariesInProgram, analyzeEffects, analyzeEffectsInProgram, analyzeProgramEffects } from "./effects.js";
export type { EffectAnalysisOptions, EffectAnalysisResult, EffectDiagnostic, EffectSummary, EvidenceStatus } from "./effects.js";
export { capabilityPermits, effectSchema, formatEffect, parseEffectExpression, registerEffectSchema } from "./capabilities.js";
export type { AtomDomain, CapabilityAtom, CapabilityComparisonOptions, CapabilityEffect, CapabilitySet, Effect, EffectSchema } from "./capabilities.js";
export { buildVerifiedOwnership, buildVerifiedOwnershipCached, instrumentOwnershipAssertions, instrumentRuntimeAssertions, optimizeOwnershipAssertions } from "./instrument.js";
export type { CachedVerifiedOwnershipBuildResult, OwnershipAssertionInsertion, OwnershipInstrumentResult, VerifiedOwnershipBuildResult } from "./instrument.js";
export { ownershipEvidenceKey, readOwnershipEvidenceCache, writeOwnershipEvidenceCache } from "./ownership-evidence-cache.js";
export type { OwnershipEvidenceCache, OwnershipEvidenceCacheEntry } from "./ownership-evidence-cache.js";
export { verifyContractObligations, verifyContracts } from "./contracts.js";
export type { ContractDiagnostic, ContractVerificationResult, VerificationArtifact } from "./contracts.js";
export { checkUneffectProperty, generateUneffectPropertyTests, generateUneffectPropertyTestsWithZ3 } from "./property-tests.js";
export type { CheckUneffectPropertyOptions, CheckUneffectPropertyResult, GenerateUneffectPropertyTestsOptions, GenerateUneffectPropertyTestsResult, GenerateUneffectPropertyTestsWithZ3Options, GenerateUneffectPropertyTestsWithZ3Result, PropertyBoundaryKind, PropertyCounterexample, PropertyLiteral, PropertySolverDiagnostic, PropertyTestBoundary, PropertyTestDomain } from "./property-tests.js";
export { createModelCounterexample, parseQuintItfCounterexample, parseTlcCounterexample, readModelCounterexample, replayModelCounterexample, writeModelCounterexample } from "./model-replay.js";
export type { ModelCounterexample, ModelCounterexampleStep, ModelRefinementAdapter, ModelReplayResult, ModelScalar, ModelState, ModelValue, ReadModelCounterexampleOptions, ReplayMismatch, ReplayViolation } from "./model-replay.js";
export { buildRefinementBindingManifest, createAnnotatedRefinementAdapter, extractRefinementBindings, generateRefinementAdapterModule, validateRefinementActionBodies, validateRefinementActionBodiesInProgram, validateRefinementActionBodiesInProgramWithZ3, validateRefinementActionBodiesWithZ3, validateRefinementBindingCoverage, validateRefinementInvariantBodies, validateRefinementInvariantBodiesInProgram, validateRefinementInvariantBodiesInProgramWithZ3, validateRefinementInvariantBodiesWithZ3, validateRefinementStateProjection, validateRefinementStateProjectionInProgram } from "./refinement-bindings.js";
export type { RefinementActionDiagnostic, RefinementActionDiagnosticCode, RefinementBinding, RefinementBindingCoverageCode, RefinementBindingCoverageDiagnostic, RefinementBindingManifest, RefinementBindingRole, RefinementInvariantDiagnostic, RefinementInvariantDiagnosticCode, RefinementStateProjectionDiagnostic, RefinementStateProjectionDiagnosticCode, Z3RefinementDiagnostic } from "./refinement-bindings.js";
export { analyzeEffectRecovery, compareEffectImplementations, measureUneffectAdoption } from "./adoption.js";
export type { AdoptionFixtureName, AdoptionReport, EffectFailureOwnership, EffectImplementationComparison, EffectRecoveryAnalysis, ExternalAdoptionReport } from "./adoption.js";
export { verifyTypedArraySafety, verifyTypedArraySafetyInProgram, verifyTypedArraySafetyInTypeScriptProgram } from "./typed-array-safety.js";
export type { TypedArrayDiagnostic, TypedArrayObligation, TypedArrayProgramSafetyResult, TypedArraySafetyResult, TypedArraySafetyStatistics } from "./typed-array-safety.js";
export { generateObligationSmt, InvariantLoweringError, logicToSmt, lowerInvariantProgram, obligationFromSpec, parseLogicExpression, proveBooleanImplication } from "./invariant-ir.js";
export type { InvariantObligation, LogicExpression, LogicSort, NumericDomain, ObligationBinding, ObligationVariable } from "./invariant-ir.js";
export { checkFiles, createCheckHost } from "./check.js";
export { environmentSummary, formatEnvironmentReport, readPackageManifest, runEnvironmentChecks } from "./environment.js";
export type { EnvironmentCheck, EnvironmentCheckOptions, EnvironmentStatus, PackageManifest } from "./environment.js";
export type { CheckOptions, CheckResult } from "./check.js";
export { diagnosticHint, formatCheckEvidence, formatDiagnostic, formatDiagnostics, reportDiagnostic } from "./diagnostics.js";
export type { CheckerDiagnostic, DiagnosticFormatOptions, DiagnosticNote, DiagnosticSeverity, ReportedDiagnostic } from "./diagnostics.js";
export { describeObligation, evaluateLogic, explainCounterexample, failingConjunct, formatEvaluated, formatLogic, formatValue, obligationRule, parseModel, parseModelValue } from "./contract-explanations.js";
export type { LogicModel, LogicValue } from "./contract-explanations.js";
export { evaluateQuality, formatQualityReport, qualityCriteria, qualityThreshold, scoreDiagnostic } from "./diagnostic-quality.js";
export type { DiagnosticScore, QualityCriterion, QualityReport } from "./diagnostic-quality.js";
export { parseSpec } from "./spec-ir.js";
export { checkTemporalExpressionEquivalenceWithZ3, findTemporalCounterexampleWithZ3, lintSpec, lintSpecWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpec, lintTemporalSpecWithZ3 } from "./spec-lint.js";
export type { SpecLintDiagnostic, SpecLintWithZ3Options, TemporalCounterexampleResult, TemporalEquivalenceResult, TemporalReachabilityLintOptions } from "./spec-lint.js";
export type {
  CapabilitySpec,
  InvariantSpec,
  ParsedSpec,
  TemporalAction,
  TemporalAssignment,
  TemporalProperty,
  TemporalLiveness,
  TemporalRecurrence,
  TemporalStabilization,
  TemporalResponse,
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
export { generateQuintExpression, generateRuntimeAssertionExpression, generateRuntimeAssertionStatement, parseTemporalExpression, parseTemporalValueType, typeCheckTemporalExpression } from "./temporal-expressions.js";
export type { TemporalBinaryOperator, TemporalExpression, TemporalValueType } from "./temporal-expressions.js";
export { createDefaultTemporalDomainRegistry, createLogicalClockDomain, createPhysicalClockDomain, TemporalDomainRegistry } from "./temporal-domains.js";
export type { TemporalDomainActionSource, TemporalDomainExpansion, TemporalDomainPropertySource, TemporalSemanticDomain } from "./temporal-domains.js";
export { checkClockConformance, createBrowserClockObserver, createDenoClockObserver, createNodeClockObserver } from "./clock-conformance.js";
export type { ClockConformanceDiagnostic, ClockConformancePolicy, ClockConformanceResult, ClockObservation, ClockRateRange, HostClockObserver, HostClockSources } from "./clock-conformance.js";
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
  DeferredCallbackBuiltinOperation,
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
export { collectAssumptionLedger, evaluateAssumptionPolicy } from "./assumptions.js";
export type { AssumptionDomain, AssumptionEntry, AssumptionLedger, AssumptionPolicy, AssumptionPolicyDiagnostic, AssumptionScope, AssumptionViolation } from "./assumptions.js";
export type { EvidenceArtifact, EvidenceArtifactSummary, OwnershipEvidenceArtifact } from "./evidence.js";
export { applyOwnershipAssertionElision, applyStableReadReuse, evaluateOwnershipGuardElision, evaluatePropertyMangle, evaluateStableReadReuse } from "./optimizer.js";
export type { OptimizationDecision, OptimizationEvent, OptimizationObligation, OwnershipAssertionRewrite, OwnershipGuardElisionObligation, PropertyMangleObligation, StableReadReuseObligation, StableReadRewrite } from "./optimizer.js";
export { optimizeUneffectProject } from "./project-optimizer.js";
export type { OptimizeUneffectProjectOptions, OptimizeUneffectProjectResult, ProjectOptimizationTransformation, StaleProjectEvidence } from "./project-optimizer.js";
export { analyzeAsyncPatterns, analyzeAsyncPatternsInProgram, generateAsyncPatternsQuint, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "./async-patterns.js";
export type { AbortCompositionPattern, AsyncPatternModel, PromiseCombinatorPattern, TimerCancellation, TimerHandleEscape, TimerPattern } from "./async-patterns.js";
export { analyzePromiseChains, analyzePromiseChainsInProgram, generatePromiseChainsQuint } from "./promise-chains.js";
export type { PromiseChainModel, PromiseChainPattern, PromiseExecutorEvent, PromiseExecutorPattern, PromiseExecutorSettlement, PromiseHandlerReturn, PromiseReactionKind, PromiseReactionPattern, PromiseThenablePattern } from "./promise-chains.js";
export { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, composeResourceFailures, generateOwnershipObligationQuint, generateOwnershipObligationSmt, generateResourceSafetyQuint, generateUnifiedAsyncQuint } from "./async-safety.js";
export type { AsyncControlCompletionPath, AsyncControlCondition, AsyncControlEdge, AsyncControlLoop, AsyncControlRegion, AsyncControlStatement, AsyncSafetyDiagnostic, AsyncSafetyOptions, AsyncSafetyResult, OwnershipGuardObligation, PromiseBinding, PromiseObservation, PromiseObservationKind, ResourceAliasEscape, ResourceBinding, ResourceDisposal, ResourceError, ResourceEscape, ResourceExit } from "./async-safety.js";
export { resolveDisposalProtocol } from "./disposal-symbols.js";
export type { ResolvedDisposalProtocol } from "./disposal-symbols.js";
export { compareUneffectFrontends } from "./frontend-parity.js";
export type { CompareUneffectFrontendsOptions, CompareUneffectFrontendsResult, FrontendSchemaDrift, NormalizedFrontendIr } from "./frontend-parity.js";
export { buildProgramCallGraph, instantiateCallbackEffects } from "./call-graph.js";
export type { CallableKind, CallGraphEdge, CallGraphNode, EffectParameter, InstantiatedCallbackEffects, InvocationTiming, ProgramCallGraph } from "./call-graph.js";
export { analyzeReactProgram, analyzeReactSemantics, analyzeReactSemanticsInProgram, generateReactLifecycleQuint, generateReactSuspenseBoundaryQuint, generateReactSuspenseBoundaryQuintFromAnalysis, generateReactSuspenseBoundaryQuintFromProgram } from "./react-semantics.js";
export type { ReactCommitPhase, ReactComponentSummary, ReactDiagnosticKind, ReactEffectTransition, ReactHookSummary, ReactLifecycleScenario, ReactLifecycleStep, ReactPhase, ReactPhaseSummary, ReactRenderAttempt, ReactReplayEffect, ReactReplayModel, ReactReplayScenario, ReactSemanticDiagnostic, ReactSemanticsResult, ReactSuspenseBoundaryOptions, ReactSuspenseBoundarySummary, ReactUnsupportedSuspenseBoundary, ReactUnsupportedSuspenseBoundaryReason } from "./react-semantics.js";
export { analyzeUneffectProject, defineUneffectValidator, validateUneffectProject } from "./custom-validators.js";
export type { AnalyzeUneffectProjectOptions, CallCardinality, FunctionSpecialization, ProjectValidatorDiagnostic, UneffectProjectAnalysis, UneffectProjectSummary, UneffectValidator, UneffectValidatorDefinition, ValidateUneffectProjectOptions } from "./custom-validators.js";
export { verifyUneffectProject } from "./project-verification.js";
export type { ProjectVerificationObligation, VerifyUneffectProjectOptions, VerifyUneffectProjectResult } from "./project-verification.js";
