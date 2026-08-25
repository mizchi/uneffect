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
    expect(formatAssuranceAssessment(assessment)).toContain("excluded: unannotated semantic domains");
  });

  it("does not claim declaration coverage for no-unknown", () => {
    const assessment = assessCheckAssurance({ summaries: [], artifacts: [] }, "no-unknown");
    expect(assessment.claims).not.toContain("every emitted function effect summary is declaration-checked");
    expect(assessment.exclusions).toContain("inferred effects need not have an explicit upper-bound declaration");
  });
});
