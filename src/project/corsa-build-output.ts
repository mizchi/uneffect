import { inspectNativeBuildOutputs } from "./native-build-output.js";
import type { CorsaBuildOutputOptions, CorsaBuildOutputIntegrity } from "./corsa-build-output-contracts.js";

export type { CorsaBuildOutputOptions, CorsaBuildOutputIntegrity, CorsaNativeCompilerIdentity,
  CorsaWorkspaceBuildOutputIntegrity, CorsaWorkspaceProjectOutputIntegrity } from "./corsa-build-output-contracts.js";
export { inspectCorsaWorkspaceBuildOutputs } from "./corsa-workspace-build-output.js";

/**
 * Bounded native re-emission gate. Does not update consumer outputs or build state.
 * Compares JS and d.ts bytes only, not source maps, build freshness or workspace provenance.
 * Inputs must remain quiescent; detected changes fail closed, not an atomic filesystem snapshot.
 */
export function inspectCorsaBuildOutputs(options: CorsaBuildOutputOptions): CorsaBuildOutputIntegrity {
  return { ...inspectNativeBuildOutputs(options), schema: "uneffect-native-build-outputs/v1", coverage: "single-project-js-and-declarations" };
}
