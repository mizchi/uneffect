import type { ResourceDisposal } from "./async-safety.js";
import { lowerResourceDisposalTransitions, type HostNeutralTransition } from "./host-neutral-transitions.js";
import type { ResourceDisposalProtocolProjection } from "./resource-disposal-protocol.js";
import { evaluateResourceProtocol, type ResourceProtocolEvaluation, type ResourceProtocolModel } from "./resource-protocol.js";

export const resourceTemporalProductSchema = "uneffect-resource-temporal-product/v1" as const;

export interface ResourceTemporalLink {
  readonly resourceTransition: number;
  readonly hostTransitionId: string;
  readonly relation: "inline" | "await-completion";
}

export interface ResourceTemporalProduct {
  readonly schema: typeof resourceTemporalProductSchema;
  readonly owner: string;
  readonly evidence: "exact-under-precondition";
  readonly precondition?: string;
  readonly resource: ResourceProtocolModel;
  readonly host: readonly HostNeutralTransition[];
  readonly links: readonly ResourceTemporalLink[];
}

export interface ResourceTemporalProductEvaluation {
  readonly status: "satisfied" | "unsatisfied" | "unknown";
  readonly resource: ResourceProtocolEvaluation;
  readonly evidence: "exact-under-precondition";
  readonly preconditions: readonly string[];
  readonly reasons: readonly string[];
}

export type ResourceDisposalTemporalProductResult =
  | { readonly status: "ready"; readonly product: ResourceTemporalProduct }
  | { readonly status: "unknown"; readonly reasons: readonly string[] };

/** Connects the acquired-resource disposal suffix to neutral host scheduling. */
export function createResourceDisposalTemporalProduct(
  fileName: string,
  projection: ResourceDisposalProtocolProjection,
  disposals: readonly ResourceDisposal[],
): ResourceDisposalTemporalProductResult {
  if (projection.status === "unknown") return { status: "unknown", reasons: projection.reasons };
  const selected = disposals.filter((disposal) => disposal.owner === projection.owner);
  const host = lowerResourceDisposalTransitions(fileName, selected);
  const releaseIndexes = projection.model.transitions.flatMap((transition, index) => transition.kind === "release" ? [index] : []);
  if (releaseIndexes.length !== host.length) return { status: "unknown", reasons: ["resource/host disposal count mismatch"] };
  return {
    status: "ready",
    product: {
      schema: resourceTemporalProductSchema,
      owner: projection.owner,
      evidence: "exact-under-precondition",
      precondition: projection.precondition,
      resource: projection.model,
      host,
      links: releaseIndexes.map((resourceTransition, index) => ({
        resourceTransition,
        hostTransitionId: host[index]!.id,
        relation: host[index]!.lane === "microtask" ? "await-completion" : "inline",
      })),
    },
  };
}

/** Validates the shared resource/host product without claiming scheduler fairness. */
export function evaluateResourceTemporalProduct(product: ResourceTemporalProduct): ResourceTemporalProductEvaluation {
  const resource = evaluateResourceProtocol(product.resource);
  const reasons: string[] = [];
  const hostById = new Map(product.host.map((transition) => [transition.id, transition] as const));
  const linked = new Set<number>();
  for (const link of product.links) {
    const transition = product.resource.transitions[link.resourceTransition];
    const host = hostById.get(link.hostTransitionId);
    if (!transition) { reasons.push(`dangling resource transition ${link.resourceTransition}`); continue; }
    if (!host) { reasons.push(`dangling host transition ${link.hostTransitionId}`); continue; }
    if (linked.has(link.resourceTransition)) reasons.push(`duplicate resource temporal link ${link.resourceTransition}`);
    linked.add(link.resourceTransition);
    if (transition.kind !== "release") reasons.push(`temporal link ${link.resourceTransition} does not reference release`);
    if (host.kind !== "dispose-resource") reasons.push(`temporal link ${link.resourceTransition} does not target resource disposal`);
    else {
      const definition = "resource" in transition
        ? product.resource.resources.find((resource) => resource.id === transition.resource) : undefined;
      if (!definition || definition.label !== host.resource) reasons.push(`resource identity mismatch at temporal link ${link.resourceTransition}`);
    }
    if (link.relation === "inline" && host.lane !== "inline") reasons.push(`inline link ${link.resourceTransition} targets ${host.lane}`);
    if (link.relation === "await-completion" && host.lane !== "microtask") reasons.push(`await-completion link ${link.resourceTransition} targets ${host.lane}`);
  }
  product.resource.transitions.forEach((transition, index) => {
    if (transition.kind === "release" && !linked.has(index)) reasons.push(`release transition ${index} has no host completion link`);
  });
  return {
    status: reasons.length > 0 || resource.status === "unknown" ? "unknown" : resource.status,
    resource,
    evidence: "exact-under-precondition",
    preconditions: product.precondition ? [product.precondition] : [],
    reasons,
  };
}
