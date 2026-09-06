export type TemporalRuntime = "web" | "node";

export type TemporalModelProjectionKind =
  | "user-temporal"
  | "web-event-loop"
  | "node-event-loop"
  | "promise-chains"
  | "promise-ownership"
  | "abortable-fetch"
  | "resource-lifecycle"
  | "resource-host-lifecycle";

export type TemporalModelExclusion =
  | "async-ownership"
  | "promise-host-synchronization"
  | "abortable-fetch-synchronization"
  | "resource-lifecycle"
  | "resource-host-scheduling"
  | "resource-host-callback-interleavings";

export type TemporalModelCoverageDomain =
  | "user-temporal"
  | "async-patterns"
  | "promise-chains"
  | "promise-ownership"
  | "promise-host-synchronization"
  | "abortable-fetch"
  | "resource-lifecycle"
  | "resource-host-lifecycle"
  | "resource-host-callback-interleavings";

export interface TemporalModelCoverageEntry {
  domain: TemporalModelCoverageDomain;
  status: "modeled" | "not-applicable" | "excluded";
  modelKinds: TemporalModelProjectionKind[];
  exclusions: TemporalModelExclusion[];
}

export interface TemporalModelSynchronization {
  kind: "promise-ownership-host";
  resource: string;
  hostTransitionId: string;
  relation: "same-promise";
  evidence: "exact";
}

export interface TemporalModelProjection {
  kind: TemporalModelProjectionKind;
  module: string;
  owner?: string;
  properties: string[];
  quint: string;
}

export interface TemporalModelResult {
  schema: "uneffect-temporal-model/v1";
  sourceLanguage: "uneffect-ts";
  backend: "quint";
  runtime: TemporalRuntime;
  includedDomains: Array<"user-temporal" | "async-patterns" | "promise-chains" | "async-ownership" | "abortable-fetch" | "resource-lifecycle">;
  exclusions: TemporalModelExclusion[];
  coverage: TemporalModelCoverageEntry[];
  synchronizations: TemporalModelSynchronization[];
  scheduling: {
    fairness: "none";
    resourceCallbackInterleavings: "excluded" | "not-applicable";
  };
  models: TemporalModelProjection[];
  properties: string[];
  quint: string;
}

export const temporalModelCoverageDomains = [
  "user-temporal",
  "async-patterns",
  "promise-chains",
  "promise-ownership",
  "promise-host-synchronization",
  "abortable-fetch",
  "resource-lifecycle",
  "resource-host-lifecycle",
  "resource-host-callback-interleavings",
] as const satisfies readonly TemporalModelCoverageDomain[];

const projectionKinds = [
  "user-temporal", "web-event-loop", "node-event-loop", "promise-chains", "promise-ownership",
  "abortable-fetch", "resource-lifecycle", "resource-host-lifecycle",
] as const satisfies readonly TemporalModelProjectionKind[];

const includedDomains = [
  "user-temporal", "async-patterns", "promise-chains", "async-ownership", "abortable-fetch", "resource-lifecycle",
] as const satisfies TemporalModelResult["includedDomains"];

