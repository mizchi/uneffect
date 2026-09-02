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
    readonly status: "exact" | "exact-under-precondition";
    readonly precondition?: "all-listed-resources-acquired";
    readonly owner: string;
    readonly model: ResourceProtocolModel;
    readonly disposalOrder: readonly string[];
    readonly completions: readonly ResourceDisposalCompletion[];
    /** Acquisition failures form a prefix: failure skips later acquisitions and begins cleanup. */
    readonly initializerFailureResources: readonly string[];
    readonly initializerAwaitedResources: readonly string[];
    /** Resources skipped because their containing source control path is not taken. */
    readonly conditionalResources: readonly string[];
    /** One source loop whose binding declarations form a contiguous acquisition group. */
    readonly repeatedAcquisition?: { readonly controlId: string; readonly resources: readonly string[] };
  }
  | {
    readonly status: "unknown";
    readonly owner: string;
    readonly reasons: readonly ("repeated-acquisition" | "non-stack-acquisition-order" | "missing-disposal" | "duplicate-disposal" | "unknown-disposal")[];
  };

function resourceId(resource: Pick<ResourceBinding, "owner" | "scopeId" | "binding">): string {
  return `using:${resource.owner}:${resource.scopeId}:${resource.binding}`;
}

/**
 * Projects Explicit Resource Management into the common lifecycle IR.
 * Initializer failures are retained separately from source-conditional skips
 * so the temporal product can preserve prefix acquisition semantics.
 */
export function lowerResourceDisposalsToProtocol(
  resources: readonly ResourceBinding[],
  disposals: readonly ResourceDisposal[],
  owner: string,
): ResourceDisposalProtocolProjection {
  const ownedResources = resources.filter((resource) => resource.owner === owner)
    .sort((left, right) => left.acquisitionIndex - right.acquisitionIndex);
  const ownedDisposals = disposals.filter((disposal) => disposal.owner === owner);
  const reasons = new Set<"repeated-acquisition" | "non-stack-acquisition-order" | "missing-disposal" | "duplicate-disposal" | "unknown-disposal">();
  const loopIds = new Set(ownedResources.flatMap((resource) => resource.controlPaths.flatMap((path) =>
    path.filter((condition) => condition.id.includes("@loop:")).map((condition) => condition.id))));
  const repeated = ownedResources.filter((resource) => resource.controlPaths.some((path) => path.some((condition) => condition.id.includes("@loop:"))));
  const repeatedStart = repeated.length > 0 ? ownedResources.indexOf(repeated[0]!) : -1;
  const repeatedIsSuffix = repeatedStart >= 0 && ownedResources.slice(repeatedStart).every((resource) => repeated.includes(resource));
  if (loopIds.size > 1 || repeated.length > 0 && !repeatedIsSuffix) reasons.add("repeated-acquisition");
  for (const resource of ownedResources) {
    const matches = ownedDisposals.filter((disposal) => disposal.binding === resource.binding && disposal.scopeId === resource.scopeId);
    if (matches.length === 0) reasons.add("missing-disposal");
    if (matches.length > 1) reasons.add("duplicate-disposal");
  }
  for (const disposal of ownedDisposals) {
    if (!ownedResources.some((resource) => resource.binding === disposal.binding && resource.scopeId === disposal.scopeId)) reasons.add("unknown-disposal");
  }
  const sourceEvents = [
    ...ownedResources.map((resource) => ({ kind: "acquire" as const, at: resource.span.start, resource })),
    ...ownedDisposals.map((disposal, index) => ({
      kind: "release" as const, at: disposal.disposalPoint + index, disposal,
      resource: ownedResources.find((resource) => resource.binding === disposal.binding && resource.scopeId === disposal.scopeId)!,
    })),
  ].sort((left, right) => left.at - right.at);
  let releaseSeen = false;
  for (const event of sourceEvents) {
    if (event.kind === "release") releaseSeen = true;
    else if (releaseSeen) reasons.add("non-stack-acquisition-order");
  }
  if (reasons.size > 0) return { status: "unknown", owner, reasons: [...reasons] };

  const byKey = new Map(ownedResources.map((resource) => [`${resource.scopeId}:${resource.binding}`, resource] as const));
  const ordered = ownedDisposals.map((disposal) => ({ disposal, resource: byKey.get(`${disposal.scopeId}:${disposal.binding}`)! }));
  return {
    status: "exact",
    owner,
    model: {
      schema: "uneffect-resource-protocol/v1",
      resources: ownedResources.map((resource) => ({
        id: resourceId(resource), label: resource.binding, kind: resource.asynchronous ? "AsyncDisposable" : "Disposable",
        initialState: "absent", requiredTerminalStates: ["released"],
      })),
      transitions: sourceEvents.map((event) => event.kind === "acquire"
        ? ({ kind: "acquire" as const, resource: resourceId(event.resource), at: event.at, evidence: "exact" as const,
          ...((event.resource.conditional || event.resource.initializerMayFail) ? { conditional: true } : {}) })
        : ({ kind: "release" as const, resource: resourceId(event.resource), at: event.at, evidence: "exact" as const })),
    },
    disposalOrder: ordered.map(({ resource }) => resourceId(resource)),
    initializerFailureResources: ownedResources.filter((resource) => resource.initializerMayFail).map(resourceId),
    initializerAwaitedResources: ownedResources.filter((resource) => resource.initializerAwaited).map(resourceId),
    conditionalResources: ownedResources.filter((resource) => resource.conditional && !repeated.includes(resource)).map(resourceId),
    ...(loopIds.size === 1 && repeated.length > 0 ? { repeatedAcquisition: { controlId: [...loopIds][0]!, resources: repeated.map(resourceId) } } : {}),
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
