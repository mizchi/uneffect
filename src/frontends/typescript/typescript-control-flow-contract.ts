import { createHash } from "node:crypto";

export const typescriptControlFlowSchema = "uneffect-typescript-control-flow/v1" as const;

export type TypeScriptFunctionEndpoint = "reachable" | "unreachable" | "unknown";
export type TypeScriptControlFlowDiagnosticCode = number
  | "uneffect-mutable-binding"
  | "uneffect-incompatible-compiler-options"
  | "uneffect-dynamic-computed-name";
export type TypeScriptControlFlowExclusionReason =
  | "mutable-binding"
  | "incompatible-compiler-options"
  | "dynamic-computed-name"
  | "typescript-diagnostic"
  | "endpoint-not-established";

export interface TypeScriptFunctionControlFlow {
  fileName: string;
  name: string;
  kind: "function" | "method" | "getter" | "setter" | "arrow" | "function-expression";
  span: { start: number; end: number };
  endpoint: TypeScriptFunctionEndpoint;
  neutralEndpoint: "reachable" | "unreachable";
  parity: "agree" | "typescript-refines" | "unknown";
  evidence: "public-diagnostics";
  diagnosticCodes: TypeScriptControlFlowDiagnosticCode[];
  internalFlowApi: "observed" | "unavailable";
  internalFlowNodeCount: number;
  aliases: string[];
}

export interface TypeScriptControlFlowSource {
  fileName: string;
  length: number;
  digest: string;
}

export interface TypeScriptControlFlowExclusion {
  fileName: string;
  functionName: string;
  span: { start: number; end: number };
  reasons: TypeScriptControlFlowExclusionReason[];
}

export interface TypeScriptControlFlowCoverage {
  domain: "function-endpoints";
  status: "complete" | "partial" | "not-applicable";
  observed: number;
  supported: number;
  unknown: number;
}

export interface TypeScriptControlFlowAnalysis {
  schema: typeof typescriptControlFlowSchema;
  typescriptVersion: string;
  sourceDigest: string;
  sources: TypeScriptControlFlowSource[];
  compilerOptions: { strict: boolean; noImplicitReturns: boolean; allowUnreachableCode: boolean };
  configurationCompatible: boolean;
  programReused: boolean;
  coverage: TypeScriptControlFlowCoverage;
  exclusions: TypeScriptControlFlowExclusion[];
  functions: TypeScriptFunctionControlFlow[];
}

