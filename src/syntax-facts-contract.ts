export const syntaxFactsSchema = "uneffect-syntax-facts/v1" as const;

export const syntaxFactsCoverageDomains = [
  "function-boundaries",
  "call-sites",
  "construct-sites",
  "property-sites",
] as const;

export type SyntaxFactsCoverageDomain = typeof syntaxFactsCoverageDomains[number];
export type SyntaxFunctionKind = "function" | "method" | "getter" | "setter" | "arrow" | "function-expression";
export type SyntaxFactExclusionReason =
  | "computed-function-name"
  | "constructor-boundary"
  | "object-member-function"
  | "computed-call-target"
  | "unsupported-call-target"
  | "tagged-template"
  | "dynamic-import"
  | "computed-construct-target"
  | "unsupported-construct-target"
  | "computed-property";

export interface SyntaxFactExclusion {
  readonly reason: SyntaxFactExclusionReason;
  readonly span: { readonly start: number; readonly end: number };
}

export interface SyntaxFactsCoverageEntry {
  readonly domain: SyntaxFactsCoverageDomain;
  readonly status: "complete" | "partial" | "invalid";
  readonly exclusions: readonly SyntaxFactExclusion[];
}

export interface SyntaxFunction {
  readonly name: string;
  readonly kind: SyntaxFunctionKind;
  readonly start: number;
  readonly end: number;
  readonly parameters: readonly string[];
}

export interface SyntaxSite {
  readonly kind: "call" | "construct" | "property";
  readonly start: number;
  readonly end: number;
  readonly calleePosition: number;
  readonly receiverPosition?: number;
  readonly name: string;
}

export interface SyntaxFacts {
  readonly schema: typeof syntaxFactsSchema;
  readonly source: {
    readonly fileName: string;
    readonly language: "typescript" | "tsx";
    readonly length: number;
    readonly digest: string;
  };
  readonly parser: { readonly name: "oxc-parser"; readonly version: string };
  readonly coverage: readonly SyntaxFactsCoverageEntry[];
  readonly functions: readonly SyntaxFunction[];
  readonly sites: readonly SyntaxSite[];
  readonly errors: readonly string[];
}

const functionKinds = ["function", "method", "getter", "setter", "arrow", "function-expression"] as const;
const siteKinds = ["call", "construct", "property"] as const;
const exclusionReasons = [
  "computed-function-name", "constructor-boundary", "object-member-function",
  "computed-call-target", "unsupported-call-target", "tagged-template", "dynamic-import",
  "computed-construct-target", "unsupported-construct-target", "computed-property",
] as const;

