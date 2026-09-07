import type { Node, ExpressionStatement } from "oxc-parser";
import { oxcChildren, parseOxcSource } from "../frontends/oxc/source.js";
import { analyzeAsyncSafety, type AsyncSafetyResult, type OwnershipGuardObligation } from "../async/async-safety.js";
import { validateOwnershipEvidence, verifyOwnershipObligationWithZ3, type OwnershipEvidenceArtifact } from "../evidence/evidence.js";
import { applyOwnershipAssertionElision } from "./optimizer.js";
import { ownershipEvidenceKey, readOwnershipEvidenceCache, writeOwnershipEvidenceCache, type OwnershipEvidenceCacheEntry } from "./ownership-evidence-cache.js";

import { instrumentRuntimeAssertions, type InstrumentDiagnostic, type InstrumentResult } from "./runtime-assertions.js";
export { instrumentRuntimeAssertions };
export type { InstrumentDiagnostic, InstrumentResult };

export interface OwnershipAssertionInsertion { obligation: OwnershipGuardObligation; assertion: string }
export interface OwnershipInstrumentResult extends InstrumentResult {
  analysis: AsyncSafetyResult;
  assertions: OwnershipAssertionInsertion[];
}
export interface VerifiedOwnershipBuildResult extends InstrumentResult {
  artifacts: OwnershipEvidenceArtifact[];
  unresolved: OwnershipGuardObligation[];
}
export interface CachedVerifiedOwnershipBuildResult extends VerifiedOwnershipBuildResult {
  cache: { reused: number; verified: number; stale: OwnershipEvidenceCacheEntry[] };
}

const ownershipRuntime = `function uneffectAssertOwnership(condition: boolean, detail: string): asserts condition { if (!condition) throw new Error("Uneffect ownership assertion failed: " + detail) }\n`;

/** Inserts runtime checks only for unresolved, direct expression-statement ownership calls. */
export function instrumentOwnershipAssertions(fileName: string, text: string): OwnershipInstrumentResult {
  const analysis = analyzeAsyncSafety(fileName, text), source = parseOxcSource(fileName, text);
  const diagnostics: InstrumentDiagnostic[] = [], insertions: Array<{ position: number; text: string }> = [], assertions: OwnershipAssertionInsertion[] = [];
  for (const obligation of analysis.ownershipObligations.filter((item) => item.status === "unresolved")) {
    let statement: ExpressionStatement | undefined;
    const find = (node: Node): void => {
      if (statement || obligation.span.start < node.start || obligation.span.end > node.end) return;
      if (node.type === "ExpressionStatement") {
        const call = node.expression.type === "ChainExpression" ? node.expression.expression : node.expression;
        if (call.type === "CallExpression" && call.start === obligation.span.start && call.end === obligation.span.end) {
          statement = node;
          return;
        }
      }
      for (const child of oxcChildren(node)) find(child);
    };
    find(source.program);
    if (!statement) {
      diagnostics.push({ fileName, line: source.positionAt(obligation.span.start).line + 1, kind: "unsupported-function", parameter: String(obligation.parameter), message: "ownership runtime assertions currently require a direct expression-statement call" });
      continue;
    }
    const detail = `${obligation.owner}:${obligation.span.start}:${obligation.parameter}`;
    const assertion = `uneffectAssertOwnership(${obligation.goal}, ${JSON.stringify(detail)});`;
    insertions.push({ position: statement.start, text: `${assertion}\n` });
    assertions.push({ obligation, assertion });
  }
  let code = text;
  for (const insertion of insertions.sort((left, right) => right.position - left.position)) code = code.slice(0, insertion.position) + insertion.text + code.slice(insertion.position);
  if (assertions.length > 0) code = ownershipRuntime + code;
  return { code, diagnostics, analysis, assertions };
}

/** Elides generated checks only when a matching proof artifact validates. */
export function optimizeOwnershipAssertions(result: OwnershipInstrumentResult, artifacts: readonly OwnershipEvidenceArtifact[]): InstrumentResult {
  let code = result.code;
  for (const item of result.assertions) {
    const artifact = artifacts.find((candidate) => validateOwnershipEvidence(candidate, item.obligation));
    if (!artifact) continue;
    const start = code.indexOf(item.assertion);
    if (start < 0) continue;
    code = applyOwnershipAssertionElision(code, { schema: "ownership-guard-elision/v1", ownership: item.obligation, artifact, generatedAssertion: true }, { start, end: start + item.assertion.length }).code;
  }
  if (code.startsWith(ownershipRuntime) && result.assertions.every((item) => !code.includes(item.assertion))) code = code.slice(ownershipRuntime.length);
  return { code, diagnostics: result.diagnostics };
}

/** Runs the deterministic ownership instrumentation, Z3 verification, and safe generated-check elision pipeline. */
export async function buildVerifiedOwnership(fileName: string, text: string): Promise<VerifiedOwnershipBuildResult> {
  const instrumented = instrumentOwnershipAssertions(fileName, text);
  const artifacts: OwnershipEvidenceArtifact[] = [];
  for (const item of instrumented.assertions) artifacts.push(await verifyOwnershipObligationWithZ3(item.obligation));
  const optimized = optimizeOwnershipAssertions(instrumented, artifacts);
  const unresolved = instrumented.assertions
    .filter((item) => !artifacts.some((artifact) => validateOwnershipEvidence(artifact, item.obligation)))
    .map((item) => item.obligation);
  return { code: optimized.code, diagnostics: optimized.diagnostics, artifacts, unresolved };
}

/** Reuses only matching proof-grade evidence and atomically persists newly checked obligations. */
export async function buildVerifiedOwnershipCached(fileName: string, text: string, evidencePath: string): Promise<CachedVerifiedOwnershipBuildResult> {
  const instrumented = instrumentOwnershipAssertions(fileName, text);
  const cache = readOwnershipEvidenceCache(evidencePath);
  const artifacts: OwnershipEvidenceArtifact[] = [], stale: OwnershipEvidenceCacheEntry[] = [];
  let reused = 0, verified = 0;
  const updated = [...cache.entries];
  const occurrences = new Map<string, number>();
  for (const assertion of instrumented.assertions) {
    const base = ownershipEvidenceKey(fileName, assertion.obligation);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const key = ownershipEvidenceKey(fileName, assertion.obligation, occurrence);
    const candidates = cache.entries.filter((entry) => entry.key === key);
    const matching = candidates.find((entry) => validateOwnershipEvidence(entry.artifact, assertion.obligation));
    let artifact: OwnershipEvidenceArtifact;
    if (matching) { artifact = matching.artifact; reused += 1; }
    else {
      stale.push(...candidates.filter((entry) => entry.artifact?.result === "verified" && entry.artifact.evidence === "verified"));
      artifact = await verifyOwnershipObligationWithZ3(assertion.obligation);
      verified += 1;
    }
    artifacts.push(artifact);
    const entry = { fileName, key, obligation: assertion.obligation, artifact };
    const index = updated.findIndex((item) => item.key === key);
    if (index < 0) updated.push(entry); else updated[index] = entry;
  }
  writeOwnershipEvidenceCache(evidencePath, { schema: "ownership-evidence-cache/v1", entries: updated });
  const optimized = optimizeOwnershipAssertions(instrumented, artifacts);
  const unresolved = instrumented.assertions.filter((item) => !artifacts.some((artifact) => validateOwnershipEvidence(artifact, item.obligation))).map((item) => item.obligation);
  return { code: optimized.code, diagnostics: optimized.diagnostics, artifacts, unresolved, cache: { reused, verified, stale } };
}
