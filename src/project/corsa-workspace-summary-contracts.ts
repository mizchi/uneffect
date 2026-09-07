import type { EvidenceStatus } from "../evidence/status.js";
import type { CorsaBuildOutputOptions, CorsaNativeCompilerIdentity, CorsaWorkspaceBuildOutputIntegrity } from "./corsa-build-output-contracts.js";

export interface CorsaWorkspaceSummaryCall {
  readonly projectFile: string;
  readonly fileName: string;
  /** Complete Oxc CallExpression span in UTF-16 coordinates. */
  readonly span: { readonly start: number; readonly end: number };
}
export interface CorsaWorkspaceSummaryClaims {
  readonly requires?: readonly string[];
  readonly ensures?: readonly string[];
  readonly effects?: readonly string[];
}
/** Producer claims, bound to the native configuration and source they describe.
 * Metadata hashes establish freshness, not the authority or truth of claims. */
export interface CorsaWorkspaceSummary {
  readonly id: string;
  readonly compiler: Pick<CorsaNativeCompilerIdentity, "version" | "digest">;
  readonly projectFile: string;
  readonly inputDigest: string;
  readonly source: {
    readonly fileName: string;
    readonly digest: string;
    readonly span: { readonly start: number; readonly end: number };
  };
  readonly evidence: EvidenceStatus;
  readonly claims: CorsaWorkspaceSummaryClaims;
}
export interface ComposeCorsaWorkspaceSummariesOptions extends CorsaBuildOutputOptions {
  readonly calls: readonly CorsaWorkspaceSummaryCall[];
  readonly summaries: readonly CorsaWorkspaceSummary[];
}
export interface CorsaWorkspaceSummaryBinding {
  readonly summaryId: string;
  readonly call: CorsaWorkspaceSummaryCall;
  readonly producer: Pick<CorsaWorkspaceSummary, "projectFile" | "inputDigest" | "source">;
  readonly claims: CorsaWorkspaceSummaryClaims;
  /** Native formal names paired with actual argument spans; no text substitution. */
  readonly arguments: readonly { readonly parameter: string; readonly span: { readonly start: number; readonly end: number } }[];
  /** Native source-declaration identity and build output integrity only. */
  readonly linkage: "verified";
  /** Persisted producer authority is trusted; this API does not prove bodies. */
  readonly evidence: "trusted";
  readonly producerEvidence: "verified" | "trusted";
}
export interface CorsaWorkspaceSummaryComposition {
  readonly schema: "uneffect-corsa-workspace-summary-composition/v1";
  readonly status: "bound" | "unknown" | "not-applicable";
  readonly build: CorsaWorkspaceBuildOutputIntegrity;
  readonly bindings: readonly CorsaWorkspaceSummaryBinding[];
  readonly blockers: readonly { readonly call?: CorsaWorkspaceSummaryCall; readonly message: string }[];
}
