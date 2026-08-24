import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciIsolatedTestFiles, ciIsolatedTestNames, ciIsolatedTestTimeoutMs, ciTestTiers, didVitestRunExactlyOneTest, parseVitestListNames, resolveCiTestIncludes, shouldRetryIsolatedSolverFailure } from "../ci/test-tiers.js";

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
      if (/spawnSync\(\s*["']pnpm["'][\s\S]*?["']quint["']/.test(source)) expect(["quint", "integration"], `${file} directly executes Quint`).toContain(tier);
    }
  });

  it("keeps Z3 a WASM dependency by never executing a native z3 binary", () => {
    const executesZ3 = Object.values(ciTestTiers).flat()
      .filter((file) => /spawnSync\(\s*["']z3["']/.test(readFileSync(join(process.cwd(), file), "utf8")));
    expect(executesZ3, "use createZ3Context from src/z3.ts; the toolchain ships the z3-solver WASM build").toEqual([]);
    const sources = readdirSync(join(process.cwd(), "src")).filter((name) => name.endsWith(".ts"));
    const nativeZ3 = sources.filter((name) => /spawnSync\(\s*["']z3["']/.test(readFileSync(join(process.cwd(), "src", name), "utf8")));
    expect(nativeZ3, "the published toolchain must not require a native Z3 installation").toEqual([]);
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).not.toContain("install --yes z3");
  });

  it("keeps solver-heavy test files serial to bound Z3 WASM memory", () => {
    const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('fileParallelism: requestedTier === "fast"');
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.check).toContain("tsx ci/run-test-tiers.ts");
    const runner = readFileSync(join(process.cwd(), "ci/run-test-tiers.ts"), "utf8");
    expect(runner).toContain('["fast", "z3", "quint", "integration"]');
    expect(runner).toContain('tier === "fast" ? [undefined] : ciTestTiers[tier]');
    expect(runner).toContain("ciIsolatedTestNames[file]");
    expect(runner).toContain("const maxSolverAttempts = 3");
    const justfile = readFileSync(join(process.cwd(), "justfile"), "utf8");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts z3");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts quint");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts integration");
  });

  it("retries transport failures while preserving checksum-pinned CI tool downloads", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("curl --fail --location --retry 3 --retry-all-errors --retry-delay 2");
    expect(workflow).toContain('echo "$JUST_SHA256  $archive" | sha256sum --check');
    expect(workflow).toContain('echo "$QUINT_EVALUATOR_SHA256  $archive" | sha256sum --check');
  });

  it("keeps per-test process isolation selectors synchronized with their files", () => {
    for (const [file, selected] of Object.entries(ciIsolatedTestNames)) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const declared = [...source.matchAll(/^  it\("([^"]+)"/gm)].map((match) => match[1]);
      expect(selected, file).toEqual(declared);
    }
  });

  it("discovers named tests for whole-file process isolation", () => {
    expect(ciIsolatedTestFiles).toContain("test/dogfood.test.ts");
    expect(ciIsolatedTestTimeoutMs).toBe(60_000);
    expect(parseVitestListNames("test/dogfood.test.ts", [
      "test/dogfood.test.ts > Uneffect dogfood > first proof",
      "test/dogfood.test.ts > Uneffect dogfood > nested > second proof",
      "test/other.test.ts > Other > ignored",
      "",
    ].join("\n"))).toEqual([
      "first proof",
      "second proof",
    ]);
    expect(() => parseVitestListNames("test/dogfood.test.ts", [
      "test/dogfood.test.ts > First suite > duplicate",
      "test/dogfood.test.ts > Second suite > duplicate",
    ].join("\n"))).toThrow(/duplicate isolated test title/);
    expect(didVitestRunExactlyOneTest("Tests  1 passed | 45 skipped (46)")).toBe(true);
    expect(didVitestRunExactlyOneTest("\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m1 passed\u001b[39m\u001b[22m \u001b[2m| \u001b[22m\u001b[33m45 skipped\u001b[39m")).toBe(true);
    expect(didVitestRunExactlyOneTest("Tests  46 skipped (46)")).toBe(false);
    expect(didVitestRunExactlyOneTest("Tests  2 passed | 44 skipped (46)")).toBe(false);
  });

  it("retries only known transient Z3 WASM process failures", () => {
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: memory access out of bounds\nat z3-built.wasm.smt::context")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: table index is out of bounds\nat z3-built.wasm.smt2::parser::parse_psort_name")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: Aborted(Cannot enlarge memory arrays to size 2912395264 bytes (OOM)\nat z3-built.wasm.rewriter_tpl")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: Aborted(Runtime error: The application has corrupted its heap memory area (address zero)!)\nat z3-solver/build/z3-built.js:848:11")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("ASSERTION VIOLATION\nFile: ../src/ast/for_each_expr.h\nUNEXPECTED CODE WAS REACHED.\nZ3 4.16.0.0")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/node-lease.test.ts > Node Lease clock-skew model > uses a proven lease-domain invariant to exclude invalid epoch actions\nTest timed out in 60000ms")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/node-lease.test.ts > Node Lease clock-skew model > synthesizes a lease-domain invariant to exclude invalid epoch actions\nTest timed out in 60000ms")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("AssertionError: expected counterexample")).toBe(false);
    expect(shouldRetryIsolatedSolverFailure("Test timed out in 30000ms")).toBe(false);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/other.test.ts\nTest timed out in 60000ms")).toBe(false);
  });
});
