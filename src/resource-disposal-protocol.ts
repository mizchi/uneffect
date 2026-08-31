import type { ResourceBinding, ResourceDisposal } from "./async-safety.js";
import type { ResourceProtocolModel } from "./resource-protocol.js";

export interface ResourceDisposalCompletion {
  readonly resource: string;
  readonly lane: "inline" | "microtask";
  readonly failure: "throw" | "reject";
  readonly catchesFailure: boolean;
  readonly escapingFailure: ResourceDisposal["escapingFailure"];
  readonly exits: ResourceDisposal["exits"];
}

export type ResourceDisposalProtocolProjection =
  | {
    readonly status: "exact-under-precondition";
    readonly precondition: "all-listed-resources-acquired";
    readonly owner: string;
    readonly model: ResourceProtocolModel;
    readonly disposalOrder: readonly string[];
    readonly completions: readonly ResourceDisposalCompletion[];
  }
  | {
    readonly status: "unknown";
    readonly owner: string;
    readonly reasons: readonly ("conditional-acquisition" | "missing-disposal" | "duplicate-disposal" | "unknown-disposal")[];
  };

function resourceId(resource: Pick<ResourceBinding, "owner" | "scopeId" | "binding">): string {
  return `using:${resource.owner}:${resource.scopeId}:${resource.binding}`;
}

/**
 * Projects the acquired-resource suffix of Explicit Resource Management into
 * the common lifecycle IR. Initializer failure paths require a disjunctive
 * absent/available state and deliberately remain outside this first fragment.
 */
export function lowerResourceDisposalsToProtocol(
  resources: readonly ResourceBinding[],
  disposals: readonly ResourceDisposal[],
  owner: string,
): ResourceDisposalProtocolProjection {
  const ownedResources = resources.filter((resource) => resource.owner === owner)
    .sort((left, right) => left.acquisitionIndex - right.acquisitionIndex);
  const ownedDisposals = disposals.filter((disposal) => disposal.owner === owner);
  const reasons = new Set<"conditional-acquisition" | "missing-disposal" | "duplicate-disposal" | "unknown-disposal">();
  if (ownedResources.some((resource) => resource.conditional)) reasons.add("conditional-acquisition");
  for (const resource of ownedResources) {
    const matches = ownedDisposals.filter((disposal) => disposal.binding === resource.binding && disposal.scopeId === resource.scopeId);
    if (matches.length === 0) reasons.add("missing-disposal");
    if (matches.length > 1) reasons.add("duplicate-disposal");
  }
  for (const disposal of ownedDisposals) {
    if (!ownedResources.some((resource) => resource.binding === disposal.binding && resource.scopeId === disposal.scopeId)) reasons.add("unknown-disposal");
  }
  if (reasons.size > 0) return { status: "unknown", owner, reasons: [...reasons] };

  const byKey = new Map(ownedResources.map((resource) => [`${resource.scopeId}:${resource.binding}`, resource] as const));
  const ordered = ownedDisposals.map((disposal) => ({ disposal, resource: byKey.get(`${disposal.scopeId}:${disposal.binding}`)! }));
  return {
    status: "exact-under-precondition",
    precondition: "all-listed-resources-acquired",
    owner,
    model: {
      schema: "uneffect-resource-protocol/v1",
      resources: ownedResources.map((resource) => ({
        id: resourceId(resource), label: resource.binding, kind: resource.asynchronous ? "AsyncDisposable" : "Disposable",
        initialState: "absent", requiredTerminalStates: ["released"],
      })),
      transitions: [
        ...ownedResources.map((resource) => ({ kind: "acquire" as const, resource: resourceId(resource), at: resource.span.start, evidence: "exact" as const })),
        ...ordered.map(({ disposal, resource }, index) => ({
          kind: "release" as const, resource: resourceId(resource), at: disposal.disposalPoint + index, evidence: "exact" as const,
        })),
      ],
    },
    disposalOrder: ordered.map(({ resource }) => resourceId(resource)),
    completions: ordered.map(({ disposal, resource }) => ({
      resource: resourceId(resource),
      lane: disposal.asynchronous ? "microtask" : "inline",
      failure: disposal.failureKind,
      catchesFailure: disposal.catchesFailure,
      escapingFailure: disposal.escapingFailure,
      exits: disposal.exits,
    })),
  };
}
