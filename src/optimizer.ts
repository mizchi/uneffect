import type { EvidenceStatus } from "./effects.js";
import { validateOwnershipEvidence, type OwnershipEvidenceArtifact } from "./evidence.js";
import type { OwnershipGuardObligation } from "./async-safety.js";

export interface OptimizationEvent {
  kind: "read" | "mutate" | "invalidate" | "transfer" | "suspend" | "reflect" | "escape";
  region?: string;
}
export interface StableReadReuseObligation {
  schema: "stable-read-reuse/v1";
  region: string;
  firstRead: number;
  reuseAt: number;
  evidence: EvidenceStatus;
  events: readonly OptimizationEvent[];
}
export interface PropertyMangleObligation {
  schema: "property-mangle/v1";
  property: string;
  evidence: EvidenceStatus;
  closedWorld: boolean;
  reflection: boolean;
  escaped: boolean;
}
export interface OwnershipGuardElisionObligation {
  schema: "ownership-guard-elision/v1";
  ownership: OwnershipGuardObligation;
  artifact: OwnershipEvidenceArtifact;
  generatedAssertion: boolean;
}
export type OptimizationObligation = StableReadReuseObligation | PropertyMangleObligation | OwnershipGuardElisionObligation;
export interface OptimizationDecision { allowed: boolean; reason: string; obligation: OptimizationObligation }
export interface StableReadRewrite { code: string; decision: OptimizationDecision }
export interface OwnershipAssertionRewrite { code: string; decision: OptimizationDecision }

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || left.startsWith(`${right}[`) || right.startsWith(`${left}.`) || right.startsWith(`${left}[`);
}
// Trust is reviewable input, not a derived proof. Optimizer authorization is
// deliberately stricter than lint/check acceptance.
function proofGrade(evidence: EvidenceStatus): boolean { return evidence === "verified"; }

export function evaluateStableReadReuse(obligation: StableReadReuseObligation): OptimizationDecision {
  if (!proofGrade(obligation.evidence)) return { allowed: false, reason: `${obligation.evidence} evidence cannot authorize a transformation`, obligation };
  if (obligation.firstRead < 0 || obligation.reuseAt <= obligation.firstRead || obligation.reuseAt >= obligation.events.length) return { allowed: false, reason: "invalid read/reuse event range", obligation };
  const invalidating = obligation.events.slice(obligation.firstRead + 1, obligation.reuseAt + 1).find((event) => {
    if (event.kind === "suspend") return true;
    return ["mutate", "invalidate", "transfer", "escape"].includes(event.kind) && (!event.region || overlaps(obligation.region, event.region));
  });
  return invalidating
    ? { allowed: false, reason: `${invalidating.kind} may invalidate ${obligation.region}`, obligation }
    : { allowed: true, reason: "verified region has no overlapping invalidation", obligation };
}

export function applyStableReadReuse(source: string, obligation: StableReadReuseObligation, reuseSpan: { start: number; end: number }, stableBinding: string): StableReadRewrite {
  const decision = evaluateStableReadReuse(obligation);
  if (!decision.allowed) return { code: source, decision };
  if (!/^[A-Za-z_$][\w$]*$/.test(stableBinding) || reuseSpan.start < 0 || reuseSpan.end <= reuseSpan.start || reuseSpan.end > source.length) {
    return { code: source, decision: { ...decision, allowed: false, reason: "invalid rewrite span or stable binding" } };
  }
  return { code: `${source.slice(0, reuseSpan.start)}${stableBinding}${source.slice(reuseSpan.end)}`, decision };
}

export function evaluatePropertyMangle(obligation: PropertyMangleObligation): OptimizationDecision {
  if (!proofGrade(obligation.evidence)) return { allowed: false, reason: `${obligation.evidence} evidence cannot authorize a transformation`, obligation };
  if (!obligation.closedWorld) return { allowed: false, reason: "property universe is not closed", obligation };
  if (obligation.reflection) return { allowed: false, reason: "reflective property access is present", obligation };
  if (obligation.escaped) return { allowed: false, reason: "objects carrying the property escape", obligation };
  return { allowed: true, reason: "closed-world property has no reflection or escape", obligation };
}

export function evaluateOwnershipGuardElision(obligation: OwnershipGuardElisionObligation): OptimizationDecision {
  if (!obligation.generatedAssertion) return { allowed: false, reason: "user-authored Promise control flow cannot be elided by ownership evidence", obligation };
  if (!validateOwnershipEvidence(obligation.artifact, obligation.ownership)) return { allowed: false, reason: "ownership evidence is missing, stale, modified, or not proof-grade", obligation };
  return { allowed: true, reason: "generated ownership assertion is discharged by matching verifier evidence", obligation };
}

/** Removes only Uneffect-generated ownership assertions; it never rewrites user Promise control flow. */
export function applyOwnershipAssertionElision(source: string, obligation: OwnershipGuardElisionObligation, span: { start: number; end: number }): OwnershipAssertionRewrite {
  const decision = evaluateOwnershipGuardElision(obligation);
  if (!decision.allowed) return { code: source, decision };
  if (span.start < 0 || span.end <= span.start || span.end > source.length || !/^uneffectAssertOwnership\([\s\S]*\);?$/.test(source.slice(span.start, span.end).trim())) {
    return { code: source, decision: { ...decision, allowed: false, reason: "rewrite span is not an Uneffect-generated ownership assertion" } };
  }
  return { code: `${source.slice(0, span.start)}${source.slice(span.end)}`, decision };
}
