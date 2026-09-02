import { solveBasicBlockFixedPoint, type FixedPointBudget, type FixedPointLattice } from "./refinement-flow.js";

export const resourceProtocolSchema = "uneffect-resource-protocol/v1" as const;
export const resourceProtocolCfgSchema = "uneffect-resource-protocol-cfg/v1" as const;
export const resourceCallableSummarySchema = "uneffect-resource-callable-summary/v1" as const;

export type ResourceProtocolState =
  | "absent"
  | "available"
  | "consumed"
  | "released"
  | "transferred"
  | "split"
  | "escaped"
  | "invalidated"
  | "absent-or-available"
  | "absent-or-released"
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

/** A resource position in a callable contract. Names are diagnostic-only. */
export type ResourceCallableReference =
  | { readonly kind: "parameter"; readonly index: number; readonly name?: string }
  | { readonly kind: "receiver" }
  | { readonly kind: "return" };

export interface ResourceCallableOperation {
  readonly kind: "acquire" | "use" | "borrow" | "consume" | "release" | "transfer" | "escape";
  readonly subject: ResourceCallableReference;
  /** A transfer target, commonly the returned resource identity. */
  readonly target?: ResourceCallableReference;
}

/** Backend-neutral ownership contract. Frontends must authenticate its evidence. */
export interface ResourceCallableSummary {
  readonly schema: typeof resourceCallableSummarySchema;
  readonly id: string;
  readonly evidence: "trusted" | "verified";
  readonly operations: readonly ResourceCallableOperation[];
  readonly returnMembers?: readonly {
    readonly key: string;
    readonly operations: readonly ResourceCallableOperation[];
  }[];
}

export interface ResourceCallableBindings {
  readonly parameters: ReadonlyMap<number, string>;
  readonly receiverResource?: string;
  readonly returnResource?: string;
  readonly at: number;
}

export interface ResourceCallableInstantiation {
  readonly status: "exact" | "trusted" | "unknown";
  /** Resources introduced by acquire operations at this call site. */
  readonly resources: readonly ResourceProtocolResource[];
  readonly transitions: readonly ResourceProtocolTransition[];
  readonly missing: readonly { readonly operation: number; readonly reference: ResourceCallableReference }[];
}

function resolveCallableResource(reference: ResourceCallableReference, bindings: ResourceCallableBindings): string | undefined {
  return reference.kind === "return" ? bindings.returnResource
    : reference.kind === "receiver" ? bindings.receiverResource : bindings.parameters.get(reference.index);
}

/** Instantiates a callable ownership contract at one source-bound call site. */
export function instantiateResourceCallableSummary(
  summary: ResourceCallableSummary,
  bindings: ResourceCallableBindings,
): ResourceCallableInstantiation {
  const resources: ResourceProtocolResource[] = [];
  const transitions: ResourceProtocolTransition[] = [];
  const missing: { operation: number; reference: ResourceCallableReference }[] = [];
  const evidence = summary.evidence === "verified" ? "exact" as const : "trusted" as const;
  summary.operations.forEach((operation, index) => {
    const resource = resolveCallableResource(operation.subject, bindings);
    const target = operation.kind === "transfer" && operation.target
      ? resolveCallableResource(operation.target, bindings) : undefined;
    if (!resource) missing.push({ operation: index, reference: operation.subject });
    if (operation.kind === "transfer" && operation.target && !target) missing.push({ operation: index, reference: operation.target });
    if (!resource || (operation.kind === "transfer" && operation.target && !target)) return;
    const base = { resource, at: bindings.at, evidence };
    if (operation.kind === "acquire") {
      resources.push({
        id: resource,
        label: `${operation.subject.kind === "return" ? "return" : operation.subject.kind === "receiver" ? "receiver" : operation.subject.name ?? `parameter ${operation.subject.index}`} of ${summary.id}`,
        kind: "Resource",
        initialState: "absent",
        requiredTerminalStates: ["released", "consumed", "transferred", "escaped"],
      });
      transitions.push({ ...base, kind: "acquire" });
    } else if (operation.kind === "borrow" || operation.kind === "use") transitions.push({ ...base, kind: "use" });
    else if (operation.kind === "transfer") transitions.push({ ...base, kind: "transfer", ...(target ? { target } : {}) });
    else transitions.push({ ...base, kind: operation.kind });
  });
  return {
    status: missing.length > 0 ? "unknown" : summary.evidence === "verified" ? "exact" : "trusted",
    resources,
    transitions,
    missing,
  };
}

