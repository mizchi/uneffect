import type { RefinementRuntimeIdentity } from "../evidence/runtime-identities.js";

export interface RefinementBindingManifest {
  schema: "uneffect-refinement-bindings/v1";
  fileName: string;
  adapterName: string;
  version: string;
  runtimeIdentity?: RefinementRuntimeIdentity;
  create: string;
  observe: string;
  abstractions: Record<string, string>;
  actions: Record<string, string>;
  invariants: Record<string, string>;
}

export interface ParsedRefinementDefinition {
  name: string;
  version: string;
  runtimeIdentity?: string;
  create: string;
  observe: string;
  abstractions: Record<string, string>;
  actions: Record<string, string>;
  invariants: Record<string, string>;
}

