export const resourceProtocolSchema = "uneffect-resource-protocol/v1" as const;

export type ResourceProtocolState =
  | "absent"
  | "available"
  | "consumed"
  | "released"
  | "transferred"
  | "split"
  | "escaped"
  | "invalidated"
  | "unknown";

export type ResourceTerminalState = Extract<ResourceProtocolState,
  "consumed" | "released" | "transferred" | "escaped">;

export interface ResourceProtocolResource {
  /** Stable declaration/region identity. Labels are display-only. */
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly initialState: "absent" | "available";
  readonly requiredTerminalStates?: readonly ResourceTerminalState[];
}

interface ResourceTransitionBase {
  readonly at: number;
  readonly conditional?: boolean;
  readonly evidence?: "exact" | "trusted" | "unknown";
}

export type ResourceProtocolTransition =
  | (ResourceTransitionBase & { readonly kind: "acquire" | "use" | "consume" | "release" | "escape" | "invalidate"; readonly resource: string })
  | (ResourceTransitionBase & { readonly kind: "transfer"; readonly resource: string; readonly target?: string })
  | (ResourceTransitionBase & { readonly kind: "split"; readonly resource: string; readonly targets: readonly string[] })
  | (ResourceTransitionBase & { readonly kind: "join"; readonly resources: readonly string[]; readonly target: string });

export interface ResourceProtocolModel {
  readonly schema: typeof resourceProtocolSchema;
  readonly resources: readonly ResourceProtocolResource[];
  readonly transitions: readonly ResourceProtocolTransition[];
}

export interface ResourceProtocolDiagnostic {
  readonly code: "duplicate-resource" | "invalid-transition" | "unknown-resource";
  readonly resource: string;
  readonly state: ResourceProtocolState;
  readonly transition?: ResourceProtocolTransition["kind"];
  readonly at?: number;
  readonly message: string;
}

export interface ResourceProtocolEvaluation {
  readonly schema: typeof resourceProtocolSchema;
  readonly status: "satisfied" | "unsatisfied" | "unknown";
  readonly states: ReadonlyMap<string, ResourceProtocolState>;
  readonly diagnostics: readonly ResourceProtocolDiagnostic[];
}

function transitionResources(transition: ResourceProtocolTransition): readonly string[] {
  if (transition.kind === "join") return [...transition.resources, transition.target];
  if (transition.kind === "split") return [transition.resource, ...transition.targets];
  if (transition.kind === "transfer" && transition.target) return [transition.resource, transition.target];
  return [transition.resource];
}

export function evaluateResourceProtocol(model: ResourceProtocolModel): ResourceProtocolEvaluation {
  const resources = new Map<string, ResourceProtocolResource>();
  const states = new Map<string, ResourceProtocolState>();
  const diagnostics: ResourceProtocolDiagnostic[] = [];
  for (const resource of model.resources) {
    if (resources.has(resource.id)) {
      diagnostics.push({ code: "duplicate-resource", resource: resource.id, state: "unknown", message: `duplicate resource identity ${resource.id}` });
      states.set(resource.id, "unknown");
      continue;
    }
    resources.set(resource.id, resource);
    states.set(resource.id, resource.initialState);
  }

  const invalid = (transition: ResourceProtocolTransition, resource: string, state: ResourceProtocolState, message: string): void => {
    diagnostics.push({ code: "invalid-transition", resource, state, transition: transition.kind, at: transition.at, message });
    states.set(resource, "unknown");
  };
  const apply = (transition: ResourceProtocolTransition): void => {
    const referenced = transitionResources(transition);
    const missing = referenced.filter((id) => !resources.has(id));
    if (missing.length > 0) {
      for (const id of missing) diagnostics.push({
        code: "unknown-resource", resource: id, state: "unknown", transition: transition.kind, at: transition.at,
        message: `${transition.kind} references undeclared resource ${id}`,
      });
      for (const id of referenced.filter((candidate) => resources.has(candidate))) states.set(id, "unknown");
      return;
    }
    if (transition.kind === "acquire") {
      const state = states.get(transition.resource)!;
      if (state !== "absent") invalid(transition, transition.resource, state, `cannot acquire ${transition.resource} from ${state}`);
      else states.set(transition.resource, "available");
      return;
    }
    if (transition.kind === "use") {
      const state = states.get(transition.resource)!;
      if (state !== "available") invalid(transition, transition.resource, state, `cannot use ${transition.resource} from ${state}`);
      return;
    }
    if (transition.kind === "split") {
      const state = states.get(transition.resource)!;
      if (state !== "available") { invalid(transition, transition.resource, state, `cannot split ${transition.resource} from ${state}`); return; }
      const occupied = transition.targets.find((target) => states.get(target) !== "absent");
      if (occupied) { invalid(transition, occupied, states.get(occupied)!, `split target ${occupied} is already present`); return; }
      states.set(transition.resource, "split");
      for (const target of transition.targets) states.set(target, "available");
      return;
    }
    if (transition.kind === "join") {
      const invalidSource = transition.resources.find((resource) => !["consumed", "released", "transferred"].includes(states.get(resource)!));
      const targetState = states.get(transition.target)!;
      if (invalidSource || targetState !== "absent") {
        const resource = invalidSource ?? transition.target;
        invalid(transition, resource, states.get(resource)!, `cannot join into ${transition.target}`);
        return;
      }
      states.set(transition.target, "available");
      return;
    }
    const state = states.get(transition.resource)!;
    if (state !== "available") { invalid(transition, transition.resource, state, `cannot ${transition.kind} ${transition.resource} from ${state}`); return; }
    if (transition.kind === "consume") states.set(transition.resource, "consumed");
    else if (transition.kind === "release") states.set(transition.resource, "released");
    else if (transition.kind === "escape") states.set(transition.resource, "escaped");
    else if (transition.kind === "invalidate") states.set(transition.resource, "invalidated");
    else if (transition.kind === "transfer") {
      states.set(transition.resource, "transferred");
      if (transition.target) states.set(transition.target, "available");
    }
  };

  for (const transition of [...model.transitions].sort((left, right) => left.at - right.at)) {
    if (!transition.conditional && transition.evidence !== "unknown") { apply(transition); continue; }
    const before = new Map(states);
    apply(transition);
    for (const resource of transitionResources(transition)) {
      if (before.get(resource) !== states.get(resource)) states.set(resource, "unknown");
    }
  }

  const required = model.resources.filter((resource) => resource.requiredTerminalStates?.length);
  const unresolved = required.some((resource) => states.get(resource.id) === "unknown");
  const unsatisfied = required.some((resource) => !resource.requiredTerminalStates!.includes(states.get(resource.id) as ResourceTerminalState));
  return {
    schema: resourceProtocolSchema,
    status: diagnostics.length > 0 || unresolved ? "unknown" : unsatisfied ? "unsatisfied" : "satisfied",
    states,
    diagnostics,
  };
}
