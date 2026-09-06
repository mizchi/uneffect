/**
 * Durable package-root API for Uneffect 0.3.
 *
 * Backend generators, solver adapters, lowering IRs, and proof-construction
 * utilities belong to `@mizchi/uneffect/experimental` until their contracts
 * can survive the backend-neutral roadmap.
 */
export {
  F32_BITS, FloatSchema, I32_MAX, I32_MIN, IntSchema, NatSchema, U8_BITS, U8_MAX, U8Schema, U32_BITS,
  U32_MAX, U32Schema, boundedUint8ArraySchema, boundedUint32ArraySchema, f32, i32,
  parseBoundedArrayBuffer, parseBoundedDataView, parseBoundedMap, parseBoundedSet,
  parseBoundedUint8Array, parseBoundedUint32Array, parseFixedArrayBuffer, parseFloat, parseInt,
  parseNat, parseU8, parseU32, toU32, u8, u8Table, u32, u32Table,
} from "../runtime/numeric.js";
export { analyzeEffects, analyzeEffectsInProgram, analyzeProgramEffects } from "../effects/effects.js";
export { analyzeTrustedScriptSinks } from "../analysis/trusted-types.js";
export {
  analyzeUneffectProject, defineUneffectValidator, validateUneffectProject,
} from "../project/custom-validators.js";
export {
  bindContractSummaryBundleToProgram, createContractSummaryBundle, loadContractSummaryBundle,
  validateContractSummaryBundle,
} from "../contracts/contract-summary.js";
export { builtinContractRegistry, extendBuiltinContractRegistry } from "../effects/builtin-contracts.js";
export { checkCorsaProject } from "../frontends/corsa/corsa-check.js";
export { checkFiles, createCheckHost, createCheckProgram } from "../project/check.js";
export {
  checkUneffectProperty, generateUneffectPropertyTests, generateUneffectPropertyTestsWithZ3,
} from "../contracts/property-tests.js";
export {
  capabilityPermits, formatEffect, parseEffectExpression, parseEffectSet, registerEffectSchema,
} from "../effects/capabilities.js";
export {
  compareEffectBaseline, createEffectBaseline, effectBaselineToolVersion, parseEffectBaseline,
  loadEffectBaseline, writeEffectBaseline,
} from "../effects/effect-baseline.js";
export { compareUneffectFrontends } from "../frontends/frontend-parity.js";
export {
  generateTemporalModel, parseTemporalModelResult, temporalModelCoverageDomains,
} from "../spec/temporal-model.js";
export { instrumentContractPredicates, isContractRuntimeError } from "../contracts/contract-runtime.js";
export {
  installUneffectModules, parseUneffectModuleManifest, loadUneffectModules,
} from "../modules/modules.js";
export { parseBuiltinRegistryConfig, loadBuiltinRegistryConfig } from "../effects/registry-config.js";
export { uneffectDialects, validateUneffectAnnotations } from "../support/annotations.js";
export { verifyContracts } from "../contracts/contracts.js";
export {
  verifyTypedArraySafety, verifyTypedArraySafetyInProgram, verifyTypedArraySafetyInTypeScriptProgram,
} from "../analysis/typed-array-safety.js";
export { verifyUneffectProject } from "../project/project-verification.js";

export type {
  AnalyzeUneffectProjectOptions, ProjectValidatorDiagnostic, UneffectProjectAnalysis,
  UneffectValidator, UneffectValidatorDefinition, ValidateUneffectProjectOptions,
} from "../project/custom-validators.js";
export type { AsyncSafetyDiagnostic } from "../async/async-safety.js";
export type {
  BoundedArrayBuffer, BoundedDataView, BoundedMap, BoundedSet, BoundedUint8Array, BoundedUint32Array,
  F32, FixedArrayBuffer, Float, I32, Int, Nat, Path, U8, U32,
} from "../runtime/numeric.js";
export type { CheckOptions, CheckResult } from "../project/check.js";
export type {
  CheckUneffectPropertyOptions, CheckUneffectPropertyResult, GenerateUneffectPropertyTestsOptions,
  GenerateUneffectPropertyTestsResult, GenerateUneffectPropertyTestsWithZ3Options,
  GenerateUneffectPropertyTestsWithZ3Result, PropertyCounterexample, PropertyTestBoundary,
  PropertyTestDomain,
} from "../contracts/property-tests.js";
export type {
  ContractRuntimeError, ContractRuntimeFailureMetadata, InstrumentContractPredicateOptions,
} from "../contracts/contract-runtime.js";
export type { ContractSummaryBundleV1, ContractSummaryExportV1 } from "../contracts/contract-summary.js";
export type { ContractVerificationOptions, ContractVerificationResult } from "../contracts/contracts.js";
export type { Effect, EffectSchema } from "../effects/capabilities.js";
export type {
  EffectBaseline, EffectBaselineAssessment, EffectBaselineEntry, EffectBaselineRegression,
  EffectBaselineSummary,
} from "../effects/effect-baseline.js";
export type {
  EffectAnalysisOptions, EffectAnalysisResult, EffectDiagnostic, EffectSummary,
} from "../effects/effects.js";
export type {
  GenerateTemporalModelOptions, TemporalModelResult, TemporalModelCoverageDomain,
  TemporalModelCoverageEntry, TemporalModelExclusion, TemporalModelProjectionKind, TemporalRuntime,
} from "../spec/temporal-model.js";
export type { TypedArrayDiagnostic, TypedArraySafetyResult } from "../analysis/typed-array-safety.js";
export type { UneffectDialect } from "../support/annotations.js";
export type { UneffectModuleLedgerEntry, UneffectModuleManifest } from "../modules/modules.js";
export type {
  VerifyUneffectProjectOptions, VerifyUneffectProjectResult,
} from "../project/project-verification.js";
