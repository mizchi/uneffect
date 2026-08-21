import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createEvidenceArtifact, validateOwnershipEvidence, verifyOwnershipObligationWithQuint, verifyOwnershipObligationWithZ3 } from "../src/evidence.js";
import type { OwnershipGuardObligation } from "../src/async-safety.js";
import { analyzeEffectSummariesInProgram } from "../src/effects.js";
import { applyOwnershipAssertionElision, applyStableReadReuse, evaluateOwnershipGuardElision, evaluatePropertyMangle, evaluateStableReadReuse } from "../src/optimizer.js";

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

  it("binds ownership proof evidence to the obligation, verifier program, and Z3 version", () => {
    const obligation: OwnershipGuardObligation = { owner: "run", callee: "consume", ownership: "promise", parameter: 1, assumptions: ["enabled && active"], goal: "enabled && active", status: "verified", evidence: "finite-propositional", span: { start: 10, end: 20 } };
    const artifact = verifyOwnershipObligationWithZ3(obligation);
    expect(artifact).toMatchObject({ schema: "ownership-evidence/v1", backend: "z3", result: "verified", evidence: "verified", exitCode: 0 });
    expect(artifact.backendVersion).toMatch(/^Z3 version/);
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
});
