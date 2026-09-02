import type { PromiseBinding } from "./async-safety.js";
import { bindingIdentityKey } from "./binding-identity.js";
import { evaluateResourceProtocol } from "./resource-protocol.js";
import type { ResourceProtocolModel, ResourceProtocolTransition } from "./resource-protocol.js";

export interface PromiseOwnershipProtocolProjection {
  readonly model: ResourceProtocolModel;
  readonly resources: ReadonlyMap<string, PromiseBinding>;
}

function promiseResourceId(binding: PromiseBinding, index: number): string {
  return binding.identity ? `promise:${bindingIdentityKey(binding.identity)}${binding.generation > 0 ? `:generation:${binding.generation}` : ""}`
    : `promise:${binding.owner}:${binding.span.start}:${binding.binding}:${index}`;
}

/** Projects binding-level rejection ownership into the common resource IR. */
export function lowerPromiseOwnershipToResourceProtocol(
  bindings: readonly PromiseBinding[],
): PromiseOwnershipProtocolProjection {
  const resources = new Map<string, PromiseBinding>();
  const transitions: ResourceProtocolTransition[] = [];
  bindings.forEach((binding, index) => {
    const id = promiseResourceId(binding, index);
    if (resources.has(id)) return;
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

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/gu, "_");
}

/**
 * Emits the bounded Promise-ownership projection used by the unified temporal
 * facade. This is intentionally not a standalone public backend: callers
 * should use `generateTemporalModel` so the host profile and exclusions remain
 * attached to the evidence.
 */
export function generatePromiseOwnershipTemporalQuint(
  moduleName: string,
  projection: PromiseOwnershipProtocolProjection,
  propertyName = "promiseOwnershipSafe",
): string {
  const evaluation = evaluateResourceProtocol(projection.model);
  if (evaluation.status === "unknown") {
    throw new Error(`Promise ownership projection is not executable: ${evaluation.diagnostics.map(({ message }) => message).join("; ")}`);
  }
  const resources = projection.model.resources;
  const indexes = new Map(resources.map((resource, index) => [resource.id, index] as const));
  const transitions = projection.model.transitions;
  const lines = [
    `module ${safeIdentifier(moduleName)} {`,
    "  var pc: int",
    ...resources.map((_, index) => `  var resource_${index}: int`),
    "",
    "  action init = all {",
    "    pc' = 0,",
    ...resources.map((_, index) => `    resource_${index}' = 1,`),
    "  }",
  ];
  const actions: string[] = [];
  transitions.forEach((transition, transitionIndex) => {
    if (transition.kind !== "consume" && transition.kind !== "transfer") {
      throw new Error(`Promise ownership temporal projection does not support ${transition.kind}`);
    }
    const resourceIndex = indexes.get(transition.resource);
    if (resourceIndex === undefined) throw new Error(`unknown Promise ownership resource ${transition.resource}`);
    const action = `${transition.kind}_${transitionIndex}`;
    actions.push(action);
    lines.push(
      "",
      `  action ${action} = all {`,
      `    pc == ${transitionIndex},`,
      `    resource_${resourceIndex} == 1,`,
      `    pc' = ${transitionIndex + 1},`,
      ...resources.map((_, index) => `    resource_${index}' = ${index === resourceIndex ? (transition.kind === "consume" ? "2" : "3") : `resource_${index}`},`),
      "  }",
    );
  });
  lines.push("", "  action step = any {");
  if (actions.length === 0) lines.push("    all { pc' = pc,", ...resources.map((_, index) => `      resource_${index}' = resource_${index},`), "    },");
  else lines.push(...actions.map((action) => `    ${action},`));
  lines.push("  }");
  const terminal = resources.map((resource, index) => {
    const accepted = resource.requiredTerminalStates ?? [];
    const states = [accepted.includes("consumed") ? `resource_${index} == 2` : "", accepted.includes("transferred") ? `resource_${index} == 3` : ""].filter(Boolean);
    return `(${states.join(" or ") || "false"})`;
  }).join(" and ") || "true";
  lines.push("", `  val ${safeIdentifier(propertyName)} = pc != ${transitions.length} or (${terminal})`, "}", "");
  return lines.join("\n");
}
