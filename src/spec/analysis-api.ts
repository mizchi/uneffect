/** Experimental source specification analysis, independent of the JavaScript TypeScript compiler. */
export { parseSpec } from "./spec-ir.js";
export type {
  ParsedSpec, InvariantSpec, CapabilitySpec, LocatedEffect, TemporalSpec,
  TemporalState, TemporalClock, TemporalAssignment, TemporalAction, TemporalProperty,
  TemporalLiveness, TemporalRecurrence, TemporalStabilization, TemporalResponse,
} from "./spec-ir.js";
export {
  parseTemporalExpression, parseTemporalValueType, typeCheckTemporalExpression,
  temporalTypesCompatible, formatTemporalValueType, assertGuardedTemporalMapGets,
  generateQuintExpression, generateRuntimeAssertionExpression, generateRuntimeAssertionStatement,
} from "./temporal-expressions.js";
export type { TemporalExpression, TemporalBinaryOperator, TemporalValueType, TemporalScalarType } from "./temporal-expressions.js";
export { parseTemporalComposition, generateComposedQuint } from "./temporal-compose.js";
export type { TemporalComposition, TemporalCall, TemporalFunctionSummary } from "./temporal-compose.js";
export { generateQuint, generateSmtLib } from "./spec-backends.js";
export { lintSpec, lintSpecWithZ3 } from "./spec-lint.js";
export type { SpecLintDiagnostic, SpecLintWithZ3Options } from "./spec-lint.js";
export { parseTemporalDsl, resolveTemporalDslSourceLink } from "./temporal-dsl-source.js";
export type { TemporalDslLink } from "./temporal-dsl-source.js";
export { parseContractDsl, prepareContractDslSources } from "../contracts/contract-dsl-source.js";
export { prepareCorsaContractDslLinks } from "../contracts/corsa-contract-dsl.js";
export type { PrepareCorsaContractDslOptions } from "../contracts/corsa-contract-dsl.js";
export type { ParsedContractDsl, ContractClauseProvenance, PreparedContractDslLinks } from "../contracts/contract-dsl-contracts.js";
export { validateCorsaDslHelperIdentities } from "./corsa-dsl-identities.js";
export type { CorsaDslKind } from "./corsa-dsl-identities.js";
export { parseCapabilityDsl, parseCapabilityDslWithSchemas, prepareCapabilityDslSources } from "../effects/capability-dsl-source.js";
export type { ParsedCapabilityDsl, PreparedCapabilityDslLinks } from "../effects/capability-dsl-source.js";
export { parseRefinementDsl, resolveRefinementDslSourceLink } from "../refinement/refinement-dsl-source.js";
export { resolveCorsaRefinementDslLink } from "../refinement/corsa-refinement-dsl.js";
export type { ResolveCorsaRefinementDslOptions } from "../refinement/corsa-refinement-dsl.js";
export type { ParsedRefinementDefinition, RefinementBindingManifest } from "../refinement/binding-contracts.js";
