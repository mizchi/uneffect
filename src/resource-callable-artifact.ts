import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "@typescript/typescript6";
import type { ResourceCallableSummary } from "./resource-protocol.js";
import type { AssumptionEntry, AssumptionScope } from "./assumptions.js";
import { resolveStableCallableSymbol } from "./stable-callable.js";

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

export interface BoundResourceCallableArtifacts {
  readonly summaries: readonly ResourceCallableSummary[];
  readonly assumptions: readonly AssumptionEntry[];
  readonly blockers: readonly string[];
}

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

/** Loads a JSON artifact; semantic and provenance checks happen during Program binding. */
export async function loadResourceCallableContractArtifact(fileName: string): Promise<ResourceCallableContractArtifact> {
  const absolute = resolve(fileName);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolute, "utf8"));
  } catch (cause) {
    throw new Error(`${absolute}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!value || typeof value !== "object" || (value as { schema?: unknown }).schema !== resourceCallableArtifactSchema) {
    throw new Error(`${absolute}: expected ${resourceCallableArtifactSchema}`);
  }
  const artifact = value as Partial<ResourceCallableContractArtifact>;
  if (!artifact.symbol || typeof artifact.symbol.module !== "string" || typeof artifact.symbol.export !== "string") {
    throw new Error(`${absolute}: resource artifact requires symbol.module and symbol.export`);
  }
  return artifact as ResourceCallableContractArtifact;
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
  return reference.kind === "return" || reference.kind === "receiver" || (reference.kind === "parameter"
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

function installedPackageVersion(declarationFileName: string, packageName: string): string | undefined {
  for (let directory = dirname(declarationFileName);;) {
    const manifestFile = join(directory, "package.json");
    if (existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === packageName && typeof manifest.version === "string") return manifest.version;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function packageNameForModule(module: string): string {
  const parts = module.split("/");
  return module.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * Discovers artifact symbols only through module specifiers selected by this
 * Program, authenticates installed runtime/declaration bytes, and returns
 * declaration-rebound trusted summaries plus source-scoped ledger entries.
 */
export function bindResourceCallableArtifactsToProgram(
  artifacts: readonly ResourceCallableContractArtifact[],
  program: ts.Program,
  asOf: string,
): BoundResourceCallableArtifacts {
  const checker = program.getTypeChecker();
  const summaries: ResourceCallableSummary[] = [];
  const assumptions: AssumptionEntry[] = [];
  const blockers: string[] = [];
  for (const artifact of artifacts) {
    const targets = new Set<ts.Symbol>();
    for (const source of program.getSourceFiles()) {
      if (source.isDeclarationFile) continue;
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
          && node.moduleSpecifier.text === artifact.symbol.module) {
          const module = checker.getSymbolAtLocation(node.moduleSpecifier);
          const exported = module && checker.getExportsOfModule(module).find((candidate) => candidate.name === artifact.symbol.export);
          if (exported) targets.add((exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (targets.size === 0) {
      blockers.push(`${artifact.symbol.module}#${artifact.symbol.export}: module export was not resolved by the TypeScript Program`);
      continue;
    }
    for (const target of targets) {
      const declaration = target.valueDeclaration ?? target.declarations?.[0];
      if (!declaration) {
        blockers.push(`${artifact.symbol.module}#${artifact.symbol.export}: resolved export has no declaration`);
        continue;
      }
      const declarationSource = declaration.getSourceFile();
      const runtime: ResourceCallableContractArtifact["runtime"] = artifact.symbol.module.startsWith("node:")
        ? { kind: "node", major: Number(process.versions.node.split(".")[0]) }
        : { kind: "package", version: installedPackageVersion(declarationSource.fileName,
          packageNameForModule(artifact.symbol.module)) ?? "<unresolved>" };
      const accepted = authenticateResourceCallableContractArtifact(artifact, {
        symbol: artifact.symbol, runtime, declarationText: declarationSource.text,
        declarationId: `${declarationSource.fileName}:${declaration.getStart(declarationSource)}`, asOf,
      });
      if (accepted.status === "blocked") {
        blockers.push(...accepted.reasons.map((reason) => `${artifact.symbol.module}#${artifact.symbol.export}: ${reason}`));
        continue;
      }
      summaries.push(accepted.summary);
      for (const source of program.getSourceFiles()) {
        if (source.isDeclarationFile) continue;
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && resolveStableCallableSymbol(checker, node.expression) === target) {
            assumptions.push(resourceCallableArtifactAssumption(accepted.artifact, {
              fileName: source.fileName, span: { start: node.getStart(source), end: node.getEnd() },
            }));
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  }
  return { summaries, assumptions, blockers: [...new Set(blockers)] };
}
