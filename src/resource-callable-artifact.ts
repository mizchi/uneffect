import { createHash } from "node:crypto";
import type { ResourceCallableSummary } from "./resource-protocol.js";
import type { AssumptionEntry, AssumptionScope } from "./assumptions.js";

export const resourceCallableArtifactSchema = "uneffect-resource-callable-artifact/v1" as const;

export interface ResourceCallableContractArtifact {
  readonly schema: typeof resourceCallableArtifactSchema;
  readonly symbol: { readonly module: string; readonly export: string };
  readonly runtime: { readonly kind: "package"; readonly version: string } | { readonly kind: "node"; readonly major: number };
  readonly declarationSha256: string;
  readonly summary: ResourceCallableSummary;
  readonly trust: { readonly owner: string; readonly reason: string; readonly expiresOn?: string };
  readonly artifactSha256: string;
}

export interface ResourceCallableArtifactEnvironment {
  readonly symbol: { readonly module: string; readonly export: string };
  readonly runtime: ResourceCallableContractArtifact["runtime"];
  readonly declarationText: string;
  /** TypeChecker declaration identity used by same-Program call resolution. */
  readonly declarationId: string;
  readonly asOf: string;
}

export type ResourceCallableArtifactAuthentication =
  | { readonly status: "accepted"; readonly summary: ResourceCallableSummary; readonly artifact: ResourceCallableContractArtifact }
  | { readonly status: "blocked"; readonly reasons: readonly string[] };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function payload(artifact: Omit<ResourceCallableContractArtifact, "artifactSha256">): string {
  return JSON.stringify({
    schema: artifact.schema,
    symbol: artifact.symbol,
    runtime: artifact.runtime,
    declarationSha256: artifact.declarationSha256,
    summary: artifact.summary,
    trust: artifact.trust,
  });
}

export function createResourceCallableContractArtifact(
  input: Omit<ResourceCallableContractArtifact, "schema" | "artifactSha256" | "declarationSha256"> & { readonly declarationText: string },
): ResourceCallableContractArtifact {
  const artifact = {
    schema: resourceCallableArtifactSchema,
    symbol: input.symbol,
    runtime: input.runtime,
    declarationSha256: sha256(input.declarationText),
    summary: input.summary,
    trust: input.trust,
  } satisfies Omit<ResourceCallableContractArtifact, "artifactSha256">;
  return { ...artifact, artifactSha256: sha256(payload(artifact)) };
}

/** Converts an accepted trusted artifact into the shared assumption ledger format. */
export function resourceCallableArtifactAssumption(
  artifact: ResourceCallableContractArtifact,
  scope: AssumptionScope,
): AssumptionEntry {
  return {
    id: `resource-callable:${artifact.symbol.module}#${artifact.symbol.export}:${artifact.artifactSha256}`,
    evidence: "trusted",
    domain: "resource-callable",
    reason: artifact.trust.reason,
    owner: artifact.trust.owner,
    ...(artifact.trust.expiresOn ? { expiresOn: artifact.trust.expiresOn } : {}),
    dependency: artifact.runtime.kind === "package"
      ? { module: artifact.symbol.module, packageVersion: artifact.runtime.version }
      : { module: artifact.symbol.module, nodeMajor: artifact.runtime.major },
    scope,
  };
}

function sameRuntime(left: ResourceCallableContractArtifact["runtime"], right: ResourceCallableContractArtifact["runtime"]): boolean {
  return left.kind === right.kind && (left.kind === "package"
    ? left.version === (right as { kind: "package"; version: string }).version
    : left.major === (right as { kind: "node"; major: number }).major);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function validReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const reference = value as { kind?: unknown; index?: unknown };
  return reference.kind === "return" || (reference.kind === "parameter"
    && typeof reference.index === "number" && Number.isInteger(reference.index) && reference.index >= 0);
}

function validSummary(value: unknown): value is ResourceCallableSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<ResourceCallableSummary>;
  return summary.schema === "uneffect-resource-callable-summary/v1"
    && typeof summary.id === "string"
    && summary.evidence === "trusted"
    && Array.isArray(summary.operations)
    && summary.operations.every((operation) => {
      if (!operation || typeof operation !== "object"
        || !["acquire", "use", "borrow", "consume", "release", "transfer", "escape"].includes(operation.kind)
        || !validReference(operation.subject)) return false;
      if (operation.kind === "acquire") return operation.subject.kind === "return" && operation.target === undefined;
      if (operation.kind === "transfer") return validReference(operation.target);
      return operation.target === undefined;
    });
}

/** Authenticates provenance and trust policy; it never upgrades external evidence to verified. */
export function authenticateResourceCallableContractArtifact(
  candidate: unknown,
  environment: ResourceCallableArtifactEnvironment,
): ResourceCallableArtifactAuthentication {
  const reasons: string[] = [];
  if (!candidate || typeof candidate !== "object") return { status: "blocked", reasons: ["artifact is not an object"] };
  const artifact = candidate as Partial<ResourceCallableContractArtifact>;
  if (artifact.schema !== resourceCallableArtifactSchema) reasons.push("unsupported artifact schema");
  if (!artifact.symbol || artifact.symbol.module !== environment.symbol.module || artifact.symbol.export !== environment.symbol.export) reasons.push("symbol mismatch");
  if (!artifact.runtime || !sameRuntime(artifact.runtime, environment.runtime)) reasons.push("runtime version mismatch");
  if (artifact.declarationSha256 !== sha256(environment.declarationText)) reasons.push("declaration digest mismatch");
  if (!artifact.summary || artifact.summary.schema !== "uneffect-resource-callable-summary/v1") reasons.push("invalid resource summary");
  else if (artifact.summary.evidence !== "trusted") reasons.push("external resource summary must remain trusted");
  else if (!validSummary(artifact.summary)) reasons.push("invalid resource summary");
  else if (artifact.symbol && artifact.summary.id !== `${artifact.symbol.module}#${artifact.symbol.export}`) reasons.push("summary symbol identity mismatch");
  if (!artifact.trust?.owner || !artifact.trust.reason) reasons.push("trust owner and reason are required");
  if (artifact.trust?.expiresOn && (!validDate(artifact.trust.expiresOn) || artifact.trust.expiresOn < environment.asOf)) reasons.push("trust review is expired or invalid");
  if (!artifact.artifactSha256 || !artifact.schema || !artifact.symbol || !artifact.runtime || !artifact.declarationSha256 || !artifact.summary || !artifact.trust) {
    reasons.push("artifact payload is incomplete");
  } else {
    const expected = sha256(payload({ schema: artifact.schema, symbol: artifact.symbol, runtime: artifact.runtime,
      declarationSha256: artifact.declarationSha256, summary: artifact.summary, trust: artifact.trust }));
    if (artifact.artifactSha256 !== expected) reasons.push("artifact digest mismatch");
  }
  if (reasons.length > 0) return { status: "blocked", reasons: [...new Set(reasons)] };
  const accepted = artifact as ResourceCallableContractArtifact;
  return { status: "accepted", artifact: accepted, summary: { ...accepted.summary, id: environment.declarationId, evidence: "trusted" } };
}
