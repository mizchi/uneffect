import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";
import { generateOwnershipObligationQuint, generateOwnershipObligationSmt, type OwnershipGuardObligation } from "./async-safety.js";
import { builtinContractRegistry, type BuiltinContractRegistry } from "./builtin-contracts.js";
import { formatEffect, parseEffectExpression, unknownCapabilityReasons } from "./capabilities.js";
import type { EffectSummary, EvidenceStatus } from "./effects.js";
import { createZ3Context, z3Version } from "./z3.js";

export interface EvidenceArtifactSummary {
  id: string;
  fileName: string;
  span: { start: number; end: number };
  functionName: string;
  effects: string[];
  evidence: EvidenceStatus;
  parameters?: string[];
  iteratorEffectParameters?: Array<{ index: number; name: string; convertsThrowToRejection: boolean }>;
  iteratorEffectBounds?: Array<{ index: number; name: string; effects: string[] }>;
}
export interface EvidenceArtifact {
  schemaVersion: 3;
  uneffectVersion: string;
  compilerRevision: string;
  tsconfigHash: string;
  sourceFile: string;
  sourceHash: string;
  /** Hashes every non-declaration source that contributed to Program-wide analysis. */
  sourceHashes: Record<string, string>;
  builtinContractDigest: string;
  summaries: EvidenceArtifactSummary[];
}

export type EvidenceArtifactValidationReason =
  | "invalid-artifact"
  | "schema-mismatch"
  | "uneffect-version-mismatch"
  | "compiler-revision-mismatch"
  | "tsconfig-mismatch"
  | "source-file-mismatch"
  | "source-hash-mismatch"
  | "source-hashes-mismatch"
  | "builtin-contract-mismatch"
  | "summary-mismatch";

export interface EvidenceArtifactValidation {
  valid: boolean;
  reasons: EvidenceArtifactValidationReason[];
}

export type EvidenceArtifactEligibilityReason =
  | Exclude<EvidenceStatus, "verified">
  | "unknown-capability-scope"
  | "open-iterator-effect"
  | "duplicate-summary-id"
  | "vacuous";

export interface EvidenceArtifactEligibilityBlocker {
  summaryId: string;
  reason: EvidenceArtifactEligibilityReason;
}