export interface ResourceProtocolDiagnostic {
  readonly code: "cfg-unknown" | "duplicate-resource" | "invalid-transition" | "unknown-resource";
  readonly resource: string;
  readonly state: ResourceProtocolState;
  readonly transition?: ResourceProtocolTransition["kind"];
  readonly at?: number;
  readonly message: string;
}

export interface ResourceProtocolBlock {
  readonly id: string;
  readonly transitions: readonly ResourceProtocolTransition[];
  readonly successors: readonly string[];
}

export interface ResourceProtocolCfg {
  readonly schema: typeof resourceProtocolCfgSchema;
  readonly model: ResourceProtocolModel;
  readonly entry: string;
  readonly exits: readonly string[];
  readonly blocks: readonly ResourceProtocolBlock[];
  readonly budget: FixedPointBudget;
}

export interface ResourceProtocolCfgEvaluation extends ResourceProtocolEvaluation {
  readonly cfgSchema: typeof resourceProtocolCfgSchema;
  readonly iterations: number;
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

export function evaluateResourceProtocol(
  model: ResourceProtocolModel,
  initialStates?: ReadonlyMap<string, ResourceProtocolState>,
): ResourceProtocolEvaluation {
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
    states.set(resource.id, initialStates?.get(resource.id) ?? resource.initialState);
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
    if (transition.kind === "release" && state === "absent-or-available") {
      states.set(transition.resource, "absent-or-released");
      return;
    }
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
      const previous = before.get(resource);
      const next = states.get(resource);
      if (previous === next) continue;
      if (transition.kind === "acquire" && previous === "absent" && next === "available") {
        states.set(resource, "absent-or-available");
      } else states.set(resource, "unknown");
    }
  }

  return {
    schema: resourceProtocolSchema,
    status: terminalStatus(model.resources, states, diagnostics),
    states,
    diagnostics,
  };
}

interface ResourceFlowState {
  readonly reachable: boolean;
  readonly states: ReadonlyMap<string, ResourceProtocolState>;
  readonly diagnostics: readonly ResourceProtocolDiagnostic[];
}

