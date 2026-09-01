import type { AssumptionDomain } from "./assumptions.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const assumptionRegistrySchema = "uneffect-assumption-registry/v1" as const;

export interface AssumptionRecord {
  id: string;
  domain: AssumptionDomain;
  reason: string;
  owner: string;
  expiresOn?: string;
  /** Digest of the caller-owned review artifact, not of the source annotation. */
  reviewDigest: string;
}

export interface AssumptionRegistry {
  schema: typeof assumptionRegistrySchema;
  records: readonly AssumptionRecord[];
}

export class AssumptionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssumptionRegistryError";
  }
}

const domains = new Set<AssumptionDomain>([
  "builtin", "module-initialization", "typed-array", "temporal-contract",
  "dispatch-sealing", "resource-callable",
]);

function fail(path: string, message: string): never {
  throw new AssumptionRegistryError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown) fail(path, `unknown key ${JSON.stringify(unknown)}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "expected a non-empty string");
  return value;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseAssumptionRegistry(value: unknown): AssumptionRegistry {
  const input = record(value, "assumptionRegistry");
  exactKeys(input, ["schema", "records"], "assumptionRegistry");
  if (input.schema !== assumptionRegistrySchema) {
    fail("assumptionRegistry.schema", `unsupported schema ${JSON.stringify(input.schema)}`);
  }
  if (!Array.isArray(input.records)) fail("assumptionRegistry.records", "expected an array");
  const seen = new Set<string>();
  const records = input.records.map((value, index): AssumptionRecord => {
    const path = `assumptionRegistry.records[${index}]`;
    const item = record(value, path);
    exactKeys(item, ["id", "domain", "reason", "owner", "expiresOn", "reviewDigest"], path);
    const id = text(item.id, `${path}.id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(id)) fail(`${path}.id`, "expected a stable assumption ID");
    if (seen.has(id)) fail(`${path}.id`, `duplicate assumption ID ${JSON.stringify(id)}`);
    seen.add(id);
    const domain = text(item.domain, `${path}.domain`) as AssumptionDomain;
    if (!domains.has(domain)) fail(`${path}.domain`, `unsupported domain ${JSON.stringify(domain)}`);
    const reviewDigest = text(item.reviewDigest, `${path}.reviewDigest`);
    if (!/^[a-f0-9]{64}$/u.test(reviewDigest)) fail(`${path}.reviewDigest`, "expected a lowercase SHA-256 digest");
    const expiresOn = item.expiresOn === undefined ? undefined : text(item.expiresOn, `${path}.expiresOn`);
    if (expiresOn !== undefined && !validDate(expiresOn)) fail(`${path}.expiresOn`, "expected a valid calendar date in YYYY-MM-DD form");
    return {
      id, domain,
      reason: text(item.reason, `${path}.reason`),
      owner: text(item.owner, `${path}.owner`),
      ...(expiresOn === undefined ? {} : { expiresOn }),
      reviewDigest,
    };
  });
  return { schema: assumptionRegistrySchema, records };
}

export function resolveAssumptionRecord(
  registry: AssumptionRegistry | undefined,
  id: string,
  domain: AssumptionDomain,
): AssumptionRecord | undefined {
  return registry?.records.find((record) => record.id === id && record.domain === domain);
}

export async function loadAssumptionRegistry(fileName: string): Promise<AssumptionRegistry> {
  const absolute = resolve(fileName);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolute, "utf8"));
  } catch (cause) {
    throw new AssumptionRegistryError(`${absolute}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    return parseAssumptionRegistry(value);
  } catch (cause) {
    if (cause instanceof AssumptionRegistryError) throw new AssumptionRegistryError(`${absolute}: ${cause.message}`);
    throw cause;
  }
}