export interface EvidenceArtifactEligibility {
  eligible: boolean;
  vacuous: boolean;
  blockers: EvidenceArtifactEligibilityBlocker[];
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const uneffectVersion = "0.0.0-alpha.0";
export function builtinContractDigest(registry: BuiltinContractRegistry = builtinContractRegistry): string {
  return digest(JSON.stringify(registry));
}
export function createEvidenceArtifact(
  program: ts.Program,
  source: ts.SourceFile,
  summaries: readonly EffectSummary[],
  registry: BuiltinContractRegistry,
): EvidenceArtifact {
  const sourceHashes = Object.fromEntries(program.getSourceFiles()
    .filter((item) => !item.isDeclarationFile)
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((item) => [item.fileName, digest(item.text)]));
  return {
    schemaVersion: 3,
    uneffectVersion,
    compilerRevision: ts.version,
    tsconfigHash: digest(JSON.stringify(program.getCompilerOptions(), Object.keys(program.getCompilerOptions()).sort())),
    sourceFile: source.fileName,
    sourceHash: digest(source.text),
    sourceHashes,
    builtinContractDigest: builtinContractDigest(registry),
    summaries: summaries.map((summary) => {
      if (!summary.id || !summary.fileName || !summary.span) {
        throw new Error(`cannot create proof evidence for ${summary.functionName} without Program source identity`);
      }
      return {
        id: summary.id, fileName: summary.fileName, span: summary.span,
        functionName: summary.functionName,
        effects: summary.effects.map(formatEffect).sort(),
        evidence: summary.evidence,
        ...(summary.parameters ? { parameters: summary.parameters } : {}),
        ...(summary.iteratorEffectParameters ? { iteratorEffectParameters: summary.iteratorEffectParameters } : {}),
        ...(summary.iteratorEffectBounds ? { iteratorEffectBounds: summary.iteratorEffectBounds.map((bound) => ({
          index: bound.index, name: bound.name, effects: bound.effects.map(formatEffect).sort(),
        })) } : {}),
      };
    }),
  };
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
}

/**
 * Regenerates every analyzer-controlled input and rejects stale, partial, or
 * modified effect evidence. This checks freshness/integrity within Uneffect's
 * analyzer TCB; it is not an independently checkable proof certificate.
 */
export function validateEvidenceArtifact(
  program: ts.Program,
  source: ts.SourceFile,
  summaries: readonly EffectSummary[],
  artifact: unknown,
  registry: BuiltinContractRegistry,
): EvidenceArtifactValidation {
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
    return { valid: false, reasons: ["invalid-artifact"] };
  }
  const actual = artifact as Partial<EvidenceArtifact>;
  const expected = createEvidenceArtifact(program, source, summaries, registry);
  const reasons: EvidenceArtifactValidationReason[] = [];
  if (actual.schemaVersion !== expected.schemaVersion) reasons.push("schema-mismatch");
  if (actual.uneffectVersion !== expected.uneffectVersion) reasons.push("uneffect-version-mismatch");
  if (actual.compilerRevision !== expected.compilerRevision) reasons.push("compiler-revision-mismatch");
  if (actual.tsconfigHash !== expected.tsconfigHash) reasons.push("tsconfig-mismatch");
  if (actual.sourceFile !== expected.sourceFile) reasons.push("source-file-mismatch");
  if (actual.sourceHash !== expected.sourceHash) reasons.push("source-hash-mismatch");
  if (canonicalJson(actual.sourceHashes) !== canonicalJson(expected.sourceHashes)) reasons.push("source-hashes-mismatch");
  if (actual.builtinContractDigest !== expected.builtinContractDigest) reasons.push("builtin-contract-mismatch");
  if (canonicalJson(actual.summaries) !== canonicalJson(expected.summaries)) reasons.push("summary-mismatch");
  return { valid: reasons.length === 0, reasons };
}

/**
 * Determines whether a fresh artifact contains only proof-grade, closed effect
 * summaries. Call this only after validateEvidenceArtifact: eligibility is not
 * a freshness check and remains relative to Uneffect's analyzer TCB.
 */
export function assessEvidenceArtifactEligibility(
  artifact: Pick<EvidenceArtifact, "summaries">,
): EvidenceArtifactEligibility {
  if (artifact.summaries.length === 0) {
    return {
      eligible: false,
      vacuous: true,
      blockers: [{ summaryId: "<artifact>", reason: "vacuous" }],
    };
  }

  const blockers: EvidenceArtifactEligibilityBlocker[] = [];
  const seenIds = new Set<string>();
  for (const summary of artifact.summaries) {
    if (seenIds.has(summary.id)) {
      blockers.push({ summaryId: summary.id, reason: "duplicate-summary-id" });
    }
    seenIds.add(summary.id);

    if (summary.evidence !== "verified") {
      blockers.push({ summaryId: summary.id, reason: summary.evidence });
    }
    if (summary.effects.some((effect) => unknownCapabilityReasons(parseEffectExpression(effect)).length > 0)) {
      blockers.push({ summaryId: summary.id, reason: "unknown-capability-scope" });
    }

    const boundedIndexes = new Set(summary.iteratorEffectBounds?.map((bound) => bound.index) ?? []);
    if (summary.iteratorEffectParameters?.some((parameter) => !boundedIndexes.has(parameter.index))) {
      blockers.push({ summaryId: summary.id, reason: "open-iterator-effect" });
    }
  }

  return { eligible: blockers.length === 0, vacuous: false, blockers };
}

export function trustedSummary(functionName: string, effects: EffectSummary["effects"]): EffectSummary {
  return { functionName, effects, evidence: "trusted" };
}

