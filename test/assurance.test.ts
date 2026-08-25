import { describe, expect, it } from "vitest";
import { assessCheckAssurance, formatAssuranceAssessment } from "../src/assurance.js";

describe("assurance claim boundaries", () => {
  it("returns machine-readable claims and exclusions for a passing profile", () => {
    const assessment = assessCheckAssurance({
      summaries: [{ functionName: "load", fileName: "src/load.ts", effects: [], evidence: "verified" }],
      artifacts: [],
    }, "declared");

    expect(assessment).toMatchObject({
      passed: true,
      claims: [
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

  it("rejects an assurance result that emitted no evidence", () => {
    const assessment = assessCheckAssurance({ summaries: [], artifacts: [] }, "no-unknown");

    expect(assessment).toMatchObject({
      passed: false,
      coverage: { effectSummaries: 0, contractArtifacts: 0 },
      blockers: [{ kind: "coverage", message: expect.stringContaining("no effect summary or contract artifact") }],
    });
    expect(formatAssuranceAssessment(assessment)).toContain("claim (not established)");
    expect(formatAssuranceAssessment(assessment)).toContain("coverage: 0 effect summaries, 0 contract artifacts");
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
