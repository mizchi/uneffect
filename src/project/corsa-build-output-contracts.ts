import type { CorsaApiFrontendOptions } from "../frontends/corsa/corsa-api-frontend.js";
import type { BuildOutputIntegrity } from "./build-output-contracts.js";

export interface CorsaBuildOutputOptions extends CorsaApiFrontendOptions {}
export interface CorsaNativeCompilerIdentity {
  readonly executable: string;
  readonly version: string;
  readonly digest: string;
}
export interface CorsaBuildOutputIntegrity extends BuildOutputIntegrity {
  readonly schema: "uneffect-native-build-outputs/v1";
  readonly compiler: CorsaNativeCompilerIdentity;
  /** Hash of effective config and compiler-selected inputs, checked before/after emission. */
  readonly inputDigest?: string;
  readonly coverage: "single-project-js-and-declarations";
}
export interface CorsaWorkspaceProjectOutputIntegrity extends BuildOutputIntegrity {
  readonly configFile: string;
  readonly references: readonly string[];
  /** Solutions only verify the reference graph; they emit no outputs. */
  readonly kind: "project" | "solution";
  readonly inputDigest?: string;
  /** Direct dependencies preventing this project from being checked. */
  readonly blockedBy?: readonly string[];
}
export interface CorsaWorkspaceBuildOutputIntegrity extends BuildOutputIntegrity {
  readonly schema: "uneffect-native-workspace-build-outputs/v1";
  readonly compiler: CorsaNativeCompilerIdentity;
  readonly coverage: "project-reference-js-and-declarations";
  /** Each reachable config once, dependencies before consumers. */
  readonly projects: readonly CorsaWorkspaceProjectOutputIntegrity[];
}