function diagnosticKey(diagnostic: ResourceProtocolDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.resource}:${diagnostic.state}:${diagnostic.transition ?? ""}:${diagnostic.at ?? ""}:${diagnostic.message}`;
}

function mergeDiagnostics(
  left: readonly ResourceProtocolDiagnostic[],
  right: readonly ResourceProtocolDiagnostic[],
): readonly ResourceProtocolDiagnostic[] {
  const merged = new Map<string, ResourceProtocolDiagnostic>();
  for (const diagnostic of [...left, ...right]) merged.set(diagnosticKey(diagnostic), diagnostic);
  return [...merged.values()];
}

function terminalStatus(
  resources: readonly ResourceProtocolResource[],
  states: ReadonlyMap<string, ResourceProtocolState>,
  diagnostics: readonly ResourceProtocolDiagnostic[],
): ResourceProtocolEvaluation["status"] {
  const required = resources.filter((resource) => resource.requiredTerminalStates?.length);
  const unresolved = required.some((resource) => states.get(resource.id) === "unknown");
  const accepted = (resource: ResourceProtocolResource): boolean => {
    const state = states.get(resource.id);
    return state === "absent-or-released" && resource.requiredTerminalStates!.includes("released")
      || resource.requiredTerminalStates!.includes(state as ResourceTerminalState);
  };
  const unsatisfied = required.some((resource) => !accepted(resource));
  return diagnostics.length > 0 || unresolved ? "unknown" : unsatisfied ? "unsatisfied" : "satisfied";
}

export function evaluateResourceProtocolCfg(cfg: ResourceProtocolCfg): ResourceProtocolCfgEvaluation {
  const resourceIds = cfg.model.resources.map((resource) => resource.id);
  const bottom = (): ResourceFlowState => ({ reachable: false, states: new Map(), diagnostics: [] });
  const joinStates = (left: ResourceFlowState, right: ResourceFlowState): ResourceFlowState => {
    if (!left.reachable) return right;
    if (!right.reachable) return left;
    const states = new Map<string, ResourceProtocolState>();
    for (const id of resourceIds) {
      const leftState = left.states.get(id) ?? "unknown";
      const rightState = right.states.get(id) ?? "unknown";
      states.set(id, leftState === rightState ? leftState : "unknown");
    }
    return { reachable: true, states, diagnostics: mergeDiagnostics(left.diagnostics, right.diagnostics) };
  };
  const equivalent = (left: ResourceFlowState, right: ResourceFlowState): boolean => {
    if (left.reachable !== right.reachable || left.diagnostics.length !== right.diagnostics.length) return false;
    if (left.diagnostics.some((diagnostic) => !right.diagnostics.some((candidate) => diagnosticKey(candidate) === diagnosticKey(diagnostic)))) return false;
    return resourceIds.every((id) => left.states.get(id) === right.states.get(id));
  };
  const lattice: FixedPointLattice<ResourceFlowState> = {
    bottom,
    equivalent,
    join: (left, right) => ({ status: "joined", value: joinStates(left, right) }),
  };
  const applyBlock = (input: ResourceFlowState, block: ResourceProtocolBlock): ResourceFlowState => {
    if (!input.reachable) return input;
    const evaluation = evaluateResourceProtocol({ ...cfg.model, transitions: block.transitions }, input.states);
    return {
      reachable: true,
      states: evaluation.states,
      diagnostics: mergeDiagnostics(input.diagnostics, evaluation.diagnostics),
    };
  };
  const initialStates = new Map(cfg.model.resources.map((resource) => [resource.id, resource.initialState]));
  const result = solveBasicBlockFixedPoint<ResourceFlowState>({
    entry: cfg.entry,
    initial: { reachable: true, states: initialStates, diagnostics: [] },
    budget: cfg.budget,
    lattice,
    blocks: cfg.blocks.map((block) => ({
      id: block.id,
      transfer: (input) => {
        const output = applyBlock(input, block);
        return block.successors.map((to) => ({ to, value: output }));
      },
    })),
  });
  if (result.status === "unknown") {
    const diagnostic: ResourceProtocolDiagnostic = {
      code: "cfg-unknown", resource: "<cfg>", state: "unknown",
      message: `${result.reason}: ${result.detail}`,
    };
    return {
      schema: resourceProtocolSchema,
      cfgSchema: resourceProtocolCfgSchema,
      status: "unknown",
      states: new Map(resourceIds.map((id) => [id, "unknown" as const])),
      diagnostics: [diagnostic],
      iterations: result.iterations,
    };
  }
  let terminal = bottom();
  for (const exit of cfg.exits) {
    const block = cfg.blocks.find((candidate) => candidate.id === exit);
    const entryState = result.states.get(exit);
    if (block && entryState) terminal = joinStates(terminal, applyBlock(entryState, block));
  }
  if (!terminal.reachable) {
    const diagnostic: ResourceProtocolDiagnostic = {
      code: "cfg-unknown", resource: "<cfg>", state: "unknown", message: "no configured CFG exit is reachable",
    };
    return {
      schema: resourceProtocolSchema, cfgSchema: resourceProtocolCfgSchema, status: "unknown",
      states: new Map(resourceIds.map((id) => [id, "unknown" as const])), diagnostics: [diagnostic], iterations: result.iterations,
    };
  }
  return {
    schema: resourceProtocolSchema,
    cfgSchema: resourceProtocolCfgSchema,
    status: terminalStatus(cfg.model.resources, terminal.states, terminal.diagnostics),
    states: terminal.states,
    diagnostics: terminal.diagnostics,
    iterations: result.iterations,
  };
}
