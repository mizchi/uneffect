import { createHash } from "node:crypto";

/**
 * Compiler-neutral shape of the trusted-assumption ledger. Both the Program analyzer and the native check
 * produce it, so the types and the entry identity live here rather than beside either implementation.
 */
export type AssumptionDomain = "builtin" | "module-initialization" | "typed-array" | "temporal-contract" | "dispatch-sealing" | "resource-callable" | "package-contract";

export interface AssumptionScope {
  fileName: string;
  functionName?: string;
  span: { start: number; end: number };
}

export interface AssumptionEntry {
  id: string;
  evidence: "trusted";
  domain: AssumptionDomain;
  reason: string;
  scope: AssumptionScope;
  owner?: string;
  expiresOn?: string;
  reviewDigest?: string;
  dependency?: {
    module: string;
    packageVersion?: string;
    nodeMajor?: number;
  };
}

export interface AssumptionPolicy {
  requireOwner?: boolean;
  requireExpiration?: boolean;
  denyExpired?: boolean;
  allowUnboundedDomains?: AssumptionDomain[];
  asOf?: string;
}

export interface AssumptionViolation {
  assumptionId: string;
  domain: AssumptionDomain;
  rule: "owner-required" | "expiration-required" | "invalid-expiration" | "expired";
  message: string;
  scope: AssumptionScope;
}

export interface AssumptionLedger {
  schema: "uneffect-assumptions/v1";
  entries: AssumptionEntry[];
  violations: AssumptionViolation[];
}

/**
 * The identity of an assumption is its content: the same claim at the same span is the same entry whichever
 * frontend recorded it. A caller-supplied id wins so an authenticated registry record keeps its own identity.
 */
export function assumptionEntry(input: Omit<AssumptionEntry, "id" | "evidence">, id?: string): AssumptionEntry {
  return { ...input, id: id ?? createHash("sha256").update(JSON.stringify(input)).digest("hex"), evidence: "trusted" };
}