const functionKinds = ["function", "method", "getter", "setter", "arrow", "function-expression"] as const;
const endpoints = ["reachable", "unreachable", "unknown"] as const;
const neutralEndpoints = ["reachable", "unreachable"] as const;
const parities = ["agree", "typescript-refines", "unknown"] as const;
const internalFlowApis = ["observed", "unavailable"] as const;
const namedDiagnosticCodes = [
  "uneffect-mutable-binding", "uneffect-incompatible-compiler-options", "uneffect-dynamic-computed-name",
] as const;
const exclusionReasons = [
  "mutable-binding", "incompatible-compiler-options", "dynamic-computed-name",
  "typescript-diagnostic", "endpoint-not-established",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !expected.includes(key));
  const missing = expected.find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`${label} has unknown key ${unexpected}`);
  if (missing) throw new Error(`${label} is missing key ${missing}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${label} must be SHA-256`);
  return result;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is invalid`);
  return value as T;
}

function parseSpan(value: unknown, maximum: number, label: string): { start: number; end: number } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["start", "end"], label);
  const start = integer(value.start, `${label}.start`), end = integer(value.end, `${label}.end`);
  if (start >= end || end > maximum) throw new Error(`${label} must be within its source`);
  return { start, end };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value] as string[];
}

export function typescriptControlFlowSourceDigest(sources: readonly TypeScriptControlFlowSource[]): string {
  return createHash("sha256").update(sources
    .map((source) => `${source.fileName}\0${source.length}\0${source.digest}`)
    .sort()
    .join("\0")).digest("hex");
}

export function typescriptControlFlowExclusionReasons(
  summary: Pick<TypeScriptFunctionControlFlow, "endpoint" | "diagnosticCodes">,
): TypeScriptControlFlowExclusionReason[] {
  if (summary.endpoint !== "unknown") return [];
  const reasons: TypeScriptControlFlowExclusionReason[] = [];
  if (summary.diagnosticCodes.includes("uneffect-mutable-binding")) reasons.push("mutable-binding");
  if (summary.diagnosticCodes.includes("uneffect-incompatible-compiler-options")) reasons.push("incompatible-compiler-options");
  if (summary.diagnosticCodes.includes("uneffect-dynamic-computed-name")) reasons.push("dynamic-computed-name");
  if (summary.diagnosticCodes.some((code) => typeof code === "number")) reasons.push("typescript-diagnostic");
  if (reasons.length === 0) reasons.push("endpoint-not-established");
  return reasons;
}

/** Strict runtime boundary for stored TypeScript control-flow observations. */
export function parseTypeScriptControlFlowAnalysis(input: unknown): TypeScriptControlFlowAnalysis {
  if (!isRecord(input)) throw new Error("TypeScript control-flow analysis must be an object");
  exactKeys(input, [
    "schema", "typescriptVersion", "sourceDigest", "sources", "compilerOptions", "configurationCompatible",
    "programReused", "coverage", "exclusions", "functions",
  ], "TypeScript control-flow analysis");
  if (input.schema !== typescriptControlFlowSchema) throw new Error("unsupported TypeScript control-flow schema");
  const typescriptVersion = text(input.typescriptVersion, "TypeScript control-flow typescriptVersion");
  const aggregateDigest = digest(input.sourceDigest, "TypeScript control-flow sourceDigest");
  if (!Array.isArray(input.sources)) throw new Error("TypeScript control-flow sources must be an array");
  const sources = input.sources.map((raw, index): TypeScriptControlFlowSource => {
    if (!isRecord(raw)) throw new Error(`TypeScript control-flow source ${index} must be an object`);
    exactKeys(raw, ["fileName", "length", "digest"], `TypeScript control-flow source ${index}`);
    return {
      fileName: text(raw.fileName, `TypeScript control-flow source ${index} fileName`),
      length: integer(raw.length, `TypeScript control-flow source ${index} length`),
      digest: digest(raw.digest, `TypeScript control-flow source ${index} digest`),
    };
  });
  if (new Set(sources.map(({ fileName }) => fileName)).size !== sources.length) throw new Error("TypeScript control-flow sources must be unique");
  if (aggregateDigest !== typescriptControlFlowSourceDigest(sources)) throw new Error("TypeScript control-flow sourceDigest does not match sources");
  const sourceByName = new Map(sources.map((source) => [source.fileName, source]));
  if (!isRecord(input.compilerOptions)) throw new Error("TypeScript control-flow compilerOptions must be an object");
  exactKeys(input.compilerOptions, ["strict", "noImplicitReturns", "allowUnreachableCode"], "TypeScript control-flow compilerOptions");
  const compilerOptions = {
    strict: bool(input.compilerOptions.strict, "TypeScript control-flow compilerOptions.strict"),
    noImplicitReturns: bool(input.compilerOptions.noImplicitReturns, "TypeScript control-flow compilerOptions.noImplicitReturns"),
    allowUnreachableCode: bool(input.compilerOptions.allowUnreachableCode, "TypeScript control-flow compilerOptions.allowUnreachableCode"),
  };
  const configurationCompatible = bool(input.configurationCompatible, "TypeScript control-flow configurationCompatible");
  if (configurationCompatible !== compilerOptions.noImplicitReturns) throw new Error("TypeScript control-flow configuration compatibility is inconsistent");
  const programReused = bool(input.programReused, "TypeScript control-flow programReused");

  if (!Array.isArray(input.functions)) throw new Error("TypeScript control-flow functions must be an array");
  const functions = input.functions.map((raw, index): TypeScriptFunctionControlFlow => {
    if (!isRecord(raw)) throw new Error(`TypeScript control-flow function ${index} must be an object`);
    exactKeys(raw, [
      "fileName", "name", "kind", "span", "endpoint", "neutralEndpoint", "parity", "evidence",
      "diagnosticCodes", "internalFlowApi", "internalFlowNodeCount", "aliases",
    ], `TypeScript control-flow function ${index}`);
    const fileName = text(raw.fileName, `TypeScript control-flow function ${index} fileName`);
    const source = sourceByName.get(fileName);
    if (!source) throw new Error(`TypeScript control-flow function ${index} references an unknown source`);
    const endpoint = enumValue(raw.endpoint, endpoints, `TypeScript control-flow function ${index} endpoint`);
    const neutralEndpoint = enumValue(raw.neutralEndpoint, neutralEndpoints, `TypeScript control-flow function ${index} neutralEndpoint`);
    const parity = enumValue(raw.parity, parities, `TypeScript control-flow function ${index} parity`);
    const expectedParity = endpoint === "unknown" ? "unknown" : endpoint === neutralEndpoint ? "agree" : "typescript-refines";
    if (parity !== expectedParity) throw new Error(`TypeScript control-flow function ${index} parity is inconsistent`);
    if (raw.evidence !== "public-diagnostics") throw new Error(`TypeScript control-flow function ${index} evidence is invalid`);
    if (!Array.isArray(raw.diagnosticCodes)) throw new Error(`TypeScript control-flow function ${index} diagnosticCodes must be an array`);
    const diagnosticCodes = raw.diagnosticCodes.map((code): TypeScriptControlFlowDiagnosticCode => {
      if (Number.isSafeInteger(code) && (code as number) >= 0) return code as number;
      return enumValue(code, namedDiagnosticCodes, `TypeScript control-flow function ${index} diagnostic code`);
    });
    if (new Set(diagnosticCodes).size !== diagnosticCodes.length) throw new Error(`TypeScript control-flow function ${index} diagnosticCodes must be unique`);
    const incompatibleEvidence = diagnosticCodes.includes("uneffect-incompatible-compiler-options");
    if (incompatibleEvidence !== !configurationCompatible) {
      throw new Error(`TypeScript control-flow function ${index} configuration evidence is inconsistent`);
    }
    const unsupportedIdentity = incompatibleEvidence
      || diagnosticCodes.includes("uneffect-mutable-binding")
      || diagnosticCodes.includes("uneffect-dynamic-computed-name");
    const hasFallthroughEvidence = diagnosticCodes.some((code) => typeof code === "number" && (code === 2366 || code === 7030));
    if (unsupportedIdentity ? endpoint !== "unknown" : (endpoint === "reachable") !== hasFallthroughEvidence) {
      throw new Error(`TypeScript control-flow function ${index} endpoint evidence is inconsistent`);
    }
    const internalFlowApi = enumValue(raw.internalFlowApi, internalFlowApis, `TypeScript control-flow function ${index} internalFlowApi`);
    const internalFlowNodeCount = integer(raw.internalFlowNodeCount, `TypeScript control-flow function ${index} internalFlowNodeCount`);
    if (internalFlowApi === "unavailable" && internalFlowNodeCount !== 0) throw new Error(`TypeScript control-flow function ${index} internal flow count is inconsistent`);
    return {
      fileName,
      name: text(raw.name, `TypeScript control-flow function ${index} name`),
      kind: enumValue(raw.kind, functionKinds, `TypeScript control-flow function ${index} kind`),
      span: parseSpan(raw.span, source.length, `TypeScript control-flow function ${index} span`),
      endpoint,
      neutralEndpoint,
      parity,
      evidence: "public-diagnostics",
      diagnosticCodes,
      internalFlowApi,
      internalFlowNodeCount,
      aliases: stringArray(raw.aliases, `TypeScript control-flow function ${index} aliases`),
    };
  });
  const identities = functions.map((fn) => `${fn.fileName}:${fn.span.start}:${fn.span.end}:${fn.kind}:${fn.name}`);
  if (new Set(identities).size !== identities.length) throw new Error("TypeScript control-flow functions must be unique");

  if (!isRecord(input.coverage)) throw new Error("TypeScript control-flow coverage must be an object");
  exactKeys(input.coverage, ["domain", "status", "observed", "supported", "unknown"], "TypeScript control-flow coverage");
  if (input.coverage.domain !== "function-endpoints") throw new Error("TypeScript control-flow coverage domain is invalid");
  const coverage: TypeScriptControlFlowCoverage = {
    domain: "function-endpoints",
    status: enumValue(input.coverage.status, ["complete", "partial", "not-applicable"] as const, "TypeScript control-flow coverage status"),
    observed: integer(input.coverage.observed, "TypeScript control-flow coverage observed"),
    supported: integer(input.coverage.supported, "TypeScript control-flow coverage supported"),
    unknown: integer(input.coverage.unknown, "TypeScript control-flow coverage unknown"),
  };
  const unknownFunctions = functions.filter(({ endpoint }) => endpoint === "unknown");
  const expectedStatus = functions.length === 0 ? "not-applicable" : unknownFunctions.length === 0 ? "complete" : "partial";
  if (coverage.observed !== functions.length || coverage.supported !== functions.length - unknownFunctions.length
    || coverage.unknown !== unknownFunctions.length || coverage.status !== expectedStatus) {
    throw new Error("TypeScript control-flow coverage is inconsistent with functions");
  }

  if (!Array.isArray(input.exclusions)) throw new Error("TypeScript control-flow exclusions must be an array");
  const exclusions = input.exclusions.map((raw, index): TypeScriptControlFlowExclusion => {
    if (!isRecord(raw)) throw new Error(`TypeScript control-flow exclusion ${index} must be an object`);
    exactKeys(raw, ["fileName", "functionName", "span", "reasons"], `TypeScript control-flow exclusion ${index}`);
    const fileName = text(raw.fileName, `TypeScript control-flow exclusion ${index} fileName`);
    const source = sourceByName.get(fileName);
    if (!source) throw new Error(`TypeScript control-flow exclusion ${index} references an unknown source`);
    if (!Array.isArray(raw.reasons)) throw new Error(`TypeScript control-flow exclusion ${index} reasons must be an array`);
    const reasons = raw.reasons.map((reason) => enumValue(reason, exclusionReasons, `TypeScript control-flow exclusion ${index} reason`));
    if (reasons.length === 0 || new Set(reasons).size !== reasons.length) throw new Error(`TypeScript control-flow exclusion ${index} reasons must be non-empty and unique`);
    return {
      fileName,
      functionName: text(raw.functionName, `TypeScript control-flow exclusion ${index} functionName`),
      span: parseSpan(raw.span, source.length, `TypeScript control-flow exclusion ${index} span`),
      reasons,
    };
  });
  if (exclusions.length !== unknownFunctions.length) throw new Error("TypeScript control-flow exclusions do not cover every unknown function");
  for (const fn of unknownFunctions) {
    const exclusion = exclusions.find((item) => item.fileName === fn.fileName && item.functionName === fn.name
      && item.span.start === fn.span.start && item.span.end === fn.span.end);
    const expectedReasons = typescriptControlFlowExclusionReasons(fn);
    if (!exclusion || exclusion.reasons.length !== expectedReasons.length
      || expectedReasons.some((reason, index) => exclusion.reasons[index] !== reason)) {
      throw new Error(`TypeScript control-flow exclusions are inconsistent for ${fn.name}`);
    }
  }
  return {
    schema: typescriptControlFlowSchema,
    typescriptVersion,
    sourceDigest: aggregateDigest,
    sources,
    compilerOptions,
    configurationCompatible,
    programReused,
    coverage,
    exclusions,
    functions,
  };
}
