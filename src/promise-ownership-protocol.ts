import type { PromiseBinding } from "./async-safety.js";
import type { ResourceProtocolModel, ResourceProtocolTransition } from "./resource-protocol.js";

export interface PromiseOwnershipProtocolProjection {
  readonly model: ResourceProtocolModel;
  readonly resources: ReadonlyMap<string, PromiseBinding>;
}

function promiseResourceId(binding: PromiseBinding, index: number): string {
  return `promise:${binding.owner}:${binding.span.start}:${binding.binding}:${index}`;
}

/** Projects binding-level rejection ownership into the common resource IR. */
export function lowerPromiseOwnershipToResourceProtocol(
  bindings: readonly PromiseBinding[],
): PromiseOwnershipProtocolProjection {
  const resources = new Map<string, PromiseBinding>();
  const transitions: ResourceProtocolTransition[] = [];
  bindings.forEach((binding, index) => {
    const id = promiseResourceId(binding, index);
    resources.set(id, binding);
    if (binding.status === "observed") transitions.push({ kind: "consume", resource: id, at: binding.span.end, evidence: "exact" });
    if (binding.status === "transferred") transitions.push({ kind: "transfer", resource: id, at: binding.span.end, evidence: "exact" });
  });
  return {
    model: {
      schema: "uneffect-resource-protocol/v1",
      resources: [...resources].map(([id, binding]) => ({
        id,
        label: `${binding.owner}.${binding.binding}`,
        kind: "PromiseRejectionOwnership",
        initialState: "available" as const,
        requiredTerminalStates: ["consumed", "transferred"] as const,
      })),
      transitions,
    },
    resources,
  };
}
