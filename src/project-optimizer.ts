import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import ts from "typescript";
import { builtinContractDigest } from "./evidence.js";
import { evaluateStableReadReuse, type OptimizationEvent } from "./optimizer.js";

export interface OptimizeUneffectProjectOptions {
  files: Record<string, string>;
  evidencePath: string;
  closedWorld: boolean;
}

export interface ProjectOptimizationTransformation {
  kind: "stable-read-reuse";
  fileName: string;
  region: string;
  applied: boolean;
  evidence: "verified" | "unknown";
  reason: string;
}

export interface StaleProjectEvidence {
  path: string;
  reason: "dependency-mismatch" | "invalid-artifact";
}

export interface OptimizeUneffectProjectResult {
  transformations: ProjectOptimizationTransformation[];
  staleEvidence: StaleProjectEvidence[];
}

interface StableReadProof { fileName: string; region: string; verified: boolean }
interface ProjectOptimizationEvidence {
  schema: "uneffect-project-optimization/v1";
  dependencies: { compilerRevision: string; builtinContractDigest: string; sourceHashes: Record<string, string>; closedWorld: boolean };
  proofs: StableReadProof[];
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function dependenciesOf(options: OptimizeUneffectProjectOptions): ProjectOptimizationEvidence["dependencies"] {
  return {
    compilerRevision: ts.version,
    builtinContractDigest: builtinContractDigest(),
    sourceHashes: Object.fromEntries(Object.entries(options.files).sort(([left], [right]) => left.localeCompare(right)).map(([name, source]) => [name, digest(source)])),
    closedWorld: options.closedWorld,
  };
}

function stableReadProofs(fileName: string, text: string): StableReadProof[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reads = new Map<string, ts.PropertyAccessExpression[]>(), invalidated = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const region = node.getText(source), parent = node.parent;
      const assignment = ts.isBinaryExpression(parent) && parent.left === node
        && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const update = ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent);
      if (assignment || update) invalidated.add(region);
      else {
        const values = reads.get(region) ?? [];
        values.push(node); reads.set(region, values);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...reads.entries()].flatMap(([region, occurrences]) => {
    if (occurrences.length < 2) return [];
    const first = occurrences[0]!, last = occurrences.at(-1)!;
    let suspends = false;
    const scan = (node: ts.Node): void => {
      if (node.getStart(source) >= first.getEnd() && node.getEnd() <= last.getStart(source) && ts.isAwaitExpression(node)) suspends = true;
      ts.forEachChild(node, scan);
    };
    scan(source);
    const events: OptimizationEvent[] = [{ kind: "read", region }, ...(suspends ? [{ kind: "suspend" as const }] : []), ...(invalidated.has(region) ? [{ kind: "mutate" as const, region }] : []), { kind: "read", region }];
    const decision = evaluateStableReadReuse({ schema: "stable-read-reuse/v1", region, firstRead: 0, reuseAt: events.length - 1, evidence: "verified", events });
    return [{ fileName, region, verified: decision.allowed }];
  });
}

function parseEvidence(path: string): ProjectOptimizationEvidence | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ProjectOptimizationEvidence;
    return value.schema === "uneffect-project-optimization/v1" && Array.isArray(value.proofs) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function optimizeUneffectProject(options: OptimizeUneffectProjectOptions): Promise<OptimizeUneffectProjectResult> {
  const dependencies = dependenciesOf(options);
  const proofs = Object.entries(options.files).flatMap(([fileName, source]) => stableReadProofs(fileName, source));
  const artifact: ProjectOptimizationEvidence = { schema: "uneffect-project-optimization/v1", dependencies, proofs };
  const existed = existsSync(options.evidencePath), previous = existed ? parseEvidence(options.evidencePath) : undefined;
  const staleEvidence: StaleProjectEvidence[] = [];
  let reusable = false;
  if (previous) {
    reusable = JSON.stringify(previous.dependencies) === JSON.stringify(dependencies);
    if (!reusable) staleEvidence.push({ path: options.evidencePath, reason: "dependency-mismatch" });
  } else if (existed) staleEvidence.push({ path: options.evidencePath, reason: "invalid-artifact" });
  mkdirSync(dirname(options.evidencePath), { recursive: true });
  writeFileSync(options.evidencePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return {
    transformations: proofs.map((proof) => ({
      kind: "stable-read-reuse", fileName: proof.fileName, region: proof.region,
      applied: reusable && proof.verified, evidence: reusable && proof.verified ? "verified" : "unknown",
      reason: reusable ? proof.verified ? "matching persisted proof permits stable-read reuse" : "local invalidation prevents reuse" : "persisted proof dependencies do not match",
    })),
    staleEvidence,
  };
}