const exclusionKinds = [
  "async-ownership", "promise-host-synchronization", "abortable-fetch-synchronization",
  "resource-lifecycle", "resource-host-scheduling", "resource-host-callback-interleavings",
] as const satisfies readonly TemporalModelExclusion[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown key ${unknown[0]}`);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringArray<T extends string = string>(value: unknown, label: string, allowed?: readonly T[]): T[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  const items = value as string[];
  if (allowed) for (const item of items) enumValue(item, allowed, label);
  if (new Set(items).size !== items.length) throw new Error(`${label} must not contain duplicates`);
  return [...items] as T[];
}

/** Strict runtime boundary for stored or transported temporal model artifacts. */
export function parseTemporalModelResult(input: unknown): TemporalModelResult {
  if (!isRecord(input)) throw new Error("temporal model must be an object");
  exactKeys(input, [
    "schema", "sourceLanguage", "backend", "runtime", "includedDomains", "exclusions", "coverage",
    "synchronizations", "scheduling", "models", "properties", "quint",
  ], "temporal model");
  if (input.schema !== "uneffect-temporal-model/v1") throw new Error("unsupported temporal model schema");
  if (input.sourceLanguage !== "uneffect-ts") throw new Error("temporal model sourceLanguage must be uneffect-ts");
  if (input.backend !== "quint") throw new Error("temporal model backend must be quint");
  const runtime = enumValue(input.runtime, ["web", "node"] as const, "temporal model runtime");
  const parsedIncluded = stringArray(input.includedDomains, "temporal model includedDomains", includedDomains);
  const exclusions = stringArray(input.exclusions, "temporal model exclusions", exclusionKinds);

  if (!Array.isArray(input.coverage)) throw new Error("temporal model coverage must be an array");
  const coverage = input.coverage.map((raw, index): TemporalModelCoverageEntry => {
    if (!isRecord(raw)) throw new Error(`temporal model coverage ${index} must be an object`);
    exactKeys(raw, ["domain", "status", "modelKinds", "exclusions"], `temporal model coverage ${index}`);
    return {
      domain: enumValue(raw.domain, temporalModelCoverageDomains, `temporal model coverage ${index} domain`),
      status: enumValue(raw.status, ["modeled", "not-applicable", "excluded"] as const, `temporal model coverage ${index} status`),
      modelKinds: stringArray(raw.modelKinds, `temporal model coverage ${index} modelKinds`, projectionKinds),
      exclusions: stringArray(raw.exclusions, `temporal model coverage ${index} exclusions`, exclusionKinds),
    };
  });
  const coverageDomains = coverage.map(({ domain }) => domain);
  if (coverage.length !== temporalModelCoverageDomains.length
    || temporalModelCoverageDomains.some((domain) => !coverageDomains.includes(domain))
    || new Set(coverageDomains).size !== coverageDomains.length) {
    throw new Error("temporal model coverage must contain every domain exactly once");
  }

  if (!Array.isArray(input.synchronizations)) throw new Error("temporal model synchronizations must be an array");
  const synchronizations = input.synchronizations.map((raw, index): TemporalModelSynchronization => {
    if (!isRecord(raw)) throw new Error(`temporal model synchronization ${index} must be an object`);
    exactKeys(raw, ["kind", "resource", "hostTransitionId", "relation", "evidence"], `temporal model synchronization ${index}`);
    if (raw.kind !== "promise-ownership-host" || raw.relation !== "same-promise" || raw.evidence !== "exact"
      || typeof raw.resource !== "string" || typeof raw.hostTransitionId !== "string") {
      throw new Error(`temporal model synchronization ${index} is invalid`);
    }
    return raw as unknown as TemporalModelSynchronization;
  });

  if (!isRecord(input.scheduling)) throw new Error("temporal model scheduling must be an object");
  exactKeys(input.scheduling, ["fairness", "resourceCallbackInterleavings"], "temporal model scheduling");
  if (input.scheduling.fairness !== "none") throw new Error("temporal model scheduling fairness must be none");
  const resourceCallbackInterleavings = enumValue(
    input.scheduling.resourceCallbackInterleavings,
    ["excluded", "not-applicable"] as const,
    "temporal model scheduling resourceCallbackInterleavings",
  );

  if (!Array.isArray(input.models)) throw new Error("temporal model models must be an array");
  const models = input.models.map((raw, index): TemporalModelProjection => {
    if (!isRecord(raw)) throw new Error(`temporal model projection ${index} must be an object`);
    exactKeys(raw, ["kind", "module", "owner", "properties", "quint"], `temporal model projection ${index}`);
    const kind = enumValue(raw.kind, projectionKinds, `temporal model projection ${index} kind`);
    if (typeof raw.module !== "string" || typeof raw.quint !== "string"
      || (raw.owner !== undefined && typeof raw.owner !== "string")) {
      throw new Error(`temporal model projection ${index} has invalid text fields`);
    }
    return {
      kind,
      module: raw.module,
      ...(raw.owner === undefined ? {} : { owner: raw.owner }),
      properties: stringArray(raw.properties, `temporal model projection ${index} properties`),
      quint: raw.quint,
    };
  });
  const presentModelKinds = new Set(models.map(({ kind }) => kind));
  for (const entry of coverage) {
    if (entry.status === "not-applicable" && (entry.modelKinds.length > 0 || entry.exclusions.length > 0)) {
      throw new Error(`temporal model coverage ${entry.domain} is not-applicable but carries evidence`);
    }
    if (entry.status === "modeled" && entry.exclusions.length > 0) {
      throw new Error(`temporal model coverage ${entry.domain} is modeled but carries exclusions`);
    }
    if (entry.status === "excluded" && entry.exclusions.length === 0) {
      throw new Error(`temporal model coverage ${entry.domain} is excluded without an exclusion code`);
    }
    for (const kind of entry.modelKinds) {
      if (!presentModelKinds.has(kind)) throw new Error(`temporal model coverage ${entry.domain} references missing model ${kind}`);
    }
  }
  const properties = stringArray(input.properties, "temporal model properties");
  if (typeof input.quint !== "string") throw new Error("temporal model quint must be a string");
  if (input.quint !== models.map((model) => model.quint).join("\n")) {
    throw new Error("temporal model quint must equal the ordered model concatenation");
  }

  return {
    schema: "uneffect-temporal-model/v1",
    sourceLanguage: "uneffect-ts",
    backend: "quint",
    runtime,
    includedDomains: parsedIncluded,
    exclusions,
    coverage,
    synchronizations,
    scheduling: { fairness: "none", resourceCallbackInterleavings },
    models,
    properties,
    quint: input.quint,
  };
}
