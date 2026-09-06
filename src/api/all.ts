export * from "../runtime/numeric.js";
export { analyzeEffectSummariesInProgram, analyzeEffects, analyzeEffectsInProgram, analyzeProgramEffects } from "../effects/effects.js";
export type { EffectAnalysisOptions, EffectAnalysisResult, EffectDiagnostic, EffectSummary, EvidenceStatus, ExternalFunctionEffectContract, ExternalModuleEffectContract } from "../effects/effects.js";
export { capabilityPermits, effectSchema, formatEffect, parseEffectExpression, parseEffectSet, parseParameterizedCapabilityScope, registerEffectSchema, unknownCapabilityReasons, unresolvedCapabilityReasons } from "../effects/capabilities.js";
export type { AtomDomain, CapabilityAtom, CapabilityComparisonOptions, CapabilityEffect, CapabilitySet, Effect, EffectSchema } from "../effects/capabilities.js";
export { buildVerifiedOwnership, buildVerifiedOwnershipCached, instrumentOwnershipAssertions, instrumentRuntimeAssertions, optimizeOwnershipAssertions } from "../optimizer/instrument.js";
export type { CachedVerifiedOwnershipBuildResult, OwnershipAssertionInsertion, OwnershipInstrumentResult, VerifiedOwnershipBuildResult } from "../optimizer/instrument.js";
export { ownershipEvidenceKey, readOwnershipEvidenceCache, writeOwnershipEvidenceCache } from "../optimizer/ownership-evidence-cache.js";
export type { OwnershipEvidenceCache, OwnershipEvidenceCacheEntry } from "../optimizer/ownership-evidence-cache.js";
export { reconcileContractArtifacts, verifyContractObligations, verifyContracts } from "../contracts/contracts.js";
export type { ContractDiagnostic, ContractVerificationOptions, ContractVerificationResult, VerificationArtifact } from "../contracts/contracts.js";
export { attachContractEffectBoundaries } from "../contracts/contracts.js";
export type { ContractRelationalCallEvidence, ExternalContractBinding, InvariantLoweringOptions } from "../contracts/invariant-ir.js";
export { bindContractSummaryBundleToProgram, boundContractSummaryEffectContracts, boundContractSummaryResourceContracts, createContractSummaryBundle, loadContractSummaryBundle, validateContractSummaryBundle } from "../contracts/contract-summary.js";
export type { BoundContractSummaryBundleV1, BoundContractSummaryExportV1, ContractSummaryBundleV1, ContractSummaryExportV1, CreateContractSummaryBundleOptions, ValidateContractSummaryBundleOptions } from "../contracts/contract-summary.js";
export { assessCheckAssurance, formatAssuranceAssessment } from "../evidence/assurance.js";
export type { AssuranceAssessment, AssuranceBlocker, AssuranceCoverage, AssuranceProfile, AssuranceStatus } from "../evidence/assurance.js";
export { checkUneffectProperty, generateUneffectPropertyTests, generateUneffectPropertyTestsWithZ3 } from "../contracts/property-tests.js";
export type { CheckUneffectPropertyOptions, CheckUneffectPropertyResult, GenerateUneffectPropertyTestsOptions, GenerateUneffectPropertyTestsResult, GenerateUneffectPropertyTestsWithZ3Options, GenerateUneffectPropertyTestsWithZ3Result, PropertyBoundaryKind, PropertyCounterexample, PropertyLiteral, PropertyPredicateSpecialization, PropertySolverDiagnostic, PropertyTestBoundary, PropertyTestDomain } from "../contracts/property-tests.js";
export { createModelCounterexample, parseQuintItfCounterexample, parseTlcCounterexample, readModelCounterexample, replayModelCounterexample, writeModelCounterexample } from "../evidence/model-replay.js";
export type { ModelCounterexample, ModelCounterexampleStep, ModelRefinementAdapter, ModelReplayResult, ModelScalar, ModelState, ModelValue, ReadModelCounterexampleOptions, ReplayMismatch, ReplayViolation } from "../evidence/model-replay.js";
export { analyzeRefinementActionBodies, analyzeRefinementActionBodiesInProgram, analyzeRefinementActionBodiesWithZ3, buildRefinementBindingManifest, createRefinementAdapterFromManifest, DEFAULT_REFINEMENT_ACTION_PROOF_BUDGET, generateRefinementAdapterModuleFromManifest, validateRefinementActionBodies, validateRefinementActionBodiesInProgram, validateRefinementActionBodiesInProgramWithZ3, validateRefinementActionBodiesWithManifest, validateRefinementActionBodiesWithZ3, validateRefinementBindingCoverage, validateRefinementBindingCoverageWithManifest, validateRefinementInvariantBodies, validateRefinementInvariantBodiesInProgram, validateRefinementInvariantBodiesInProgramWithZ3, validateRefinementInvariantBodiesWithManifest, validateRefinementInvariantBodiesWithZ3, validateRefinementStateProjection, validateRefinementStateProjectionInProgram, validateRefinementStateProjectionWithManifest, verifyRefinementRecurrenceCertificateWithZ3 } from "../refinement/refinement-bindings.js";
export type { RefinementActionAnalysis, RefinementActionAnalysisOptions, RefinementActionAnalysisWithZ3Options, RefinementActionObligation, RefinementActionProofBudget, RefinementHandlerJoinObligation, RefinementHandlerRecurrenceValueLattice, RefinementHandlerScalarEnvironmentObligation, RefinementLocalAliasHelperObligation, RefinementRankingRecurrenceEvidence, RefinementRecurrenceProof, RefinementRecurrenceProofCheck, RefinementScalarRecurrenceObligation } from "../refinement/refinement-bindings.js";
export type { HandlerCompletionKind } from "../refinement/refinement-handler-flow.js";
export { joinFlowValues, solveBasicBlockFixedPoint } from "../cfg/index.js";
export type { BasicBlock, BasicBlockEdge, BasicBlockFixedPointOptions, BasicBlockFixedPointResult, BasicBlockTransfer, FixedPointBudget, FixedPointLattice, LatticeJoin } from "../cfg/index.js";
export type { ExternalRefinementActionContract, RefinementActionDiagnostic, RefinementActionDiagnosticCode, RefinementActionValidationOptions, RefinementBindingCoverageCode, RefinementBindingCoverageDiagnostic, RefinementBindingManifest, RefinementInvariantDiagnostic, RefinementInvariantDiagnosticCode, RefinementStateProjectionDiagnostic, RefinementStateProjectionDiagnosticCode, Z3RefinementDiagnostic } from "../refinement/refinement-bindings.js";
export { analyzeEffectRecovery, compareEffectImplementations, measureUneffectAdoption } from "../support/adoption.js";
export type { AdoptionFixtureName, AdoptionReport, EffectFailureOwnership, EffectImplementationComparison, EffectRecoveryAnalysis, ExternalAdoptionReport } from "../support/adoption.js";
export { verifyTypedArraySafety, verifyTypedArraySafetyInProgram, verifyTypedArraySafetyInTypeScriptProgram } from "../analysis/typed-array-safety.js";
export type { TypedArrayDiagnostic, TypedArrayObligation, TypedArrayProgramSafetyResult, TypedArraySafetyResult, TypedArraySafetyStatistics, TypedArrayWindowProvenance } from "../analysis/typed-array-safety.js";
export { generateObligationSmt, InvariantLoweringError, logicToSmt, lowerInvariantProgram, obligationFromSpec, parseLogicExpression, proveBooleanImplication } from "../contracts/invariant-ir.js";
export type { ContractControlFlowEvidence } from "../contracts/invariant-ir.js";
export type { InvariantObligation, LogicExpression, LogicSort, NumericDomain, ObligationBinding, ObligationVariable } from "../contracts/invariant-ir.js";
export { checkFiles, createCheckHost, createCheckProgram } from "../project/check.js";
export { checkCorsaProject } from "../frontends/corsa/corsa-check.js";
export type { CorsaCheckOptions, CorsaCheckResult } from "../frontends/corsa/corsa-check.js";
export { environmentSummary, formatEnvironmentReport, readPackageManifest, runEnvironmentChecks } from "../support/environment.js";
export type { EnvironmentCheck, EnvironmentCheckOptions, EnvironmentStatus, PackageManifest } from "../support/environment.js";
export type { CheckOptions, CheckResult } from "../project/check.js";
export { diagnosticHint, formatCheckEvidence, formatDiagnostic, formatDiagnostics, reportDiagnostic } from "../support/diagnostics.js";
export type { CheckerDiagnostic, DiagnosticFormatOptions, DiagnosticNote, DiagnosticSeverity, ReportedDiagnostic, TypeScriptCheckerDiagnostic } from "../support/diagnostics.js";
export { describeObligation, evaluateLogic, explainCounterexample, failingConjunct, formatEvaluated, formatLogic, formatValue, obligationRule, parseModel, parseModelValue } from "../contracts/contract-explanations.js";
export type { LogicModel, LogicValue } from "../contracts/contract-explanations.js";
export { evaluateQuality, formatQualityReport, qualityCriteria, qualityThreshold, scoreDiagnostic } from "../support/diagnostic-quality.js";
export type { DiagnosticScore, QualityCriterion, QualityReport } from "../support/diagnostic-quality.js";
export { parseSpec } from "../spec/spec-ir.js";
export { checkTemporalExpressionEquivalenceWithZ3, findTemporalCounterexampleWithZ3, lintSpec, lintSpecWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpec, lintTemporalSpecWithZ3 } from "../spec/spec-lint.js";
export type { SpecLintDiagnostic, SpecLintWithZ3Options, TemporalCounterexampleResult, TemporalEquivalenceResult, TemporalObservationDomainEvidence, TemporalReachabilityLintOptions } from "../spec/spec-lint.js";
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
} from "../spec/spec-ir.js";
export type { AnnotationDiagnostic, LocatedAnnotation, SourceSpan, UneffectDialect } from "../support/annotations.js";
export { extractLocatedAnnotations, registerUneffectPlugin, uneffectDialects, UneffectPluginError, uneffectPluginDirectives, validateUneffectAnnotations } from "../support/annotations.js";
export type { UneffectPluginDirective, UneffectPluginDirectiveKind } from "../support/annotations.js";
export { assumptionRegistrySchema, AssumptionRegistryError, loadAssumptionRegistry, parseAssumptionRegistry, resolveAssumptionRecord } from "../evidence/assumption-registry.js";
export type { AssumptionRecord, AssumptionRegistry } from "../evidence/assumption-registry.js";
export { generateQuint, generateSmtLib } from "../spec/spec-backends.js";
export { generateComposedQuint, parseTemporalComposition } from "../spec/temporal-compose.js";
export type { TemporalCall, TemporalComposition, TemporalFunctionSummary } from "../spec/temporal-compose.js";
export { generateTemporalModel, parseTemporalModelResult, temporalModelCoverageDomains } from "../spec/temporal-model.js";
export type {
  GenerateTemporalModelOptions,
  TemporalModelCoverageDomain,
  TemporalModelCoverageEntry,
  TemporalModelExclusion,
  TemporalModelProjection,
  TemporalModelProjectionKind,
  TemporalModelResult,
  TemporalModelSynchronization,
  TemporalRuntime,
} from "../spec/temporal-model.js";
export { parseTemporalDsl, resolveTemporalDslLink, validateTemporalDslHelperIdentities } from "../spec/temporal-dsl.js";
export type { TemporalDslLink } from "../spec/temporal-dsl.js";
export { materializeCapabilityDslLinks, parseCapabilityDsl, parseCapabilityDslWithSchemas, prepareCapabilityDslLinks, validateCapabilityDslHelperIdentities } from "../effects/capability-dsl.js";
export { materializeContractDslLinks, prepareContractDslLinks, parseContractDsl, validateContractDslLink } from "../contracts/contract-dsl.js";
export type { ContractClauseProvenance, PreparedContractDslLinks } from "../contracts/contract-dsl.js";
export { instrumentContractPredicates, isContractRuntimeError } from "../contracts/contract-runtime.js";
export type { ContractRuntimeError, ContractRuntimeFailureMetadata, InstrumentContractPredicateOptions } from "../contracts/contract-runtime.js";
export { collectSyntaxFacts, enclosingFunction, parseSyntaxFacts, syntaxFactsCoverageDomains, syntaxFactsSchema } from "../frontends/oxc-syntax.js";
export type { SyntaxFactExclusion, SyntaxFactExclusionReason, SyntaxFacts, SyntaxFactsCoverageDomain, SyntaxFactsCoverageEntry, SyntaxFunction, SyntaxFunctionKind, SyntaxSite } from "../frontends/oxc-syntax.js";
export { analyzeTypeScriptControlFlow, analyzeTypeScriptProgramControlFlow, parseTypeScriptControlFlowAnalysis, typescriptControlFlowSchema } from "../frontends/typescript/typescript-control-flow.js";
export type { TypeScriptControlFlowAnalysis, TypeScriptControlFlowCoverage, TypeScriptControlFlowDiagnosticCode, TypeScriptControlFlowExclusion, TypeScriptControlFlowExclusionReason, TypeScriptControlFlowSource, TypeScriptFunctionControlFlow, TypeScriptFunctionEndpoint } from "../frontends/typescript/typescript-control-flow.js";
export { generateQuintExpression, generateRuntimeAssertionExpression, generateRuntimeAssertionStatement, parseTemporalExpression, parseTemporalValueType, typeCheckTemporalExpression } from "../spec/temporal-expressions.js";
export type { TemporalBinaryOperator, TemporalExpression, TemporalValueType } from "../spec/temporal-expressions.js";
export { createDefaultTemporalDomainRegistry, createLogicalClockDomain, createPhysicalClockDomain, TemporalDomainRegistry } from "../spec/temporal-domains.js";
export type { TemporalDomainActionSource, TemporalDomainExpansion, TemporalDomainPropertySource, TemporalSemanticDomain } from "../spec/temporal-domains.js";
export { checkClockConformance, createBrowserClockObserver, createDenoClockObserver, createNodeClockObserver } from "../support/clock-conformance.js";
export type { ClockConformanceDiagnostic, ClockConformancePolicy, ClockConformanceResult, ClockObservation, ClockRateRange, HostClockObserver, HostClockSources } from "../support/clock-conformance.js";
export { projectDenoPermissions, resolveTargetTemp } from "../effects/deno-permissions.js";
export type { DenoPermissionPolicy, DenoPermissionProjection, PermissionProjectionOptions, SandboxEscape, TargetProfile } from "../effects/deno-permissions.js";
export { builtinContractRegistry, builtinSymbolId, extendBuiltinContractRegistry, findBuiltinContract, findModuleInitializationContract, resolveModuleInitializationContract } from "../effects/builtin-contracts.js";
export { stableSerializeBuiltinSemantics, validateBuiltinSemantics } from "../effects/builtin-semantic-schema.js";
export type {
  BuiltinSemantics,
  CallbackCardinality as BuiltinCallbackCardinality,
  CallbackQueue as BuiltinCallbackQueue,
  CallbackTiming as BuiltinCallbackTiming,
  ResultRefinement as BuiltinResultSemanticRefinement,
  ScopeProjector,
  SemanticPrimitive,
  ValueProjector,
} from "../effects/builtin-semantic-schema.js";
export { interpretBuiltinCallSemantics, projectBuiltinCallbacks } from "../effects/builtin-semantic-interpreter.js";
export type { BuiltinCallbackEvent, BuiltinSemanticEvent, BuiltinSemanticSource, ProjectedScope, ProjectedValue, SemanticEventSource } from "../effects/builtin-semantic-interpreter.js";
export { builtinRegistryConfigSchema, BuiltinRegistryConfigError, loadBuiltinRegistryConfig, parseBuiltinRegistryConfig } from "../effects/registry-config.js";
export { installUneffectModules, loadUneffectModules, parseUneffectModuleManifest, uneffectModuleSchema, UneffectModuleError } from "../modules/modules.js";
export type { UneffectModuleLedgerEntry, UneffectModuleManifest } from "../modules/modules.js";
export { analyzeTrustedScriptSinks } from "../analysis/trusted-types.js";
export type { TrustedTypesDiagnostic } from "../analysis/trusted-types.js";
export {
  declarationTransformEvidenceSchema, declarationTransformManifestSchema,
  DeclarationTransformManifestError, loadDeclarationTransformManifest,
  parseDeclarationTransformManifest, validateDeclarationTransformManifest,
} from "../frontends/typescript/declaration-transforms.js";
export type {
  DeclarationTransformDiagnostic, DeclarationTransformDiagnosticCode,
  DeclarationTransformEvidence, DeclarationTransformManifest,
  DeclarationTransformValidation, EmbeddedTypeScriptTransform,
} from "../frontends/typescript/declaration-transforms.js";
export { analyzeModuleInitializationOrder, isRuntimeModuleDependency } from "../modules/module-initialization.js";
export type { ModuleInitializationChoice, ModuleInitializationConstraint, ModuleInitializationCycleComponent, ModuleInitializationCycleRequest, ModuleInitializationEvent, ModuleInitializationEventKind, ModuleInitializationModule, ModuleInitializationOrder, ModuleInitializationSourceEvidence, ModuleInitializationUnknown, ModuleInitializationUnknownKind } from "../modules/module-initialization.js";
export { analyzeModuleInitializationOrderV2, DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET } from "../modules/module-initialization-v2.js";
export type { ModuleInitializationCompletionPath, ModuleInitializationConstraintV2, ModuleInitializationControlFlow, ModuleInitializationControlFlowEdge, ModuleInitializationControlFlowEdgeRole, ModuleInitializationControlFlowProof, ModuleInitializationEventKindV2, ModuleInitializationEventV2, ModuleInitializationModuleV2, ModuleInitializationOrderV2, ModuleInitializationUnknownV2, ModuleInitializationV2Options } from "../modules/module-initialization-v2.js";
export { loadTypeScriptProject, loadTypeScriptWorkspace } from "../frontends/typescript/typescript-project.js";
export type { TypeScriptBuildArtifactEvidence, TypeScriptBuildArtifactObservation, TypeScriptCompilerProvenance, TypeScriptProject, TypeScriptProjectProvenance, TypeScriptProjectReference, TypeScriptWorkspace, TypeScriptWorkspaceBlocker } from "../frontends/typescript/typescript-project.js";
export { createCheckJsonReport, createCheckWorkspaceJsonReport } from "../cli/check-report.js";
export type { CheckJsonReport, CheckReportEffect, CheckWorkspaceJsonReport, WorkspaceCheckAssurance, WorkspaceCheckBlocker } from "../cli/check-report.js";
export type {
  BuiltinContract,
  BuiltinContractRegistry,
  BuiltinContractRegistryExtension,
  ModuleInitializationContract,
  ModuleInitializationEnvironment,
  BuiltinSymbolKey,
  PathResultRefinement,
  PromiseCombinator,
  DeclarationFingerprint,
} from "../effects/builtin-contracts.js";
export { auditBuiltinDeclarationDrift, collectBuiltinCallRefinements, TypeScriptFrontendAdapter } from "../frontends/frontend-adapter.js";
export type { DeclarationDriftDiagnostic, FrontendSymbolAdapter, ResolvedCallSite } from "../frontends/frontend-adapter.js";
export { analyzeOwnership, checkOwnership, checkOwnershipWithResourceProtocol, collectOwnershipEvents, generateOwnershipQuint, lowerOwnershipEventsToResourceProtocol } from "../analysis/ownership.js";
export type { OwnershipDiagnostic, OwnershipEvent, OwnershipOperation, OwnershipResourceProtocolProjection, OwnershipState } from "../analysis/ownership.js";
export { evaluateResourceProtocol, evaluateResourceProtocolCfg, instantiateResourceCallableSummary, resourceCallableSummarySchema, resourceProtocolCfgSchema, resourceProtocolSchema } from "../resources/resource-protocol.js";
export type { ResourceCallableBindings, ResourceCallableInstantiation, ResourceCallableOperation, ResourceCallableReference, ResourceCallableSummary, ResourceProtocolBlock, ResourceProtocolCfg, ResourceProtocolCfgEvaluation, ResourceProtocolDiagnostic, ResourceProtocolEvaluation, ResourceProtocolModel, ResourceProtocolResource, ResourceProtocolState, ResourceProtocolTransition, ResourceTerminalState } from "../resources/resource-protocol.js";
export { lowerResourceDisposalsToProtocol } from "../resources/resource-disposal-protocol.js";
export type { ResourceDisposalCompletion, ResourceDisposalProtocolProjection } from "../resources/resource-disposal-protocol.js";
export { lowerPromiseOwnershipToResourceProtocol } from "../async/promise-ownership-protocol.js";
export type { PromiseOwnershipProtocolProjection } from "../async/promise-ownership-protocol.js";
export { authenticateResourceCallableContractArtifact, bindResourceCallableArtifactsToProgram, createResourceCallableContractArtifact, loadResourceCallableContractArtifact, resourceCallableArtifactAssumption, resourceCallableArtifactSchema } from "../resources/resource-callable-artifact.js";
export type { BoundResourceCallableArtifacts, ResourceCallableArtifactAuthentication, ResourceCallableArtifactEnvironment, ResourceCallableContractArtifact } from "../resources/resource-callable-artifact.js";
export { analyzeAsyncIteratorCleanup, analyzeAsyncIteratorCleanupInProgram, analyzeIteratorCleanupInProgram, analyzeSynchronousIteratorCleanup } from "../async/async-iterator-cleanup.js";
export type { AsyncIteratorCleanup, AsyncIteratorCleanupScenario, AsyncIteratorCleanupUnknown, AsyncIteratorExit } from "../async/async-iterator-cleanup.js";
export { collectIteratorChecks } from "../effects/iterator-check.js";
export type { IteratorCheckEvidence, IteratorCheckResult } from "../effects/iterator-check.js";
export { createResourceDisposalTemporalProduct, evaluateResourceTemporalProduct, resourceTemporalProductSchema } from "../resources/resource-temporal-product.js";
export type { ResourceDisposalTemporalProductResult, ResourceTemporalLink, ResourceTemporalProduct, ResourceTemporalProductEvaluation } from "../resources/resource-temporal-product.js";
export { analyzeResourceCallableSummaries, collectResourceCallableTransitionSites } from "../resources/resource-callable-typescript.js";
export type { ResourceCallableDiagnostic, ResourceCallableSiteAnalysis, ResourceCallableSummaryAnalysis } from "../resources/resource-callable-typescript.js";
export { analyzeResourceLifecyclesInSource } from "../resources/resource-callable-typescript.js";
export { collectAwaitedRejectionTransitionSites } from "../resources/resource-protocol-typescript.js";
export type { ResourceLifecycleDiagnostic, ResourceLifecycleEvidence, ResourceLifecycleProgramAnalysis } from "../resources/resource-callable-typescript.js";
export { assessEvidenceArtifactEligibility, builtinContractDigest, createEvidenceArtifact, trustedSummary, uneffectVersion, validateEvidenceArtifact, validateOwnershipEvidence, verifyOwnershipObligationWithQuint, verifyOwnershipObligationWithZ3 } from "../evidence/evidence.js";
export { collectAssumptionLedger, evaluateAssumptionPolicy } from "../evidence/assumptions.js";
export type { AssumptionDomain, AssumptionEntry, AssumptionLedger, AssumptionPolicy, AssumptionPolicyDiagnostic, AssumptionScope, AssumptionViolation } from "../evidence/assumptions.js";
export type { EvidenceArtifact, EvidenceArtifactEligibility, EvidenceArtifactEligibilityBlocker, EvidenceArtifactEligibilityReason, EvidenceArtifactSummary, EvidenceArtifactValidation, EvidenceArtifactValidationReason, OwnershipEvidenceArtifact } from "../evidence/evidence.js";
export { applyOwnershipAssertionElision, applyStableReadReuse, evaluateOwnershipGuardElision, evaluatePropertyMangle, evaluateStableReadReuse } from "../optimizer/optimizer.js";
export type { OptimizationDecision, OptimizationEvent, OptimizationObligation, OwnershipAssertionRewrite, OwnershipGuardElisionObligation, PropertyMangleObligation, StableReadReuseObligation, StableReadRewrite } from "../optimizer/optimizer.js";
export { optimizeUneffectProject } from "../optimizer/project-optimizer.js";
export type { OptimizeUneffectProjectOptions, OptimizeUneffectProjectResult, ProjectOptimizationTransformation, StaleProjectEvidence } from "../optimizer/project-optimizer.js";
export { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, composeResourceFailures, generateOwnershipObligationQuint, generateOwnershipObligationSmt } from "../async/async-safety.js";
export type { AsyncControlCompletionPath, AsyncControlCondition, AsyncControlEdge, AsyncControlLoop, AsyncControlRegion, AsyncControlStatement, AsyncControlTransferOwner, AsyncSafetyDiagnostic, AsyncSafetyOptions, AsyncSafetyResult, OwnershipGuardObligation, PromiseBinding, PromiseObservation, PromiseObservationKind, ResourceAliasEscape, ResourceBinding, ResourceDisposal, ResourceError, ResourceEscape, ResourceExit } from "../async/async-safety.js";
export { breakTransferTarget, catchCompletions, completionSet, consumeLoopCompletions, continueTransferTarget, finallyCompletions, formatTargetedCompletion, isLoopTransfer, isTransferOwnedByLoop, loopTransferTarget, routeCatchPaths, routeFinallyPaths, sequenceCompletions } from "../cfg/completion.js";
export type { AbruptCompletion, CompletionKind, CompletionPath, CompletionSet, CompletionSummary, CompletionTarget, LoopTransferKind, PredicateCompletionSummary, TargetedCompletion } from "../cfg/completion.js";
export { resolveRegionIdentity, resolveStableRegion } from "../effects/region-alias.js";
export type { RegionAliasEvidence, ResolveStableRegionOptions, StableRegionResolution } from "../effects/region-alias.js";
export { resolveDisposalProtocol } from "../resources/disposal-symbols.js";
export type { ResolvedDisposalProtocol } from "../resources/disposal-symbols.js";
export { compareUneffectFrontends } from "../frontends/frontend-parity.js";
export type { CompareUneffectFrontendsOptions, CompareUneffectFrontendsResult, FrontendFactProvenance, FrontendSchemaDrift, NormalizedFrontendIr } from "../frontends/frontend-parity.js";
export { buildProgramCallGraph, instantiateCallbackEffects } from "../effects/call-graph.js";
export type { CallableKind, CallGraphEdge, CallGraphNode, EffectParameter, InstantiatedCallbackEffects, InvocationTiming, ProgramCallGraph } from "../effects/call-graph.js";
export { analyzeCallableSummaries, callbackArgumentKey, instantiateCallableSummary } from "../effects/callable-summary.js";
export type { CallableInstantiation, CallableSummary, CallableSummaryAnalysis, CallableSummaryDiagnostic, CallbackCardinality, CallbackCompletion, CallbackInvocationSummary, CallbackParameterSummary, CallbackTiming } from "../effects/callable-summary.js";
export { analyzeAbortSignalsInProgram, analyzeHostNeutralTransitions, composeHostNeutralTransitions, generateHostTransitionModel, lowerAbortSignalTransitions, lowerAsyncPatternTransitions, lowerCallableSummaryTransitions, lowerHostNeutralTransitions, lowerPromiseChainTransitions, lowerResourceDisposalTransitions } from "../async/host-neutral-transitions.js";
export type { AbortCompositionControllerLink, AbortControllerSummary, AbortSignalAnalysis, AbortSignalEvent, AbortSignalTransition, DisposeResourceTransition, GenerateHostTransitionModelOptions, HostCancellationLink, HostExternalCompletionLink, HostFairnessObligation, HostNeutralCompletion, HostNeutralLane, HostNeutralTransition, HostNeutralTransitionAnalysis, HostProfile, HostScheduledTransition, HostTransitionModel, InvokeCallbackTransition, NodeHostQueue, SettlePromiseTransition, WebHostQueue } from "../async/host-neutral-transitions.js";
export { analyzeReactProgram, analyzeReactSemantics, analyzeReactSemanticsInProgram, generateReactActionErrorBoundaryQuint, generateReactActionErrorBoundaryQuintFromAnalysis, generateReactActionQueueQuint, generateReactLifecycleQuint, generateReactNestedSuspenseQuintFromAnalysis, generateReactNestedSuspenseQuintFromProgram, generateReactSuspenseBoundaryQuint, generateReactSuspenseBoundaryQuintFromAnalysis, generateReactSuspenseBoundaryQuintFromProgram, generateReactSuspenseFallbackQuint, generateReactSuspenseFallbackQuintFromAnalysis, generateReactSuspenseTreeQuintFromAnalysis, generateReactSuspenseTreeQuintFromProgram, generateReactTransitionQuint, generateReactTransitionSuspenseQuint, generateReactTransitionSuspenseQuintFromAnalysis } from "../analysis/react-semantics.js";
export type { ReactActionErrorBoundaryOptions, ReactActionQueueOptions, ReactCommitPhase, ReactComponentSummary, ReactDiagnosticKind, ReactEffectTransition, ReactHookSummary, ReactLifecycleScenario, ReactLifecycleStep, ReactNestedSuspenseOptions, ReactPhase, ReactPhaseSummary, ReactRenderAttempt, ReactReplayEffect, ReactReplayModel, ReactReplayScenario, ReactSemanticDiagnostic, ReactSemanticsResult, ReactSuspenseBoundaryOptions, ReactSuspenseBoundarySummary, ReactSuspenseFallbackOptions, ReactSuspenseFallbackScenario, ReactSuspensePrimaryNode, ReactSuspensionSource, ReactSuspenseTreeOptions, ReactTransitionOptions, ReactTransitionSuspenseOptions, ReactUnsupportedSuspenseBoundary, ReactUnsupportedSuspenseBoundaryReason } from "../analysis/react-semantics.js";
export { analyzeUneffectProject, defineUneffectValidator, validateUneffectProject } from "../project/custom-validators.js";
export type { AnalyzeUneffectProjectOptions, CallCardinality, FunctionSpecialization, ProjectValidatorDiagnostic, UneffectProjectAnalysis, UneffectProjectSummary, UneffectValidator, UneffectValidatorDefinition, ValidateUneffectProjectOptions } from "../project/custom-validators.js";
export { verifyUneffectProject } from "../project/project-verification.js";
export type { ProjectVerificationObligation, ProjectWorkspaceAssurance, ProjectWorkspaceVerificationBlocker, ProjectWorkspaceVerificationDomain, VerifyUneffectProjectBaseOptions, VerifyUneffectProjectOptions, VerifyUneffectProjectResult, VerifyUneffectWorkspaceOptions, VerifyUneffectWorkspaceResult } from "../project/project-verification.js";
export { WORKSPACE_REFINEMENT_HELPER_DEPTH_BUDGET } from "../project/workspace-refinements.js";
export type { WorkspaceRefinementCompositionBlocker, WorkspaceRefinementLink } from "../project/workspace-refinements.js";
export { composeWorkspaceModuleInitialization } from "../project/workspace-module-initialization.js";
export type {
  CompletedModuleInitializationProject, WorkspaceModuleInitializationComposition,
  WorkspaceModuleInitializationConstraint, WorkspaceModuleInitializationDomain,
  WorkspaceModuleInitializationLink, WorkspaceModuleInitializationUnknown,
} from "../project/workspace-module-initialization.js";
export { SAME_REALM_GLOBAL_THIS_IDENTITY } from "../evidence/runtime-identities.js";
export { nodeCurrentRealmGlobalIdentity, parseRefinementRuntimeIdentity } from "../evidence/runtime-identities.js";
export type { NodeCurrentRealmGlobalIdentity, RefinementRuntimeIdentity, SameRealmGlobalThisIdentity } from "../evidence/runtime-identities.js";
export { composeWorkspaceEffects } from "../project/workspace-effects.js";
export type { CompletedEffectProject, DeclarationOutputIntegrity, WorkspaceEffectComposition, WorkspaceEffectCompositionBlocker, WorkspaceEffectLink } from "../project/workspace-effects.js";
export { inspectBuildOutputs, mergeBuildOutputIntegrity } from "../project/build-output-integrity.js";
export type { BuildOutputFileIntegrity, BuildOutputIntegrity } from "../project/build-output-integrity.js";
export { assessProjectVerification } from "../project/project-assurance.js";
export type { ProjectAssuranceAssessment, ProjectAssuranceBlocker, ProjectAssuranceCoverage, ProjectAssuranceDomain } from "../project/project-assurance.js";
export { executeZ3, parseZ3BackendPreference } from "../backends/z3.js";
export type { Z3Backend, Z3BackendPreference, Z3Execution, Z3ExecutionOptions, Z3ExecutionResult, Z3FailureKind, Z3ValueRequest } from "../backends/z3.js";
export { analyzeNumberSemanticsInProgram } from "../analysis/number-semantics.js";
export type { NumberSemanticFact, NumberSemanticsAnalysis, NumberValueClass } from "../analysis/number-semantics.js";
export { analyzeAbortableFetches, analyzeAbortableFetchesInProgram, generateAbortableFetchProductQuint } from "../async/abortable-fetch-product.js";
export type { AbortableFetch, AbortableFetchAnalysis, AbortableFetchUnknown } from "../async/abortable-fetch-product.js";
export {
  compareEffectBaseline, createEffectBaseline, effectBaselineToolVersion,
  formatEffectBaselineAssessment, loadEffectBaseline, parseEffectBaseline, processEffectBaseline, writeEffectBaseline,
} from "../effects/effect-baseline.js";
export type {
  EffectBaseline, EffectBaselineAssessment, EffectBaselineEntry, EffectBaselineRegression, EffectBaselineSummary,
  ProcessEffectBaselineOptions, ProcessEffectBaselineResult,
} from "../effects/effect-baseline.js";
