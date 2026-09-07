/** Permanent compatibility identifier for the 0.3 authoring subset. */
export const uneffectSpecVersion = "uneffect-spec/v1" as const;

export { bool, defineTemporal, int, text } from "./temporal-authoring.js";
export type { TemporalDefinition, TemporalType } from "./temporal-authoring.js";
export { Builtin, Console, Custom, Fetch, FsRead, FsWrite, Throw, defineCapability, defineEffectSchema } from "../effects/capability-authoring.js";
export type { BuiltinEffectName, CapabilityDefinition, CapabilityDescriptor, LocalEffectSchema } from "../effects/capability-authoring.js";
export { defineContract, float, nat } from "../contracts/contract-authoring.js";
export type { ContractDefinition } from "../contracts/contract-authoring.js";
export { defineRefinement, globalRuntime, identityProjection, mapFromEntriesProjection, nodeGlobalRuntime, setFromArrayProjection } from "../refinement/refinement-authoring.js";
export type { RefinementCallable, RefinementDefinition, RefinementProjection, RefinementRuntimeDescriptor } from "../refinement/refinement-authoring.js";
