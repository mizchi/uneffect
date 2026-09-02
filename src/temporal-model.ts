import { extractAnnotations } from "./annotations.js";
import { analyzeAbortableFetches, generateAbortableFetchProductQuint } from "./abortable-fetch-product.js";
import { analyzeAsyncPatterns, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "./async-patterns.js";
import { analyzeAsyncSafety, generateResourceSafetyQuint, type AsyncSafetyResult } from "./async-safety.js";
import { bindingIdentityKey } from "./binding-identity.js";
import { lowerPromiseChainTransitions, type SettlePromiseTransition } from "./host-neutral-transitions.js";
import { analyzePromiseChains, generatePromiseChainsQuint } from "./promise-chains.js";
import { parseTemporalComposition } from "./temporal-compose.js";
import { generatePromiseOwnershipTemporalQuint, lowerPromiseOwnershipToResourceProtocol } from "./promise-ownership-protocol.js";
import { lowerResourceDisposalsToProtocol } from "./resource-disposal-protocol.js";
import { createResourceDisposalTemporalProduct, generateResourceTemporalProductQuint } from "./resource-temporal-product.js";
import { generateQuint } from "./spec-backends.js";
import type { TemporalDslLink } from "./temporal-dsl.js";

export type TemporalRuntime = "web" | "node";

export interface GenerateTemporalModelOptions {
  fileName: string;
  source: string;
  runtime: TemporalRuntime;
  root?: string;
  nodeTopLevelMode?: "commonjs" | "esm";
  linkedTemporal?: TemporalDslLink;
}

export interface TemporalModelResult {
  schema: "uneffect-temporal-model/v1";
  sourceLanguage: "uneffect-ts";
  backend: "quint";
  runtime: TemporalRuntime;
  includedDomains: Array<"user-temporal" | "async-patterns" | "promise-chains" | "async-ownership" | "abortable-fetch" | "resource-lifecycle">;
  exclusions: Array<"async-ownership" | "promise-host-synchronization" | "abortable-fetch-synchronization" | "resource-lifecycle" | "resource-host-scheduling" | "resource-host-callback-interleavings">;
  synchronizations: TemporalModelSynchronization[];
  scheduling: {
    fairness: "none";
    resourceCallbackInterleavings: "excluded" | "not-applicable";
  };
  models: TemporalModelProjection[];
  properties: string[];
  quint: string;
}

export interface TemporalModelSynchronization {
  kind: "promise-ownership-host";
  resource: string;
  hostTransitionId: string;
  relation: "same-promise";
  evidence: "exact";
}

export interface TemporalModelProjection {
  kind: "user-temporal" | "web-event-loop" | "node-event-loop" | "promise-chains" | "promise-ownership" | "abortable-fetch" | "resource-lifecycle" | "resource-host-lifecycle";
  module: string;
  owner?: string;
  properties: string[];
  quint: string;
}

function moduleName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "").replace(/[^A-Za-z0-9_]/gu, "_");
}

/**
 * Build one host-aware temporal model from explicit temporal annotations and
 * statically extracted JavaScript asynchronous observations.
 *
 * Unsupported ownership or resource/host interleavings are reported as
 * exclusions instead of being implied by the generated projections.
 */
