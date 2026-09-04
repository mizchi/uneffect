import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { externalCheckerTestTimeoutMs } from "../ci/test-timeouts.js";
import { ciIsolatedTestTimeoutMs } from "../ci/test-tiers.js";

describe("external checker test timeout policy", () => {
  it("keeps local and CI limits finite while allowing shared-runner headroom", () => {
    expect(externalCheckerTestTimeoutMs({ ci: false })).toBe(20_000);
    expect(externalCheckerTestTimeoutMs({ ci: true })).toBe(ciIsolatedTestTimeoutMs);
  });

  it("keeps the observed checker dogfood on the named policy", () => {
    const dogfood = readFileSync("test/dogfood.test.ts", "utf8");
    expect(dogfood).toMatch(/it\("classifies every unknown summary while analyzing its own implementation",[\s\S]*?\}, Math\.max\(120_000, externalCheckerTestTimeoutMs\(\)\)\);/u);
    for (const title of [
      "separates CLI help formatting from version manifest access",
      "separates CLI dispatch stream callbacks from dispatcher body effects",
    ]) {
      expect(dogfood).toMatch(new RegExp(`it\\("${title}",[\\s\\S]*?\\}, Math\\.max\\(120_000, externalCheckerTestTimeoutMs\\(\\)\\)\\);`, "u"));
    }
  });
});