export interface OwnershipEvidenceArtifact {
  schema: "ownership-evidence/v1";
  backend: "z3" | "quint";
  backendVersion: string;
  obligationHash: string;
  verifierProgramHash: string;
  result: "verified" | "counterexample" | "unknown" | "error";
  evidence: "verified" | "unknown";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The optional Quint peer, run through its own entry point instead of whatever `quint` PATH holds. */
function resolveQuint(): { bin: string; version: string } | undefined {
  for (const resolver of [createRequire(join(process.cwd(), "package.json")), createRequire(import.meta.url)]) {
    try {
      const manifestPath = resolver.resolve("@informalsystems/quint/package.json");
      const manifest = resolver(manifestPath) as { version?: string; bin?: Record<string, string> | string };
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.quint;
      if (entry) return { bin: join(dirname(manifestPath), entry), version: manifest.version ?? "unknown" };
    } catch {
      continue;
    }
  }
  return undefined;
}

function ownershipObligationHash(obligation: OwnershipGuardObligation): string {
  return digest(JSON.stringify(obligation));
}

/**
 * Runs the generated refutation query and binds the result to all reproducibility inputs.
 * The solver is the `z3-solver` WASM build, so no native Z3 installation is involved.
 */
export async function verifyOwnershipObligationWithZ3(obligation: OwnershipGuardObligation): Promise<OwnershipEvidenceArtifact> {
  const program = generateOwnershipObligationSmt(obligation);
  const base = {
    schema: "ownership-evidence/v1" as const, backend: "z3" as const, backendVersion: await z3Version(),
    obligationHash: ownershipObligationHash(obligation), verifierProgramHash: digest(program),
  };
  try {
    const context = await createZ3Context("ownership");
    const solver = new context.Solver();
    solver.fromString(program);
    const answer = String(await solver.check());
    const result = answer === "unsat" ? "verified" : answer === "sat" ? "counterexample" : "unknown";
    return { ...base, result, evidence: result === "verified" ? "verified" : "unknown", exitCode: 0, stdout: `${answer}\n`, stderr: "" };
  } catch (cause) {
    return { ...base, result: "error", evidence: "unknown", exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function verifyOwnershipObligationWithQuint(obligation: OwnershipGuardObligation): OwnershipEvidenceArtifact {
  const program = generateOwnershipObligationQuint("ownership_evidence", obligation);
  const quint = resolveQuint();
  const directory = mkdtempSync(join(tmpdir(), "uneffect-ownership-")), fileName = join(directory, "model.qnt");
  writeFileSync(fileName, program);
  const missing = { error: new Error("@informalsystems/quint is not installed; add the optional peer dependency to verify ownership with Quint"), status: null, stdout: "", stderr: "" };
  const execution: { error?: Error; status: number | null; stdout: string; stderr: string } = quint
    ? spawnSync(process.execPath, [quint.bin, "verify", fileName, "--backend=tlc", "--invariant=ownershipSafe", "--max-steps=1", "--verbosity=5"], { encoding: "utf8", timeout: 30_000 })
    : missing;
  rmSync(directory, { recursive: true });
  const output = `${execution.stdout}${execution.stderr}`;
  const result = execution.error ? "error" : execution.status === 0 ? "verified" : /violation|counterexample/i.test(output) ? "counterexample" : "unknown";
  return {
    schema: "ownership-evidence/v1", backend: "quint", backendVersion: quint?.version ?? "unknown",
    obligationHash: ownershipObligationHash(obligation), verifierProgramHash: digest(program), result,
    evidence: result === "verified" ? "verified" : "unknown", exitCode: execution.status,
    stdout: execution.stdout, stderr: execution.error ? `${execution.stderr}${execution.error.message}` : execution.stderr,
  };
}

/** Rejects stale, tampered, non-proof, or differently generated evidence. */
export function validateOwnershipEvidence(artifact: OwnershipEvidenceArtifact, obligation: OwnershipGuardObligation): boolean {
  const program = artifact.backend === "z3" ? generateOwnershipObligationSmt(obligation) : generateOwnershipObligationQuint("ownership_evidence", obligation);
  return artifact.schema === "ownership-evidence/v1"
    && artifact.result === "verified"
    && artifact.evidence === "verified"
    && artifact.exitCode === 0
    && artifact.obligationHash === ownershipObligationHash(obligation)
    && artifact.verifierProgramHash === digest(program);
}