export function generateTemporalModel(options: GenerateTemporalModelOptions): TemporalModelResult {
  const asyncPatterns = analyzeAsyncPatterns(options.fileName, options.source);
  const promiseChains = analyzePromiseChains(options.fileName, options.source);
  const hasUserTemporalState = extractAnnotations(options.source, "state").length > 0;
  const temporal = hasUserTemporalState
    ? parseTemporalComposition(options.fileName, options.source, options.root ?? "main")
    : undefined;
  const name = moduleName(options.fileName);
  const hasSynchronousPromiseDivergence = promiseChains.executors.some((executor) => executor.mayDivergeSynchronously);
  const hostQuint = options.runtime === "web"
    ? generateWebEventLoopQuint(name, asyncPatterns, {}, promiseChains, temporal)
    : generateNodeEventLoopQuint(name, asyncPatterns, { topLevelMode: options.nodeTopLevelMode ?? "commonjs" }, promiseChains, temporal);
  const hostProperties = [options.runtime === "web" ? "eventLoopSafe" : "nodeEventLoopSafe",
    ...(hasSynchronousPromiseDivergence ? ["promiseSynchronouslyProgressed"] : []),
    ...(temporal?.properties.map((property) => property.name) ?? [])];
  const models: TemporalModelProjection[] = [{
    kind: options.runtime === "web" ? "web-event-loop" : "node-event-loop",
    module: name,
    properties: hostProperties,
    quint: hostQuint,
  }];
  if (promiseChains.executors.length > 0 || promiseChains.chains.length > 0) {
    const promiseModule = `${name}_promise_chains`;
    models.push({
      kind: "promise-chains",
      module: promiseModule,
      owner: options.root ?? "main",
      properties: ["promiseSafe", ...(hasSynchronousPromiseDivergence ? ["promiseSynchronouslyProgressed"] : [])],
      quint: generatePromiseChainsQuint(promiseModule, promiseChains),
    });
  }
  if (options.linkedTemporal) {
    const linkedModule = moduleName(options.linkedTemporal.specificationFile);
    models.push({
      kind: "user-temporal",
      module: linkedModule,
      properties: options.linkedTemporal.spec.properties.map((property) => property.name),
      quint: generateQuint(linkedModule, options.linkedTemporal.spec),
    });
  }
  const resourceOwner = options.root ?? "main";
  const asyncSafety = analyzeAsyncSafety(options.fileName, options.source);
  const promiseBindings = asyncSafety.promiseBindings.filter((binding) => binding.owner === resourceOwner);
  const synchronizations: TemporalModelSynchronization[] = [];
  let promiseOwnershipResourceCount = 0;
  if (promiseBindings.length > 0) {
    const ownershipModule = `${name}_promise_ownership_${moduleName(resourceOwner)}`;
    const ownership = lowerPromiseOwnershipToResourceProtocol(promiseBindings);
    promiseOwnershipResourceCount = ownership.resources.size;
    const settlements = lowerPromiseChainTransitions(options.fileName, promiseChains)
      .filter((transition): transition is SettlePromiseTransition & { promiseIdentity: NonNullable<SettlePromiseTransition["promiseIdentity"]> } =>
        transition.kind === "settle-promise" && transition.promiseIdentity !== undefined);
    const settlementByIdentity = new Map(settlements.map((transition) => [bindingIdentityKey(transition.promiseIdentity!), transition] as const));
    for (const [resource, binding] of ownership.resources) {
      if (!binding.identity || binding.generation > 0) continue;
      const settlement = settlementByIdentity.get(bindingIdentityKey(binding.identity));
      if (settlement) synchronizations.push({
        kind: "promise-ownership-host",
        resource,
        hostTransitionId: settlement.id,
        relation: "same-promise",
        evidence: "exact",
      });
    }
    models.push({
      kind: "promise-ownership",
      module: ownershipModule,
      owner: resourceOwner,
      properties: ["promiseOwnershipSafe"],
      quint: generatePromiseOwnershipTemporalQuint(ownershipModule, ownership),
    });
  }
  const abortableAnalysis = analyzeAbortableFetches(options.fileName, options.source);
  const abortableFetches = abortableAnalysis.fetches.filter((fetch) => fetch.owner === resourceOwner);
  const abortableUnknown = abortableAnalysis.unknown.filter((unknown) => unknown.owner === resourceOwner);
  if (abortableFetches.length > 0) {
    const abortableModule = `${name}_abortable_fetch_${moduleName(resourceOwner)}`;
    const selected = { ...abortableAnalysis, fetches: abortableFetches, unknown: abortableUnknown };
    models.push({
      kind: "abortable-fetch",
      module: abortableModule,
      owner: resourceOwner,
      properties: ["abortableFetchSafe", "abortableFetchObserved", "abortableFetchBodiesConsumed"],
      quint: generateAbortableFetchProductQuint(abortableModule, selected),
    });
  }
  const resources = asyncSafety.resources.filter((resource) => resource.owner === resourceOwner);
  if (resources.length > 0) {
    const scopeIds = new Set(resources.map((resource) => resource.scopeId));
    const resourceResult: AsyncSafetyResult = {
      ...asyncSafety,
      resources,
      disposals: asyncSafety.disposals.filter((disposal) => disposal.owner === resourceOwner && scopeIds.has(disposal.scopeId)),
    };
    const resourceModule = `${name}_resource_${moduleName(resourceOwner)}`;
    models.push({
      kind: "resource-lifecycle",
      module: resourceModule,
      owner: resourceOwner,
      properties: ["resourceSafe"],
      quint: generateResourceSafetyQuint(resourceModule, resourceResult),
    });
    const supportsResourceTemporalProduct = resources.some((resource) => resource.asynchronous);
    if (supportsResourceTemporalProduct) {
      const lifecycle = lowerResourceDisposalsToProtocol(resourceResult.resources, resourceResult.disposals, resourceOwner);
      const product = createResourceDisposalTemporalProduct(options.fileName, lifecycle, resourceResult.disposals);
      if (product.status === "ready") {
        const resourceHostModule = `${name}_resource_host_${moduleName(resourceOwner)}`;
        models.push({
          kind: "resource-host-lifecycle",
          module: resourceHostModule,
          owner: resourceOwner,
          properties: ["resourceHostSafe"],
          quint: generateResourceTemporalProductQuint(resourceHostModule, product.product, { propertyName: "resourceHostSafe" }),
        });
      }
    }
  }
  const hasAsyncResource = resources.some((resource) => resource.asynchronous);
  const hasResourceHostModel = models.some((model) => model.kind === "resource-host-lifecycle");
  return {
    schema: "uneffect-temporal-model/v1",
    sourceLanguage: "uneffect-ts",
    backend: "quint",
    runtime: options.runtime,
    includedDomains: [
      ...(temporal || options.linkedTemporal ? ["user-temporal" as const] : []),
      "async-patterns",
      "promise-chains",
      ...(promiseBindings.length > 0 ? ["async-ownership" as const] : []),
      ...(abortableFetches.length > 0 ? ["abortable-fetch" as const] : []),
      ...(resources.length > 0 ? ["resource-lifecycle" as const] : []),
    ],
    exclusions: [
      ...(promiseBindings.length === 0 ? ["async-ownership" as const] : []),
      ...(promiseOwnershipResourceCount > synchronizations.length ? ["promise-host-synchronization" as const] : []),
      ...(abortableUnknown.length > 0 ? ["abortable-fetch-synchronization" as const] : []),
      ...(resources.length === 0 ? ["resource-lifecycle" as const] : []),
      ...(hasAsyncResource && !hasResourceHostModel ? ["resource-host-scheduling" as const] : []),
      ...(hasAsyncResource && hasResourceHostModel ? ["resource-host-callback-interleavings" as const] : []),
    ],
    synchronizations,
    scheduling: {
      fairness: "none",
      resourceCallbackInterleavings: hasAsyncResource ? "excluded" : "not-applicable",
    },
    models,
    properties: [...hostProperties, ...models.filter((model) => model.owner).flatMap((model) => model.properties.map((property) => `${model.owner}.${property}`))],
    quint: models.map((model) => model.quint).join("\n"),
  };
}
