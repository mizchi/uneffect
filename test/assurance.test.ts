import { describe, expect, it } from "vitest";
import { assessCheckAssurance, formatAssuranceAssessment } from "../src/assurance.js";

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
        "no emitted effect summary is unknown",
        "every emitted contract artifact is verified",
        "every emitted function effect summary is declaration-checked",
      ],
    });
    expect(assessment.exclusions).toContain("unannotated semantic domains are not checked by this profile");
    expect(assessment.coverage).toMatchObject({ effectSummaries: 1, contractArtifacts: 0 });
    expect(formatAssuranceAssessment(assessment)).toContain("excluded: unannotated semantic domains");
    expect(formatAssuranceAssessment(assessment)).toContain("coverage: 1 effect summary, 0 contract artifacts");
  });

  it("does not claim declaration coverage for no-unknown", () => {
    const assessment = assessCheckAssurance({
      summaries: [{ functionName: "identity", fileName: "src/identity.ts", effects: [], evidence: "inferred" }],
      artifacts: [],
    }, "no-unknown");
    expect(assessment.claims).not.toContain("every emitted function effect summary is declaration-checked");
    expect(assessment.exclusions).toContain("inferred effects need not have an explicit upper-bound declaration");
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
      coverage: { effectSummaries: 0, contractArtifacts: 0 },
      blockers: [{ kind: "coverage", classification: "unknown", message: expect.stringContaining("no effect summary or contract artifact") }],
    });
    expect(formatAssuranceAssessment(assessment)).toContain("claim (not established)");
    expect(formatAssuranceAssessment(assessment)).toContain("coverage: 0 effect summaries, 0 contract artifacts");
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
