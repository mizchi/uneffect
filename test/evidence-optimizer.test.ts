import ts from "typescript";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessEvidenceArtifactEligibility, createEvidenceArtifact, validateEvidenceArtifact, validateOwnershipEvidence, verifyOwnershipObligationWithQuint, verifyOwnershipObligationWithZ3 } from "../src/evidence.js";
import type { OwnershipGuardObligation } from "../src/async-safety.js";
import { analyzeEffectSummariesInProgram } from "../src/effects.js";
import { applyOwnershipAssertionElision, applyStableReadReuse, evaluateOwnershipGuardElision, evaluatePropertyMangle, evaluateStableReadReuse } from "../src/optimizer.js";
import { verifyUneffectProject } from "../src/project-verification.js";

function programOf(text: string) {
  const fileName = "/virtual/evidence.ts";
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, language, true) : original(name, language, onError, fresh);
  const program = ts.createProgram([fileName], options, host);
  return { program, source: program.getSourceFile(fileName)! };
}

describe("evidence and optimizer obligations", () => {
  it("rejects a vacuous project verification result", async () => {
    const result = await verifyUneffectProject({ files: {} });
    expect(result.assurance).toMatchObject({ status: "unknown", passed: false, coverage: { checkedFiles: 0 } });
    expect(result.assurance.blockers).toContainEqual(expect.objectContaining({
      domain: "coverage", classification: "unknown", fileName: "<project>", subject: "<coverage>",
    }));
  });

  it("distinguishes verified evidence from accepted assumptions", async () => {
    const verified = await verifyUneffectProject({ files: {
      "src/pure.ts": `export function identity(value: number) { return value }`,
    } });
    expect(verified.assurance).toMatchObject({ status: "verified", passed: true });

    const assumed = await verifyUneffectProject({ files: {
      "src/report.ts": `export function report() { console.log("ok") }`,
    } });
    expect(assumed.assumptions.entries).not.toHaveLength(0);
    expect(assumed.assurance).toMatchObject({ status: "assumed", passed: true });
    expect(assumed.assurance.assumptions).toBe(assumed.assumptions.entries.length);
  });

  it("records reviewed external module initialization as an assumption", async () => {
    const fileName = "src/node-module.ts";
    const result = await verifyUneffectProject({ files: {
      [fileName]: `import "node:path"; export const loaded = true`,
    } });

    expect(result.effects.summaries.find((item) => item.functionName === "<module>"))
      .toMatchObject({ evidence: "trusted" });
    expect(result.assumptions.entries).toContainEqual(expect.objectContaining({
      domain: "module-initialization",
      dependency: { module: "node:path", nodeMajor: 24 },
      scope: expect.objectContaining({ fileName }),
    }));
    expect(result.assurance).toMatchObject({ status: "assumed", passed: true });
  });

  it("makes runtime instrumentation failures project assurance blockers", async () => {
    const fileName = "src/runtime-boundary.ts";
    const result = await verifyUneffectProject({ runtimeAssertions: "fallback", files: { [fileName]: `
      /* uneffect: assert missing: Nat */
      export function parse(value: number) { return value }
    ` } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "unknown-parameter", parameter: "missing" }));
    expect(result.assurance).toMatchObject({ status: "unknown", passed: false });
    expect(result.assurance.blockers).toContainEqual(expect.objectContaining({
      domain: "instrument", classification: "unknown", fileName, subject: "missing",
    }));
  });

  it("does not issue project-level proof evidence for an ill-typed source", async () => {
    const fileName = "src/invalid-project.ts";
    const result = await verifyUneffectProject({ temporalRuntime: "web", files: { [fileName]: `
      const broken: number = "not-a-number"
      type BoundedUint8Array<N extends number> = Uint8Array
      function writeTag(output: BoundedUint8Array<1>) { output[0] = 7 }
      /* uneffect: ensures result === value */
      export function identity(value: number): number { return value }
    ` } });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      domain: "typescript", kind: "semantic", fileName, severity: "error",
    }));
    expect(result.effects.summaries.filter((summary) => summary.fileName === fileName))
      .toEqual(expect.arrayContaining([expect.objectContaining({ evidence: "unknown" })]));
    expect(result.obligations).not.toContainEqual(expect.objectContaining({ result: "verified" }));
    expect(result.typedArrays.obligations.length).toBeGreaterThan(0);
    expect(result.typedArrays.obligations).not.toContainEqual(expect.objectContaining({ result: "verified" }));
    expect(result.temporal?.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName, name: "eventLoopSafe", result: "error", output: expect.stringContaining("TypeScript errors") }),
    ]));
    expect(result.assurance).toMatchObject({ status: "violated", passed: false, coverage: { checkedFiles: 1 } });
    expect(result.assurance.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "typescript", fileName }),
      expect.objectContaining({ domain: "contract", fileName }),
      expect.objectContaining({ domain: "typed-array", fileName }),
      expect.objectContaining({ domain: "temporal", fileName }),
    ]));
  });

  it("attaches evidence to every summary and binds reproducibility inputs", () => {
    const { program, source } = programOf(`
      /* uneffect: effect Console */ function checked() { console.log("x") }
      function inferred() { console.log("x") }
      /* uneffect: effect Console */ function unknown() { fetch("https://example.com") }
    `);
    const result = analyzeEffectSummariesInProgram(program, source);
    const artifact = createEvidenceArtifact(program, source, result.summaries);
    expect(artifact.uneffectVersion).toBe((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version);
    expect(artifact.summaries.filter((item) => item.functionName !== "<module>").map((item) => item.evidence))
      .toEqual(["verified", "inferred", "unknown"]);
    expect(artifact).toMatchObject({
      schemaVersion: 3, sourceFile: source.fileName,
      compilerRevision: expect.any(String), tsconfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceHashes: { [source.fileName]: expect.stringMatching(/^[a-f0-9]{64}$/) },
      builtinContractDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(artifact.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.any(String), fileName: source.fileName, span: expect.any(Object) }),
    ]));
  });

  it("preserves polymorphic iterator contracts and bounds in evidence artifacts", () => {
    const { program, source } = programOf(`
      /* uneffect: effect Console */ function* generate() { console.log("step"); yield 1 }
      /* uneffect: effect_parameter iterator extends Console */
      function consume(iterator: IteratorObject<unknown>) { iterator.next() }
      /* uneffect: effect Console */ function main() { consume(generate()) }
    `);
    const artifact = createEvidenceArtifact(program, source, analyzeEffectSummariesInProgram(program, source).summaries);
    expect(artifact.summaries.find((summary) => summary.functionName === "consume")).toMatchObject({
      evidence: "verified",
      iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: false }],
      iteratorEffectBounds: [{ index: 0, name: "iterator", effects: ["Console"] }],
    });
  });

  it("changes evidence inputs when any analyzed Program source changes", () => {
    const root = "/virtual/root.ts", dependency = "/virtual/dependency.ts";
    const build = (dependencyText: string) => {
      const files = new Map([[root, `export const root = 1`], [dependency, dependencyText]]);
      const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, noEmit: true };
      const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
      host.getSourceFile = (name, language, onError, fresh) => files.has(name)
        ? ts.createSourceFile(name, files.get(name)!, language, true) : original(name, language, onError, fresh);
      const program = ts.createProgram([...files.keys()], options, host), source = program.getSourceFile(root)!;
      return { program, source, artifact: createEvidenceArtifact(program, source, []) };
    };
    const before = build(`export const dependency = 1`), after = build(`export const dependency = 2`);
    expect(before.artifact.sourceHash).toBe(after.artifact.sourceHash);
    expect(before.artifact.sourceHashes[root]).toBe(after.artifact.sourceHashes[root]);
    expect(before.artifact.sourceHashes[dependency]).not.toBe(after.artifact.sourceHashes[dependency]);
    expect(validateEvidenceArtifact(after.program, after.source, [], before.artifact)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["source-hashes-mismatch"]),
    });
    const reordered = { ...after.artifact, sourceHashes: Object.fromEntries(Object.entries(after.artifact.sourceHashes).reverse()) };
    expect(validateEvidenceArtifact(after.program, after.source, [], reordered)).toEqual({ valid: true, reasons: [] });
  });

  it("validates effect evidence against every regenerated dependency and summary", () => {
    const { program, source } = programOf(`
      /* uneffect: effect Console */ function report() { console.log("ok") }
    `);
    const summaries = analyzeEffectSummariesInProgram(program, source).summaries;
    const artifact = createEvidenceArtifact(program, source, summaries);
    expect(validateEvidenceArtifact(program, source, summaries, artifact)).toEqual({ valid: true, reasons: [] });

    const tamperedSummary = structuredClone(artifact);
    tamperedSummary.summaries[0]!.effects = [];
    expect(validateEvidenceArtifact(program, source, summaries, tamperedSummary)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["summary-mismatch"]),
    });

    const partialSources = structuredClone(artifact);
    partialSources.sourceHashes = {};
    expect(validateEvidenceArtifact(program, source, summaries, partialSources)).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["source-hashes-mismatch"]),
    });

    expect(validateEvidenceArtifact(program, source, summaries, { ...artifact, compilerRevision: "stale" })).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["compiler-revision-mismatch"]),
    });
    expect(validateEvidenceArtifact(program, source, summaries, { ...artifact, builtinContractDigest: "modified" })).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["builtin-contract-mismatch"]),
    });
    expect(validateEvidenceArtifact(program, source, summaries, null)).toEqual({ valid: false, reasons: ["invalid-artifact"] });

    expect(validateEvidenceArtifact(program, source, summaries, { ...artifact, schemaVersion: 2 })).toMatchObject({
      valid: false, reasons: expect.arrayContaining(["schema-mismatch"]),
    });
    expect(() => createEvidenceArtifact(program, source, [{ functionName: "manual", effects: [], evidence: "verified" }]))
      .toThrow(/source identity/);
  });

  it("separates fresh evidence inventory from proof eligibility", () => {
    const located = { id: "safe.ts:0", fileName: "safe.ts", span: { start: 0, end: 10 }, functionName: "safe", effects: [] };
    expect(assessEvidenceArtifactEligibility({ summaries: [{ ...located, evidence: "verified" }] })).toEqual({
      eligible: true, vacuous: false, blockers: [],
    });
    for (const evidence of ["inferred", "trusted", "unknown"] as const) {
      expect(assessEvidenceArtifactEligibility({ summaries: [{ ...located, evidence }] })).toMatchObject({
        eligible: false, blockers: [expect.objectContaining({ summaryId: located.id, reason: evidence })],
      });
    }
    expect(assessEvidenceArtifactEligibility({ summaries: [] })).toEqual({
      eligible: false, vacuous: true, blockers: [{ reason: "vacuous", summaryId: "<artifact>" }],
    });
    expect(assessEvidenceArtifactEligibility({ summaries: [{
      ...located, evidence: "verified", iteratorEffectParameters: [{ index: 0, name: "items", convertsThrowToRejection: false }],
    }] })).toMatchObject({
      eligible: false, blockers: [expect.objectContaining({ reason: "open-iterator-effect" })],
    });
    expect(assessEvidenceArtifactEligibility({ summaries: [
      { ...located, evidence: "verified" }, { ...located, functionName: "duplicate", evidence: "verified" },
    ] })).toMatchObject({
      eligible: false, blockers: [expect.objectContaining({ reason: "duplicate-summary-id" })],
    });
  });

  it("allows stable-read reuse only with proof-grade evidence and no invalidation", () => {
    const base = { schema: "stable-read-reuse/v1" as const, region: "state.value", firstRead: 0, reuseAt: 2, evidence: "verified" as const };
    expect(evaluateStableReadReuse({ ...base, events: [{ kind: "read", region: "state.value" }, { kind: "read", region: "other" }, { kind: "read", region: "state.value" }] }).allowed).toBe(true);
    expect(evaluateStableReadReuse({ ...base, events: [{ kind: "read" }, { kind: "mutate", region: "state" }, { kind: "read" }] }).allowed).toBe(false);
    expect(evaluateStableReadReuse({ ...base, evidence: "unknown", events: [{ kind: "read" }, { kind: "read" }, { kind: "read" }] }).allowed).toBe(false);
    expect(evaluateStableReadReuse({ ...base, evidence: "trusted", events: [{ kind: "read" }, { kind: "read" }, { kind: "read" }] })).toMatchObject({
      allowed: false, reason: expect.stringContaining("trusted evidence cannot authorize"),
    });
    const source = "const cached = state.value; use(state.value)";
    const start = source.lastIndexOf("state.value");
    expect(applyStableReadReuse(source, { ...base, events: [{ kind: "read" }, { kind: "read", region: "other" }, { kind: "read" }] }, { start, end: start + "state.value".length }, "cached").code)
      .toBe("const cached = state.value; use(cached)");
    expect(applyStableReadReuse(source, { ...base, evidence: "unknown", events: [{ kind: "read" }, { kind: "read" }, { kind: "read" }] }, { start, end: start + 11 }, "cached").code).toBe(source);
  });

  it("keeps property mangling behind a separate closed-world obligation", () => {
    const safe = { schema: "property-mangle/v1" as const, property: "internal", evidence: "verified" as const, closedWorld: true, reflection: false, escaped: false };
    expect(evaluatePropertyMangle(safe).allowed).toBe(true);
    expect(evaluatePropertyMangle({ ...safe, reflection: true }).allowed).toBe(false);
    expect(evaluatePropertyMangle({ ...safe, closedWorld: false }).allowed).toBe(false);
    expect(evaluatePropertyMangle({ ...safe, evidence: "trusted" })).toMatchObject({
      allowed: false, reason: expect.stringContaining("trusted evidence cannot authorize"),
    });
  });

  it("binds ownership proof evidence to the obligation, verifier program, and Z3 version", async () => {
    const obligation: OwnershipGuardObligation = { owner: "run", callee: "consume", ownership: "promise", parameter: 1, assumptions: ["enabled && active"], goal: "enabled && active", status: "verified", evidence: "finite-propositional", span: { start: 10, end: 20 } };
    const artifact = await verifyOwnershipObligationWithZ3(obligation);
    expect(artifact).toMatchObject({ schema: "ownership-evidence/v1", backend: "z3", result: "verified", evidence: "verified", exitCode: 0 });
    expect(artifact.backendVersion).toMatch(/^Z3 \d+\./u);
    expect(artifact.obligationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.verifierProgramHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validateOwnershipEvidence(artifact, obligation)).toBe(true);
    expect(validateOwnershipEvidence({ ...artifact, verifierProgramHash: "0".repeat(64) }, obligation)).toBe(false);
    expect(validateOwnershipEvidence(artifact, { ...obligation, goal: "enabled" })).toBe(false);
    const quintArtifact = verifyOwnershipObligationWithQuint(obligation);
    expect(quintArtifact).toMatchObject({ backend: "quint", backendVersion: expect.stringMatching(/^0\.32\.0/) });
    expect(validateOwnershipEvidence(quintArtifact, obligation)).toBe(quintArtifact.result === "verified");
    if (quintArtifact.result !== "verified") expect(quintArtifact.evidence).toBe("unknown");

    const optimization = { schema: "ownership-guard-elision/v1" as const, ownership: obligation, artifact, generatedAssertion: true as const };
    expect(evaluateOwnershipGuardElision(optimization).allowed).toBe(true);
    const source = "work();uneffectAssertOwnership(token);done()";
    const start = source.indexOf("uneffectAssertOwnership");
    expect(applyOwnershipAssertionElision(source, optimization, { start, end: source.indexOf(";done") + 1 }).code).toBe("work();done()");
    expect(applyOwnershipAssertionElision(source, { ...optimization, artifact: { ...artifact, result: "unknown", evidence: "unknown" } }, { start, end: source.indexOf(";done") + 1 }).code).toBe(source);
    expect(evaluateOwnershipGuardElision({ ...optimization, generatedAssertion: false }).allowed).toBe(false);
  });

  it("emits a cross-domain assumption ledger and enforces owner/expiration CI policy", async () => {
    const fileName = "src/trusted-boundary.ts";
    const source = `
      type BoundedUint8Array<N extends number> = Uint8Array
      /* uneffect: trust typed-array validated by the wire-format review */
      /* uneffect: trust_owner binary-platform */
      /* uneffect: trust_expires 2027-01-31 */
      function decode(output: BoundedUint8Array<1>, value: number) {
        output[0] = value
        console.log("decoded")
      }
      /* uneffect: temporal_ensures ready' = true */
      /* uneffect: temporal_modifies ready */
      /* uneffect: trust_owner runtime-team */
      /* uneffect: trust_expires 2026-12-31 */
      function start() {}
      /* uneffect: trust dispatch-sealing application owns the complete class graph */
      /* uneffect: trust_owner runtime-team */
      /* uneffect: trust_expires 2027-02-28 */
      export class Runtime { run() {} }
    `;
    const result = await verifyUneffectProject({
      files: { [fileName]: source },
      assumptionPolicy: {
        requireOwner: true,
        requireExpiration: true,
        allowUnboundedDomains: ["builtin"],
        asOf: "2026-08-21",
      },
    });
    expect(result.assumptions.schema).toBe("uneffect-assumptions/v1");
    expect(result.assumptions.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "typed-array", reason: "validated by the wire-format review", owner: "binary-platform", expiresOn: "2027-01-31", scope: expect.objectContaining({ fileName, functionName: "decode", span: expect.any(Object) }) }),
      expect.objectContaining({ domain: "builtin", reason: expect.stringContaining("reviewed builtin"), owner: "@mizchi/uneffect", scope: expect.objectContaining({ fileName, span: expect.any(Object) }) }),
      expect.objectContaining({ domain: "temporal-summary", owner: "runtime-team", expiresOn: "2026-12-31", scope: expect.objectContaining({ functionName: "start" }) }),
      expect.objectContaining({ domain: "dispatch-sealing", reason: "application owns the complete class graph", owner: "runtime-team", expiresOn: "2027-02-28", scope: expect.objectContaining({ fileName, span: expect.any(Object) }) }),
    ]));
    expect(result.assumptions.violations).toEqual([]);
    expect(result.assurance).toMatchObject({ passed: true, blockers: [] });

    const missingOwner = await verifyUneffectProject({
      files: { [fileName]: source.replace("/* uneffect: trust_owner binary-platform */", "") },
      assumptionPolicy: { requireOwner: true, asOf: "2026-08-21" },
    });
    expect(missingOwner.assumptions.violations).toContainEqual(expect.objectContaining({ rule: "owner-required", domain: "typed-array" }));
    expect(missingOwner.assurance).toMatchObject({ passed: false });
    expect(missingOwner.assurance.blockers).toContainEqual(expect.objectContaining({ domain: "assumption", fileName }));
    expect(missingOwner.diagnostics).toContainEqual(expect.objectContaining({ kind: "assumption-policy", rule: "owner-required" }));

    const missingDispatchOwner = await verifyUneffectProject({
      files: { [fileName]: source.replaceAll("/* uneffect: trust_owner runtime-team */", "") },
      assumptionPolicy: { requireOwner: true, asOf: "2026-08-21" },
    });
    expect(missingDispatchOwner.assumptions.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "owner-required", domain: "temporal-summary" }),
      expect.objectContaining({ rule: "owner-required", domain: "dispatch-sealing" }),
    ]));

    const expired = await verifyUneffectProject({
      files: { [fileName]: source },
      assumptionPolicy: { denyExpired: true, asOf: "2028-01-01" },
    });
    expect(expired.assumptions.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "expired", domain: "typed-array" }),
      expect.objectContaining({ rule: "expired", domain: "temporal-summary" }),
      expect.objectContaining({ rule: "expired", domain: "dispatch-sealing" }),
    ]));
  });

  it("attributes statement-scoped trust metadata to its exact ledger span", async () => {
    const fileName = "src/local-trust.ts";
    const source = `
      type BoundedUint8Array<N extends number> = Uint8Array
      function encode(output: BoundedUint8Array<2>, value: number) {
        /* uneffect: trust typed-array:u8-write reviewed packet tag */
        /* uneffect: trust_owner wire-team */
        /* uneffect: trust_expires 2027-04-01 */
        output[0] = value
        output[1] = value
      }
    `;
    const result = await verifyUneffectProject({
      files: { [fileName]: source },
      assumptionPolicy: { requireOwner: true, requireExpiration: true, asOf: "2026-08-21" },
    });
    expect(result.assumptions.entries).toEqual([
      expect.objectContaining({ domain: "typed-array", reason: "reviewed packet tag", owner: "wire-team", expiresOn: "2027-04-01" }),
    ]);
    const [assumption] = result.assumptions.entries;
    expect(source.slice(assumption!.scope.span.start, assumption!.scope.span.end)).toContain("output[0] = value");
    expect(result.assumptions.violations).toEqual([]);
    const [diagnostic] = result.typedArrays.diagnostics;
    expect(diagnostic).toEqual(expect.objectContaining({ kind: "u8-write", functionName: "encode" }));
    expect(source.slice(diagnostic!.span.start, diagnostic!.span.end)).toContain("output[1] = value");
  });
});
