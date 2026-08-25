import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createEvidenceArtifact, validateOwnershipEvidence, verifyOwnershipObligationWithQuint, verifyOwnershipObligationWithZ3 } from "../src/evidence.js";
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
  it("attaches evidence to every summary and binds reproducibility inputs", () => {
    const { program, source } = programOf(`
      /* uneffect: effect Console */ function checked() { console.log("x") }
      function inferred() { console.log("x") }
      /* uneffect: effect Console */ function unknown() { fetch("https://example.com") }
    `);
    const result = analyzeEffectSummariesInProgram(program, source);
    const artifact = createEvidenceArtifact(program, source, result.summaries);
    expect(artifact.summaries.map((item) => item.evidence)).toEqual(["verified", "inferred", "unknown"]);
    expect(artifact).toMatchObject({ compilerRevision: expect.any(String), tsconfigHash: expect.stringMatching(/^[a-f0-9]{64}$/), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), builtinContractDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("allows stable-read reuse only with proof-grade evidence and no invalidation", () => {
    const base = { schema: "stable-read-reuse/v1" as const, region: "state.value", firstRead: 0, reuseAt: 2, evidence: "verified" as const };
    expect(evaluateStableReadReuse({ ...base, events: [{ kind: "read", region: "state.value" }, { kind: "read", region: "other" }, { kind: "read", region: "state.value" }] }).allowed).toBe(true);
    expect(evaluateStableReadReuse({ ...base, events: [{ kind: "read" }, { kind: "mutate", region: "state" }, { kind: "read" }] }).allowed).toBe(false);
    expect(evaluateStableReadReuse({ ...base, evidence: "unknown", events: [{ kind: "read" }, { kind: "read" }, { kind: "read" }] }).allowed).toBe(false);
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

    const missingOwner = await verifyUneffectProject({
      files: { [fileName]: source.replace("/* uneffect: trust_owner binary-platform */", "") },
      assumptionPolicy: { requireOwner: true, asOf: "2026-08-21" },
    });
    expect(missingOwner.assumptions.violations).toContainEqual(expect.objectContaining({ rule: "owner-required", domain: "typed-array" }));
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
