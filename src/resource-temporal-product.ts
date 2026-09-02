import type { ResourceDisposal } from "./async-safety.js";
import { lowerResourceDisposalTransitions, type HostNeutralTransition } from "./host-neutral-transitions.js";
import type { ResourceDisposalCompletion, ResourceDisposalProtocolProjection } from "./resource-disposal-protocol.js";
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
  readonly evidence: "exact" | "exact-under-precondition";
  readonly precondition?: string;
  readonly resource: ResourceProtocolModel;
  readonly host: readonly HostNeutralTransition[];
  readonly links: readonly ResourceTemporalLink[];
  readonly optionalResources?: readonly string[];
  readonly conditionalResources?: readonly string[];
  readonly initializerFailureResources?: readonly string[];
  readonly initializerAwaitedResources?: readonly string[];
  readonly repeatedAcquisition?: { readonly controlId: string; readonly resources: readonly string[] };
  readonly completions?: readonly ResourceDisposalCompletion[];
}

export interface ResourceTemporalProductEvaluation {
  readonly status: "satisfied" | "unsatisfied" | "unknown";
  readonly resource: ResourceProtocolEvaluation;
  readonly evidence: "exact" | "exact-under-precondition";
  readonly preconditions: readonly string[];
  readonly reasons: readonly string[];
}

export interface GenerateResourceTemporalProductQuintOptions {
  /** Negative-control hook proving that the microtask invariant is load-bearing. */
  readonly resumeOutsideMicrotask?: boolean;
  readonly propertyName?: string;
  /** Negative-control hook proving that multiple disposal failures are suppressed. */
  readonly dropSuppression?: boolean;
  /** Negative-control hook proving that suppression parent identity is checked. */
  readonly corruptSuppressionParent?: boolean;
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
      evidence: projection.status,
      precondition: projection.precondition,
      resource: projection.model,
      host,
      links: releaseIndexes.map((resourceTransition, index) => ({
        resourceTransition,
        hostTransitionId: host[index]!.id,
        relation: host[index]!.lane === "microtask" ? "await-completion" : "inline",
      })),
      optionalResources: [...new Set([...projection.conditionalResources, ...projection.initializerFailureResources])],
      conditionalResources: projection.conditionalResources,
      initializerFailureResources: projection.initializerFailureResources,
      initializerAwaitedResources: projection.initializerAwaitedResources,
      repeatedAcquisition: projection.repeatedAcquisition,
      completions: projection.completions,
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
    evidence: product.evidence,
    preconditions: product.precondition ? [product.precondition] : [],
    reasons,
  };
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_");
}

