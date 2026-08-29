import { extractAnnotations } from "./annotations.js";
import { analyzeAsyncPatterns, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "./async-patterns.js";
import { analyzeAsyncSafety, generateResourceSafetyQuint, type AsyncSafetyResult } from "./async-safety.js";
import { analyzePromiseChains } from "./promise-chains.js";
import { parseTemporalComposition } from "./temporal-compose.js";
import { generateResourceHostTemporalQuint, resourceHostTemporalSupport } from "./resource-host-temporal.js";

export type TemporalRuntime = "web" | "node";

export interface GenerateTemporalModelOptions {
  fileName: string;
  source: string;
  runtime: TemporalRuntime;
  root?: string;
  nodeTopLevelMode?: "commonjs" | "esm";
}

export interface TemporalModelResult {
  schema: "uneffect-temporal-model/v1";
  sourceLanguage: "uneffect-ts";
  backend: "quint";
  runtime: TemporalRuntime;
  includedDomains: Array<"user-temporal" | "async-patterns" | "promise-chains" | "resource-lifecycle">;
  exclusions: Array<"async-ownership" | "resource-lifecycle" | "resource-host-scheduling" | "resource-host-callback-interleavings">;
  models: TemporalModelProjection[];
  properties: string[];
  quint: string;
}

export interface TemporalModelProjection {
  kind: "web-event-loop" | "node-event-loop" | "resource-lifecycle" | "resource-host-lifecycle";
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
 * Promise ownership and unsupported resource/host interleavings are reported
 * as exclusions instead of being implied by the generated projections.
 */
export function generateTemporalModel(options: GenerateTemporalModelOptions): TemporalModelResult {
  const asyncPatterns = analyzeAsyncPatterns(options.fileName, options.source);
  const promiseChains = analyzePromiseChains(options.fileName, options.source);
  const hasUserTemporalState = extractAnnotations(options.source, "state").length > 0;
  const temporal = hasUserTemporalState
    ? parseTemporalComposition(options.fileName, options.source, options.root ?? "main")
    : undefined;
  const name = moduleName(options.fileName);
  const hostQuint = options.runtime === "web"
    ? generateWebEventLoopQuint(name, asyncPatterns, {}, promiseChains, temporal)
    : generateNodeEventLoopQuint(name, asyncPatterns, { topLevelMode: options.nodeTopLevelMode ?? "commonjs" }, promiseChains, temporal);
  const hostProperties = [options.runtime === "web" ? "eventLoopSafe" : "nodeEventLoopSafe", ...(temporal?.properties.map((property) => property.name) ?? [])];
  const models: TemporalModelProjection[] = [{
    kind: options.runtime === "web" ? "web-event-loop" : "node-event-loop",
    module: name,
    properties: hostProperties,
    quint: hostQuint,
  }];
  const resourceOwner = options.root ?? "main";
  const asyncSafety = analyzeAsyncSafety(options.fileName, options.source);
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
    const hostSupport = resourceHostTemporalSupport(resources);
    if (hostSupport.supported) {
      const resourceHostModule = `${name}_resource_host_${moduleName(resourceOwner)}`;
      models.push({
        kind: "resource-host-lifecycle",
        module: resourceHostModule,
        owner: resourceOwner,
        properties: ["resourceHostSafe"],
        quint: generateResourceHostTemporalQuint(resourceHostModule, resourceResult, resourceOwner),
      });
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
      ...(temporal ? ["user-temporal" as const] : []),
      "async-patterns",
      "promise-chains",
      ...(resources.length > 0 ? ["resource-lifecycle" as const] : []),
    ],
    exclusions: [
      "async-ownership",
      ...(resources.length === 0 ? ["resource-lifecycle" as const] : []),
      ...(hasAsyncResource && !hasResourceHostModel ? ["resource-host-scheduling" as const] : []),
      ...(hasAsyncResource && hasResourceHostModel ? ["resource-host-callback-interleavings" as const] : []),
    ],
    models,
    properties: [...hostProperties, ...models.filter((model) => model.owner).flatMap((model) => model.properties.map((property) => `${model.owner}.${property}`))],
    quint: models.map((model) => model.quint).join("\n"),
  };
}
