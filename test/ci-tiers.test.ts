import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciTestTiers, resolveCiTestIncludes } from "../ci/test-tiers.js";

describe("CI test tier manifest", () => {
  it("assigns every TypeScript test file to exactly one tier", () => {
    const discovered = readdirSync(join(process.cwd(), "test"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`)
      .sort();
    const assigned = Object.values(ciTestTiers).flat().sort();
    const duplicates = assigned.filter((file, index) => assigned.indexOf(file) !== index);

    expect(duplicates).toEqual([]);
    expect(assigned).toEqual(discovered);
  });

  it("lets an explicitly selected generated test escape an inherited parent tier", () => {
    expect(resolveCiTestIncludes("z3", ["vitest", "run"])).toEqual(ciTestTiers.z3);
    expect(resolveCiTestIncludes("z3", ["vitest", "run", "/tmp/generated.uneffect.test.ts"])).toBeUndefined();
  });

  it("does not place direct verifier subprocesses in a tier lacking that verifier", () => {
    for (const [tier, files] of Object.entries(ciTestTiers)) for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      if (/spawnSync\(\s*["']z3["']/.test(source)) expect(["z3", "integration"], `${file} directly executes Z3`).toContain(tier);
      if (/spawnSync\(\s*["']pnpm["'][\s\S]*?["']quint["']/.test(source)) expect(["quint", "integration"], `${file} directly executes Quint`).toContain(tier);
    }
  });

  it("keeps solver-heavy test files serial to bound Z3 WASM memory", () => {
    const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('fileParallelism: requestedTier === "fast"');
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.check).toContain("tsx ci/run-test-tiers.ts");
    const runner = readFileSync(join(process.cwd(), "ci/run-test-tiers.ts"), "utf8");
    expect(runner).toContain('["fast", "z3", "quint", "integration"]');
    expect(runner).toContain('tier === "fast" ? [undefined] : ciTestTiers[tier]');
    const justfile = readFileSync(join(process.cwd(), "justfile"), "utf8");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts z3");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts quint");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts integration");
  });
});