const reasonsByDomain: Record<SyntaxFactsCoverageDomain, readonly SyntaxFactExclusionReason[]> = {
  "function-boundaries": ["computed-function-name", "constructor-boundary", "object-member-function"],
  "call-sites": ["computed-call-target", "unsupported-call-target", "tagged-template", "dynamic-import"],
  "construct-sites": ["computed-construct-target", "unsupported-construct-target"],
  "property-sites": ["computed-property"],
};

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

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is invalid`);
  return value as T;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function span(value: unknown, sourceLength: number, label: string): { start: number; end: number } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  exactKeys(value, ["start", "end"], label);
  const start = integer(value.start, `${label}.start`), end = integer(value.end, `${label}.end`);
  if (start >= end || end > sourceLength) throw new Error(`${label} must be within the source`);
  return { start, end };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  return [...value] as string[];
}

/** Strict runtime boundary for persisted Oxc syntax facts. */
export function parseSyntaxFacts(input: unknown): SyntaxFacts {
  if (!isRecord(input)) throw new Error("syntax facts must be an object");
  exactKeys(input, ["schema", "source", "parser", "coverage", "functions", "sites", "errors"], "syntax facts");
  if (input.schema !== syntaxFactsSchema) throw new Error("unsupported syntax facts schema");
  if (!isRecord(input.source)) throw new Error("syntax facts source must be an object");
  exactKeys(input.source, ["fileName", "language", "length", "digest"], "syntax facts source");
  const sourceLength = integer(input.source.length, "syntax facts source length");
  const digest = text(input.source.digest, "syntax facts source digest");
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("syntax facts source digest must be SHA-256");
  const source = {
    fileName: text(input.source.fileName, "syntax facts source fileName"),
    language: enumValue(input.source.language, ["typescript", "tsx"] as const, "syntax facts source language"),
    length: sourceLength,
    digest,
  };
  if (!isRecord(input.parser)) throw new Error("syntax facts parser must be an object");
  exactKeys(input.parser, ["name", "version"], "syntax facts parser");
  if (input.parser.name !== "oxc-parser") throw new Error("syntax facts parser name must be oxc-parser");
  const parser = { name: "oxc-parser" as const, version: text(input.parser.version, "syntax facts parser version") };
  if (!Array.isArray(input.errors) || input.errors.some((item) => typeof item !== "string")) {
    throw new Error("syntax facts errors must be strings");
  }
  const errors = [...input.errors] as string[];

  if (!Array.isArray(input.coverage)) throw new Error("syntax facts coverage must be an array");
  const coverage = input.coverage.map((raw, index): SyntaxFactsCoverageEntry => {
    if (!isRecord(raw)) throw new Error(`syntax facts coverage ${index} must be an object`);
    exactKeys(raw, ["domain", "status", "exclusions"], `syntax facts coverage ${index}`);
    const domain = enumValue(raw.domain, syntaxFactsCoverageDomains, `syntax facts coverage ${index} domain`);
    const status = enumValue(raw.status, ["complete", "partial", "invalid"] as const, `syntax facts coverage ${index} status`);
    if (!Array.isArray(raw.exclusions)) throw new Error(`syntax facts coverage ${index} exclusions must be an array`);
    const exclusions = raw.exclusions.map((item, exclusionIndex): SyntaxFactExclusion => {
      if (!isRecord(item)) throw new Error(`syntax facts coverage ${index} exclusion ${exclusionIndex} must be an object`);
      exactKeys(item, ["reason", "span"], `syntax facts coverage ${index} exclusion ${exclusionIndex}`);
      const reason = enumValue(item.reason, exclusionReasons, `syntax facts coverage ${index} exclusion reason`);
      if (!reasonsByDomain[domain].includes(reason)) throw new Error(`syntax facts coverage ${domain} has mismatched exclusion ${reason}`);
      return { reason, span: span(item.span, sourceLength, `syntax facts coverage ${index} exclusion span`) };
    });
    const exclusionIdentities = exclusions.map((item) => `${item.reason}:${item.span.start}:${item.span.end}`);
    if (new Set(exclusionIdentities).size !== exclusionIdentities.length) {
      throw new Error(`syntax facts coverage ${domain} exclusions must be unique`);
    }
    const expectedStatus = errors.length > 0 ? "invalid" : exclusions.length > 0 ? "partial" : "complete";
    if (status !== expectedStatus) throw new Error(`syntax facts coverage ${domain} status is inconsistent`);
    return { domain, status, exclusions };
  });
  const domains = coverage.map(({ domain }) => domain);
  if (coverage.length !== syntaxFactsCoverageDomains.length
    || syntaxFactsCoverageDomains.some((domain) => !domains.includes(domain))
    || new Set(domains).size !== domains.length) {
    throw new Error("syntax facts coverage must contain every domain exactly once");
  }

  if (!Array.isArray(input.functions)) throw new Error("syntax facts functions must be an array");
  const functions = input.functions.map((raw, index): SyntaxFunction => {
    if (!isRecord(raw)) throw new Error(`syntax facts function ${index} must be an object`);
    exactKeys(raw, ["name", "kind", "start", "end", "parameters"], `syntax facts function ${index}`);
    const bounds = span({ start: raw.start, end: raw.end }, sourceLength, `syntax facts function ${index} span`);
    return {
      name: text(raw.name, `syntax facts function ${index} name`),
      kind: enumValue(raw.kind, functionKinds, `syntax facts function ${index} kind`),
      ...bounds,
      parameters: stringArray(raw.parameters, `syntax facts function ${index} parameters`),
    };
  });
  const functionIdentities = functions.map((item) => `${item.kind}:${item.name}:${item.start}:${item.end}`);
  if (new Set(functionIdentities).size !== functionIdentities.length) throw new Error("syntax facts functions must be unique");
  if (!Array.isArray(input.sites)) throw new Error("syntax facts sites must be an array");
  const sites = input.sites.map((raw, index): SyntaxSite => {
    if (!isRecord(raw)) throw new Error(`syntax facts site ${index} must be an object`);
    const expectedKeys = raw.receiverPosition === undefined
      ? ["kind", "start", "end", "calleePosition", "name"]
      : ["kind", "start", "end", "calleePosition", "receiverPosition", "name"];
    exactKeys(raw, expectedKeys, `syntax facts site ${index}`);
    const bounds = span({ start: raw.start, end: raw.end }, sourceLength, `syntax facts site ${index} span`);
    const calleePosition = integer(raw.calleePosition, `syntax facts site ${index} calleePosition`);
    if (calleePosition < bounds.start || calleePosition >= bounds.end) throw new Error(`syntax facts site ${index} calleePosition is outside its span`);
    const receiverPosition = raw.receiverPosition === undefined ? undefined
      : integer(raw.receiverPosition, `syntax facts site ${index} receiverPosition`);
    if (receiverPosition !== undefined && (receiverPosition < bounds.start || receiverPosition >= bounds.end)) {
      throw new Error(`syntax facts site ${index} receiverPosition is outside its span`);
    }
    return {
      kind: enumValue(raw.kind, siteKinds, `syntax facts site ${index} kind`),
      ...bounds,
      calleePosition,
      ...(receiverPosition === undefined ? {} : { receiverPosition }),
      name: text(raw.name, `syntax facts site ${index} name`),
    };
  });
  const siteIdentities = sites.map((item) => `${item.kind}:${item.start}:${item.end}:${item.calleePosition}:${item.receiverPosition ?? ""}:${item.name}`);
  if (new Set(siteIdentities).size !== siteIdentities.length) throw new Error("syntax facts sites must be unique");
  return { schema: syntaxFactsSchema, source, parser, coverage, functions, sites, errors };
}