/** Generates the first executable acquire/release product backend. */
export function generateResourceTemporalProductQuint(
  moduleName: string,
  product: ResourceTemporalProduct,
  options: GenerateResourceTemporalProductQuintOptions = {},
): string {
  const evaluation = evaluateResourceTemporalProduct(product);
  if (evaluation.status !== "satisfied") throw new Error(`resource temporal product is not executable: ${evaluation.reasons.join("; ") || evaluation.resource.status}`);
  const unsupported = product.resource.transitions.find((transition) => transition.kind !== "acquire" && transition.kind !== "release");
  if (unsupported) throw new Error(`resource temporal Quint backend does not support ${unsupported.kind}`);
  const links = new Map(product.links.map((link) => [link.resourceTransition, link] as const));
  const propertyName = safe(options.propertyName ?? "resourceTemporalSafe");
  const resourceIndexes = new Map(product.resource.resources.map((resource, index) => [resource.id, index] as const));
  const optionalResources = new Set(product.optionalResources ?? []);
  const conditionalResources = new Set(product.conditionalResources ?? []);
  const initializerFailureResources = new Set(product.initializerFailureResources ?? []);
  const initializerAwaitedResources = new Set(product.initializerAwaitedResources ?? []);
  const acquisitionCount = product.resource.transitions.filter((transition) => transition.kind === "acquire").length;
  const repeatedResources = new Set(product.repeatedAcquisition?.resources ?? []);
  const repeatedAcquireIndexes = product.resource.transitions.flatMap((transition, index) =>
    transition.kind === "acquire" && repeatedResources.has(transition.resource) ? [index] : []);
  const repeatedReleaseIndexes = product.resource.transitions.flatMap((transition, index) =>
    transition.kind === "release" && repeatedResources.has(transition.resource) ? [index] : []);
  const releaseIndexesWithFailure = product.resource.transitions.flatMap((transition, index) =>
    transition.kind === "release" && product.completions?.some((completion) => completion.resource === transition.resource) ? [index] : []);
  const firstRepeatedAcquire = repeatedAcquireIndexes[0];
  const finalRepeatedRelease = repeatedReleaseIndexes.at(-1);
  const afterRepeatedRelease = finalRepeatedRelease === undefined ? undefined : finalRepeatedRelease + 1;
  if (product.resource.resources.some((resource) => !["absent", "available"].includes(resource.initialState))) {
    throw new Error("resource temporal Quint backend requires absent/available initial states");
  }
  const lines = [
    `module ${safe(moduleName)} {`,
    "  var pc: int",
    "  // 0 = inline/task continuation, 1 = microtask checkpoint",
    "  var host_phase: int",
    "  var pending_transition: int",
    "  var temporal_order_broken: bool",
    "  var disposal_failure_count: int",
    "  var suppressed_failure: bool",
    "  // 0 = normal completion, 1 = body failure, 1000+n = initializer failure, n+2 = disposer failure",
    "  var active_failure: int",
    ...releaseIndexesWithFailure.map((index) => `  var failure_parent_${index}: int`),
    ...product.resource.resources.map((_, index) => `  var resource_${index}: int`),
    "",
    "  action init = all {",
    "    pc' = 0,",
    "    host_phase' = 0,",
    "    pending_transition' = -1,",
    "    temporal_order_broken' = false,",
    "    disposal_failure_count' = 0,",
    "    suppressed_failure' = false,",
    "    active_failure' = 0,",
    ...releaseIndexesWithFailure.map((index) => `    failure_parent_${index}' = -1,`),
    ...product.resource.resources.map((resource, index) => `    resource_${index}' = ${resource.initialState === "available" ? 1 : 0},`),
    "  }",
  ];
  const actions: string[] = [];
  const emit = (name: string, guards: readonly string[], updates: ReadonlyMap<string, string>): void => {
    actions.push(name);
    lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`),
      `    pc' = ${updates.get("pc") ?? "pc"},`,
      `    host_phase' = ${updates.get("host_phase") ?? "host_phase"},`,
      `    pending_transition' = ${updates.get("pending_transition") ?? "pending_transition"},`,
      `    temporal_order_broken' = ${updates.get("temporal_order_broken") ?? "temporal_order_broken"},`,
      `    disposal_failure_count' = ${updates.get("disposal_failure_count") ?? "disposal_failure_count"},`,
      `    suppressed_failure' = ${updates.get("suppressed_failure") ?? "suppressed_failure"},`,
      `    active_failure' = ${updates.get("active_failure") ?? "active_failure"},`,
      ...releaseIndexesWithFailure.map((index) => `    failure_parent_${index}' = ${updates.get(`failure_parent_${index}`) ?? `failure_parent_${index}`},`),
      ...product.resource.resources.map((_, index) => `    resource_${index}' = ${updates.get(`resource_${index}`) ?? `resource_${index}`},`),
      "  }");
  };
  const firstRelease = product.resource.transitions.findIndex((transition) => transition.kind === "release");
  if (firstRelease >= 0) emit("enter_cleanup_throw", [`pc == ${firstRelease}`, "pending_transition == -1", "active_failure == 0"],
    new Map([["active_failure", "1"]]));
  product.resource.transitions.forEach((transition, index) => {
    if (!("resource" in transition)) return;
    const resource = resourceIndexes.get(transition.resource);
    if (resource === undefined) throw new Error(`resource temporal transition ${index} references unknown resource ${transition.resource}`);
    const link = links.get(index);
    const completion = product.completions?.find((candidate) => candidate.resource === transition.resource);
    if (transition.kind === "acquire") {
      const awaitedInitializer = initializerAwaitedResources.has(transition.resource);
      const initializerPending = String(-(index + 2));
      if (awaitedInitializer) {
        emit(`acquire_start_${index}`, [`pc == ${index}`, `resource_${resource} == 0`, "host_phase == 0", "pending_transition == -1"],
          new Map([["host_phase", "1"], ["pending_transition", initializerPending]]));
        emit(`acquire_resume_${index}`, [`pc == ${index}`, `resource_${resource} == 0`, "host_phase == 1", `pending_transition == ${initializerPending}`],
          new Map([["pc", String(index + 1)], ["host_phase", "0"], ["pending_transition", "-1"], [`resource_${resource}`, "1"]]));
        emit(`fail_acquire_reject_${index}`, [`pc == ${index}`, `resource_${resource} == 0`, "host_phase == 1", `pending_transition == ${initializerPending}`],
          new Map([["pc", String(acquisitionCount)], ["host_phase", "0"], ["pending_transition", "-1"], ["active_failure", String(1000 + index)]]));
        if (options.resumeOutsideMicrotask) emit(`acquire_resume_outside_microtask_${index}`,
          [`pc == ${index}`, `resource_${resource} == 0`, `pending_transition == ${initializerPending}`],
          new Map([["pc", String(index + 1)], ["host_phase", "0"], ["pending_transition", "-1"],
            ["temporal_order_broken", "true"], [`resource_${resource}`, "1"]]));
      } else {
        emit(`acquire_${index}`, [`pc == ${index}`, `resource_${resource} == 0`, "pending_transition == -1"],
          new Map([["pc", String(index + 1)], [`resource_${resource}`, "1"]]));
      }
      if (conditionalResources.has(transition.resource)) emit(`skip_acquire_${index}`, [`pc == ${index}`, `resource_${resource} == 0`, "pending_transition == -1"],
        new Map([["pc", String(index + 1)]]));
      if (initializerFailureResources.has(transition.resource)) emit(awaitedInitializer ? `fail_acquire_inline_${index}` : `fail_acquire_${index}`, [`pc == ${index}`, `resource_${resource} == 0`, "pending_transition == -1"],
        new Map([["pc", String(acquisitionCount)], ["active_failure", String(1000 + index)]]));
      if (index === firstRepeatedAcquire && afterRepeatedRelease !== undefined) emit(`exit_repeat_${index}`, [`pc == ${index}`, "pending_transition == -1"],
        new Map([["pc", String(afterRepeatedRelease)]]));
    } else if (link?.relation === "await-completion") {
      emit(`release_start_${index}`, [`pc == ${index}`, `resource_${resource} == 1`, "pending_transition == -1"],
        new Map([["host_phase", "1"], ["pending_transition", String(index)]]));
      emit(`release_resume_${index}`, [`pc == ${index}`, "host_phase == 1", `pending_transition == ${index}`],
        new Map([["pc", String(index + 1)], ["pending_transition", "-1"], [`resource_${resource}`, "2"]]));
      if (index === finalRepeatedRelease && firstRepeatedAcquire !== undefined) emit(`release_resume_repeat_${index}`,
        [`pc == ${index}`, "host_phase == 1", `pending_transition == ${index}`, "active_failure == 0"],
        new Map([["pc", String(firstRepeatedAcquire)], ["pending_transition", "-1"], ["host_phase", "0"],
          ...[...repeatedResources].map((id) => [`resource_${resourceIndexes.get(id)!}`, "0"] as [string, string])]));
      if (completion) emit(`release_${completion.failure}_${index}`,
        [`pc == ${index}`, "host_phase == 1", `pending_transition == ${index}`],
        new Map([["pc", String(index + 1)], ["pending_transition", "-1"], [`resource_${resource}`, "2"],
          ["disposal_failure_count", "disposal_failure_count + 1"],
          ["suppressed_failure", options.dropSuppression ? "suppressed_failure" : "if (active_failure != 0) true else suppressed_failure"],
          ["active_failure", String(index + 2)], [`failure_parent_${index}`, options.corruptSuppressionParent ? "9999" : "active_failure"]]));
      if (options.resumeOutsideMicrotask) emit(`release_resume_outside_microtask_${index}`,
        [`pc == ${index}`, `pending_transition == ${index}`],
        new Map([["pc", String(index + 1)], ["host_phase", "0"], ["pending_transition", "-1"],
          ["temporal_order_broken", "true"], [`resource_${resource}`, "2"]]));
      if (optionalResources.has(transition.resource)) emit(`skip_release_${index}`,
        [`pc == ${index}`, `resource_${resource} == 0`, "pending_transition == -1"],
        new Map([["pc", String(index + 1)]]));
    } else {
      emit(`release_inline_${index}`, [`pc == ${index}`, `resource_${resource} == 1`, "pending_transition == -1"],
        new Map([["pc", String(index + 1)], [`resource_${resource}`, "2"]]));
      if (index === finalRepeatedRelease && firstRepeatedAcquire !== undefined) emit(`release_inline_repeat_${index}`,
        [`pc == ${index}`, `resource_${resource} == 1`, "pending_transition == -1", "active_failure == 0"],
        new Map([["pc", String(firstRepeatedAcquire)],
          ...[...repeatedResources].map((id) => [`resource_${resourceIndexes.get(id)!}`, "0"] as [string, string])]));
      if (completion) emit(`release_${completion.failure}_${index}`,
        [`pc == ${index}`, `resource_${resource} == 1`, "pending_transition == -1"],
        new Map([["pc", String(index + 1)], [`resource_${resource}`, "2"],
          ["disposal_failure_count", "disposal_failure_count + 1"],
          ["suppressed_failure", options.dropSuppression ? "suppressed_failure" : "if (active_failure != 0) true else suppressed_failure"],
          ["active_failure", String(index + 2)], [`failure_parent_${index}`, options.corruptSuppressionParent ? "9999" : "active_failure"]]));
      if (optionalResources.has(transition.resource)) emit(`skip_release_${index}`,
        [`pc == ${index}`, `resource_${resource} == 0`, "pending_transition == -1"],
        new Map([["pc", String(index + 1)]]));
    }
  });
  lines.push("", "  action step = any {", ...actions.map((action) => `    ${action},`), "  }");
  const terminal = product.resource.resources.map((resource, index) => resource.requiredTerminalStates?.includes("released")
    ? optionalResources.has(resource.id) ? `(resource_${index} == 0 or resource_${index} == 2)` : `resource_${index} == 2` : "true").join(" and ") || "true";
  const initializerFailureIds = product.resource.transitions.flatMap((transition, index) =>
    transition.kind === "acquire" && initializerFailureResources.has(transition.resource) ? [1000 + index] : []);
  const parentIdentity = releaseIndexesWithFailure.map((index) => {
    const allowed = [0, 1, ...initializerFailureIds, ...releaseIndexesWithFailure.filter((prior) => prior < index).map((prior) => prior + 2)];
    return `(failure_parent_${index} == -1 or ${allowed.map((id) => `failure_parent_${index} == ${id}`).join(" or ")})`;
  }).join(" and ") || "true";
  const hasSuppressedParent = releaseIndexesWithFailure.map((index) => `(failure_parent_${index} != -1 and failure_parent_${index} != 0)`).join(" or ") || "false";
  lines.push("", "  val disposalSuppressionSafe = disposal_failure_count <= 1 or suppressed_failure",
    `  val suppressionIdentitySafe = (${parentIdentity}) and (suppressed_failure == (${hasSuppressedParent}))`,
    `  val ${propertyName} = not(temporal_order_broken) and disposalSuppressionSafe and suppressionIdentitySafe and (pending_transition == -1 or host_phase == 1) and (pc != ${product.resource.transitions.length} or (${terminal}))`, "}", "");
  return lines.join("\n");
}
