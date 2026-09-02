import { describe, expect, it } from "vitest";
import { assessCheckAssurance, formatAssuranceAssessment } from "../src/assurance.js";
import { parseEffectExpression } from "../src/capabilities.js";

describe("assurance claim boundaries", () => {
  it("returns machine-readable claims and exclusions for a passing profile", () => {
    const assessment = assessCheckAssurance({
      summaries: [{ functionName: "load", fileName: "src/load.ts", effects: [], evidence: "verified" }],
      artifacts: [],
    }, "declared");

    expect(assessment).toMatchObject({
      status: "verified",
      passed: true,
      claims: [
        "selected TypeScript sources have no syntax, semantic, or compiler-option errors",
        "no emitted effect summary or capability scope is unknown",
        "every emitted contract artifact is verified",
        "every emitted function effect summary is declaration-checked",
      ],
    });
    expect(assessment.exclusions).toContain("unannotated semantic domains are not checked by this profile");
    expect(assessment.coverage).toMatchObject({ effectSummaries: 1, contractArtifacts: 0 });
    expect(formatAssuranceAssessment(assessment)).toContain("excluded: unannotated semantic domains");
    expect(formatAssuranceAssessment(assessment)).toContain("coverage: 1 effect summary, 0 contract artifacts, 0 typed-array obligations, 0 typed-array windows, 0 ownership diagnostics, 0 async-iterator obligations, 0 resource-protocol obligations, 0 assumptions");
  });

  it("does not claim declaration coverage for no-unknown", () => {
    const assessment = assessCheckAssurance({
      summaries: [{ functionName: "identity", fileName: "src/identity.ts", effects: [], evidence: "inferred" }],
      artifacts: [],
    }, "no-unknown");
    expect(assessment.claims).not.toContain("every emitted function effect summary is declaration-checked");
    expect(assessment.exclusions).toContain("inferred effects need not have an explicit upper-bound declaration");
  });

  it("rejects an unknown capability scope even when summary extraction succeeded", () => {
    const assessment = assessCheckAssurance({
      summaries: [{
        functionName: "generate", fileName: "src/client.ts", evidence: "inferred",
        effects: [parseEffectExpression("Fetch<POST, Unknown<dynamic-url>>")],
      }],
      artifacts: [],
    }, "no-unknown");

    expect(assessment).toMatchObject({
      status: "unknown", passed: false,
      claims: [],
      blockers: [{
        kind: "effect", classification: "unknown", functionName: "generate",
        message: expect.stringContaining("unknown capability scope"),
      }],
    });
  });

  it("reports trusted summaries as assumed rather than verified", () => {
    const noUnknown = assessCheckAssurance({
      summaries: [{ functionName: "<module>", fileName: "src/entry.ts", effects: [], evidence: "trusted" }],
      artifacts: [],
    }, "no-unknown");

    expect(noUnknown).toMatchObject({ status: "assumed", passed: true, blockers: [] });
    expect(noUnknown.exclusions).toContain(
      "trusted effect summaries depend on reviewed contracts and are assumptions, not verified implementations",
    );
    expect(formatAssuranceAssessment(noUnknown)).toContain("passed (assumed)");
    expect(assessCheckAssurance({
      summaries: [{ functionName: "<module>", fileName: "src/entry.ts", effects: [], evidence: "trusted" }],
      artifacts: [],
    }, "declared")).toMatchObject({ status: "unknown", passed: false });
  });

  it("requires an empty recorded assumption ledger for verified assurance", () => {
    const summary = { functionName: "report", fileName: "src/report.ts", effects: [], evidence: "verified" as const };
    const assumption = {
      id: "builtin-console", evidence: "trusted" as const, domain: "builtin" as const,
      reason: "reviewed Console contract", owner: "@mizchi/uneffect",
      scope: { fileName: "src/report.ts", functionName: "report", span: { start: 10, end: 20 } },
    };
    const assessment = assessCheckAssurance({
      summaries: [summary], artifacts: [],
      assumptions: { schema: "uneffect-assumptions/v1", entries: [assumption], violations: [] },
    }, "verified");

    expect(assessment).toMatchObject({
      profile: "verified", status: "unknown", passed: false, claims: [],
      coverage: { assumptions: 1 },
      blockers: [{
        kind: "assumption", classification: "unknown", fileName: "src/report.ts",
        message: expect.stringContaining("reviewed Console contract"),
      }],
    });
    expect(assessCheckAssurance({
      summaries: [summary], artifacts: [],
      assumptions: { schema: "uneffect-assumptions/v1", entries: [], violations: [] },
    }, "verified")).toMatchObject({
      status: "verified", passed: true,
      claims: expect.arrayContaining(["the emitted assumption ledger is empty"]),
      coverage: { assumptions: 0 },
    });
  });

  it("fails verified assurance when no assumption ledger was collected", () => {
    expect(assessCheckAssurance({
      summaries: [{ functionName: "pure", fileName: "src/pure.ts", effects: [], evidence: "verified" }],
      artifacts: [],
    }, "verified")).toMatchObject({
      status: "unknown", passed: false,
      blockers: [{ kind: "assumption", message: expect.stringContaining("was not collected") }],
    });
  });

  it("accepts a represented iterator-effect parameter without claiming a closed concrete effect set", () => {
    const summary = {
      functionName: "consume", fileName: "src/consume.ts", effects: [], evidence: "inferred" as const,
      iteratorEffectParameters: [{ index: 0, name: "iterator", convertsThrowToRejection: false }],
    };
    const noUnknown = assessCheckAssurance({ summaries: [summary], artifacts: [] }, "no-unknown");
    expect(noUnknown).toMatchObject({ passed: true, blockers: [] });
    expect(noUnknown.exclusions).toContain("unbounded iterator-effect parameters describe caller-supplied lazy effects and are not a closed concrete effect set");
    expect(assessCheckAssurance({ summaries: [summary], artifacts: [] }, "declared"))
      .toMatchObject({ passed: false, blockers: [expect.objectContaining({ kind: "effect" })] });
  });

  it("rejects an assurance result that emitted no evidence", () => {
    const assessment = assessCheckAssurance({ summaries: [], artifacts: [] }, "no-unknown");

    expect(assessment).toMatchObject({
      status: "unknown",
      passed: false,
      claims: [],
      coverage: { effectSummaries: 0, contractArtifacts: 0 },
      blockers: [{ kind: "coverage", classification: "unknown", message: expect.stringContaining("no effect summary or contract artifact") }],
    });
    expect(formatAssuranceAssessment(assessment)).not.toContain("claim:");
    expect(formatAssuranceAssessment(assessment)).toContain("coverage: 0 effect summaries, 0 contract artifacts, 0 typed-array obligations, 0 typed-array windows, 0 ownership diagnostics, 0 async-iterator obligations, 0 resource-protocol obligations, 0 assumptions");
  });

  it("rejects an effect error even when a stale summary is not unknown", () => {
    const assessment = assessCheckAssurance({
      summaries: [{ functionName: "caller", fileName: "src/caller.ts", effects: [], evidence: "inferred" }],
      artifacts: [],
      diagnostics: [{ fileName: "src/caller.ts", functionName: "caller", effect: "Console", kind: "missing", severity: "error", line: 1, message: "iterator effect bound exceeded" }],
    }, "no-unknown");
    expect(assessment).toMatchObject({ status: "violated", passed: false, blockers: [expect.objectContaining({ kind: "effect", classification: "violation", functionName: "caller" })] });
  });

  it("does not let evidence from one file hide an uncovered selected file", () => {
    const assessment = assessCheckAssurance({
      sources: new Map([["src/covered.ts", ""], ["src/types-only.ts", ""]]),
      summaries: [{ functionName: "covered", fileName: "src/covered.ts", effects: [], evidence: "verified" }],
      artifacts: [],
    }, "declared");

    expect(assessment).toMatchObject({
      passed: false,
      coverage: { checkedFiles: 2, uncoveredFiles: ["src/types-only.ts"] },
      blockers: [{ kind: "coverage", fileName: "src/types-only.ts", message: expect.stringContaining("no proof-relevant evidence") }],
    });
  });
});
