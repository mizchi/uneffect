import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciIsolatedTestNames, ciTestTiers, resolveCiTestIncludes, shouldRetryIsolatedSolverFailure } from "../ci/test-tiers.js";

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
    expect(runner).toContain("ciIsolatedTestNames[file]");
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

  it("retries only known transient Z3 WASM process failures", () => {
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: memory access out of bounds\nat z3-built.wasm.smt::context")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: table index is out of bounds\nat z3-built.wasm.smt2::parser::parse_psort_name")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: Aborted(Cannot enlarge memory arrays to size 2912395264 bytes (OOM)\nat z3-built.wasm.rewriter_tpl")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("RuntimeError: Aborted(Runtime error: The application has corrupted its heap memory area (address zero)!)\nat z3-solver/build/z3-built.js:848:11")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("ASSERTION VIOLATION\nFile: ../src/ast/for_each_expr.h\nUNEXPECTED CODE WAS REACHED.\nZ3 4.16.0.0")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/node-lease.test.ts > Node Lease clock-skew model > uses a proven lease-domain invariant to exclude invalid epoch actions\nTest timed out in 60000ms")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("AssertionError: expected counterexample")).toBe(false);
    expect(shouldRetryIsolatedSolverFailure("Test timed out in 30000ms")).toBe(false);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/other.test.ts\nTest timed out in 60000ms")).toBe(false);
  });
});
