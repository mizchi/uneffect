import { extractAnnotations } from "./annotations.js";
import { analyzeAsyncPatterns, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "./async-patterns.js";
import { analyzePromiseChains } from "./promise-chains.js";
import { parseTemporalComposition } from "./temporal-compose.js";

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
  includedDomains: Array<"user-temporal" | "async-patterns" | "promise-chains">;
  exclusions: Array<"async-ownership" | "resource-lifecycle">;
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
 * Promise ownership and resource lifecycle are deliberately reported as
 * exclusions until their control-flow IR is lowered into this projection.
 */
export function generateTemporalModel(options: GenerateTemporalModelOptions): TemporalModelResult {
  const asyncPatterns = analyzeAsyncPatterns(options.fileName, options.source);
  const promiseChains = analyzePromiseChains(options.fileName, options.source);
  const hasUserTemporalState = extractAnnotations(options.source, "state").length > 0;
  const temporal = hasUserTemporalState
    ? parseTemporalComposition(options.fileName, options.source, options.root ?? "main")
    : undefined;
  const name = moduleName(options.fileName);
  const quint = options.runtime === "web"
    ? generateWebEventLoopQuint(name, asyncPatterns, {}, promiseChains, temporal)
    : generateNodeEventLoopQuint(name, asyncPatterns, { topLevelMode: options.nodeTopLevelMode ?? "commonjs" }, promiseChains, temporal);
  return {
    schema: "uneffect-temporal-model/v1",
    sourceLanguage: "uneffect-ts",
    backend: "quint",
    runtime: options.runtime,
    includedDomains: [
      ...(temporal ? ["user-temporal" as const] : []),
      "async-patterns",
      "promise-chains",
    ],
    exclusions: ["async-ownership", "resource-lifecycle"],
    properties: [options.runtime === "web" ? "eventLoopSafe" : "nodeEventLoopSafe", ...(temporal?.properties.map((property) => property.name) ?? [])],
    quint,
  };
}
