import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciIsolatedProcessTimeoutMs, ciIsolatedTestFiles, ciIsolatedTestNames, ciIsolatedTestTimeoutMs, ciTestTiers, classifyIsolatedSolverFailure, didVitestRunExactlyOneTest, isIsolatedSolverHardTimeout, parseVitestListNames, resolveCiTestIncludes, resolveCiTierFiles, shouldRetryIsolatedSolverFailure } from "../ci/test-tiers.js";
import { classifySolverRetryAttempts, createSolverRetryEvidenceSession } from "../ci/solver-retry-evidence.js";
import { boundedRepetitions } from "../ci/run-solver-stress.js";

describe("CI test tier manifest", () => {
  it("supports an explicit remote verification run when a push event is absent", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*$/m);
    expect(workflow).toContain('group: ${{ github.workflow }}-${{ github.ref }}-${{ github.sha }}');
  });

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

  it("runs one requested tier member through the same isolated runner", () => {
    expect(resolveCiTierFiles("integration", "test/dogfood.test.ts")).toEqual(["test/dogfood.test.ts"]);
    expect(resolveCiTierFiles("fast")).toEqual([undefined]);
    expect(() => resolveCiTierFiles("z3", "test/dogfood.test.ts")).toThrow(/not assigned to z3/);
  });

  it("does not place direct verifier subprocesses in a tier lacking that verifier", () => {
    for (const [tier, files] of Object.entries(ciTestTiers)) for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      if (/spawnSync\(\s*["']pnpm["'][\s\S]*?["']quint["']/.test(source)) expect(["quint", "integration"], `${file} directly executes Quint`).toContain(tier);
    }
  });

  it("keeps native Z3 optional, tests WASM explicitly, and reserves native Z3 for solver-heavy integration", () => {
    const backend = readFileSync(join(process.cwd(), "src/z3.ts"), "utf8");
    expect(backend).toContain('process.env.UNEFFECT_Z3_BACKEND');
    expect(backend).toContain('process.env.UNEFFECT_Z3_PATH');
    expect(backend).toContain('wasmDriver');
    expect(backend).toContain('attempt(drivers.wasm)');
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("UNEFFECT_Z3_BACKEND: wasm");
    expect(workflow).toContain("Install native Z3 for solver-heavy integration proofs");
    expect(workflow).toContain("apt-get install --yes z3");
  });

  it("keeps solver-heavy test files serial to bound Z3 WASM memory", () => {
    const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('fileParallelism: requestedTier === "fast"');
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.check).toContain("tsx ci/run-test-tiers.ts");
    const runner = readFileSync(join(process.cwd(), "ci/run-test-tiers.ts"), "utf8");
    expect(runner).toContain('["fast", "z3", "quint", "integration"]');
    expect(runner).toContain("resolveCiTierFiles(tier, requestedFile)");
    expect(runner).toContain("ciIsolatedTestNames[file]");
    expect(runner).toContain("const maxSolverAttempts = 3");
    const justfile = readFileSync(join(process.cwd(), "justfile"), "utf8");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts z3");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts quint");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts integration");
    expect(justfile).toContain("tsx ci/run-test-tiers.ts integration test/dogfood.test.ts");
  });

  it("retries transport failures while preserving checksum-pinned CI tool downloads", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("curl --fail --location --retry 3 --retry-all-errors --retry-delay 2");
    expect(workflow).toContain('echo "$JUST_SHA256  $archive" | sha256sum --check');
    expect(workflow).toContain('echo "$QUINT_EVALUATOR_SHA256  $archive" | sha256sum --check');
  });

  it("uploads retained solver retry evidence even when a later attempt passes", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain(".uneffect/solver-retry-evidence");
    expect(workflow).toContain("if-no-files-found: ignore");
    expect(workflow.match(/include-hidden-files: true/gu)).toHaveLength(2);
  });

  it("repeats the telemetry accounting proof in fresh WASM processes", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    const justfile = readFileSync(join(process.cwd(), "justfile"), "utf8");
    const runner = readFileSync(join(process.cwd(), "ci/run-solver-stress.ts"), "utf8");
    expect(justfile).toContain("tsx ci/run-solver-stress.ts");
    expect(workflow).toContain("just formal-z3-stress");
    expect(workflow).toContain(".uneffect/solver-stress-evidence");
    expect(runner).toContain('const repetitions = boundedRepetitions(process.env.UNEFFECT_SOLVER_STRESS_REPETITIONS);');
    expect(runner).toContain('UNEFFECT_Z3_BACKEND: "wasm"');
    expect(runner).toContain("programDigests");
    expect(runner).toContain("solverExecutions > 64");
    expect(boundedRepetitions(undefined)).toBe(3);
    expect(boundedRepetitions("2")).toBe(2);
    expect(() => boundedRepetitions("1")).toThrow(/2 through 10/);
    expect(() => boundedRepetitions("many")).toThrow(/safe integer/);
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
    expect(shouldRetryIsolatedSolverFailure("ASSERTION VIOLATION\nFile: ../src/ast/ast.cpp\nLine: 383\nUNEXPECTED CODE WAS REACHED.\nZ3 4.16.0.0")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("ASSERTION VIOLATION\nFile: application.cpp\nUNEXPECTED CODE WAS REACHED.\nZ3 4.16.0.0")).toBe(false);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/node-lease.test.ts > Node Lease clock-skew model > uses a proven lease-domain invariant to exclude invalid epoch actions\nTest timed out in 60000ms")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/node-lease.test.ts > Node Lease clock-skew model > synthesizes a lease-domain invariant to exclude invalid epoch actions\nTest timed out in 60000ms")).toBe(true);
    expect(shouldRetryIsolatedSolverFailure("AssertionError: expected counterexample")).toBe(false);
    expect(shouldRetryIsolatedSolverFailure("Test timed out in 30000ms")).toBe(false);
    expect(shouldRetryIsolatedSolverFailure("FAIL test/other.test.ts\nTest timed out in 60000ms")).toBe(false);
    expect(classifyIsolatedSolverFailure("Aborted(Cannot enlarge memory arrays to size 2148876288 bytes (OOM))\nat z3-built.wasm")).toBe("wasm-oom");
    expect(classifyIsolatedSolverFailure("RuntimeError: memory access out of bounds\nat z3-built.wasm")).toBe("wasm-memory-fault");
    expect(classifyIsolatedSolverFailure("Runtime error: The application has corrupted its heap memory area (address zero)!\nat z3-solver/build/z3-built.js")).toBe("wasm-heap-corruption");
    expect(classifyIsolatedSolverFailure("ASSERTION VIOLATION\nFile: ../src/ast/ast.cpp\nUNEXPECTED CODE WAS REACHED.\nZ3 4.16.0.0")).toBe("z3-internal-assertion");
    expect(classifyIsolatedSolverFailure("AssertionError: expected counterexample")).toBeUndefined();
  });

  it("classifies only comparable repeated solver attempts", () => {
    const attempt = (attemptNumber: number, status: number, failureKind: "wasm-oom" | "hard-timeout" | "z3-internal-assertion" | undefined, programDigest = "sha256:model") => ({
      attempt: attemptNumber, status, signal: null, hardTimeout: failureKind === "hard-timeout",
      failureKind, programDigest, timestamp: "2026-08-27T00:00:00.000Z",
      process: { pid: attemptNumber, rssBytes: 1, heapUsedBytes: 1, externalBytes: 1 },
    });
    expect(classifySolverRetryAttempts([
      attempt(1, 1, "wasm-oom"), attempt(2, 0, undefined),
    ], 3)).toMatchObject({ classification: "transient-runtime-failure", programDigest: "sha256:model", finalOutcome: "passed-after-retry" });
    expect(classifySolverRetryAttempts([
      attempt(1, 1, "wasm-oom"), attempt(2, 1, "wasm-oom"), attempt(3, 1, "wasm-oom"),
    ], 3)).toMatchObject({ classification: "deterministic-resource-limit", finalOutcome: "failed" });
    expect(classifySolverRetryAttempts([
      attempt(1, 1, "z3-internal-assertion"), attempt(2, 1, "z3-internal-assertion"), attempt(3, 1, "z3-internal-assertion"),
    ], 3)).toMatchObject({ classification: "reproducible-runtime-failure", finalOutcome: "failed" });
    expect(classifySolverRetryAttempts([
      attempt(1, 1, "hard-timeout"), attempt(2, 1, "hard-timeout", "sha256:different"), attempt(3, 1, "hard-timeout"),
    ], 3)).toMatchObject({ classification: "inconclusive", reason: "attempts did not fail on one recorded SMT-LIB digest" });
    expect(classifySolverRetryAttempts([
      { ...attempt(1, 1, "wasm-oom"), programDigest: undefined }, attempt(2, 0, undefined),
    ], 3)).toMatchObject({ classification: "inconclusive", reason: "a failed attempt has no recorded SMT-LIB digest" });
  });

  it("hard-stops an isolated solver process when synchronous WASM blocks Vitest's timer", () => {
    expect(ciIsolatedProcessTimeoutMs).toBeGreaterThan(ciIsolatedTestTimeoutMs);
    expect(ciIsolatedProcessTimeoutMs).toBeLessThanOrEqual(ciIsolatedTestTimeoutMs + 30_000);
    expect(isIsolatedSolverHardTimeout({ code: "ETIMEDOUT" })).toBe(true);
    expect(isIsolatedSolverHardTimeout({ code: "ENOMEM" })).toBe(false);
    expect(isIsolatedSolverHardTimeout(undefined)).toBe(false);
    const runner = readFileSync(join(process.cwd(), "ci/run-test-tiers.ts"), "utf8");
    expect(runner).toContain("timeout: ciIsolatedProcessTimeoutMs");
    expect(runner).toContain("isIsolatedSolverHardTimeout(result.error)");
  });

  it("retains retry attempts and removes evidence for a clean first attempt", () => {
      const root = mkdtempSync(join(tmpdir(), "uneffect-ci-evidence-"));
    try {
      const retried = createSolverRetryEvidenceSession(root, "z3", "test/z3-backend.test.ts", "fallback telemetry");
      const firstDirectory = retried.environmentForAttempt(1).UNEFFECT_SOLVER_EVIDENCE_DIR!;
      expect(firstDirectory).toContain("attempt-1");
      writeFileSync(join(firstDirectory, "execution-1.jsonl"), [
        JSON.stringify({ event: "start", timestamp: "2026-08-27T00:00:00.000Z", programDigest: "sha256:model" }),
        JSON.stringify({ event: "complete", timestamp: "2026-08-27T00:00:01.000Z", status: "error" }),
        "{truncated-after-process-crash",
      ].join("\n"));
      retried.recordAttempt({ attempt: 1, status: 1, signal: null, hardTimeout: false, retryReason: "recognized-wasm-failure", failureKind: "wasm-oom" });
      const secondDirectory = retried.environmentForAttempt(2).UNEFFECT_SOLVER_EVIDENCE_DIR!;
      expect(secondDirectory).toContain("attempt-2");
      writeFileSync(join(secondDirectory, "execution-2.jsonl"), [
        JSON.stringify({ event: "start", timestamp: "2026-08-27T00:00:02.000Z", programDigest: "sha256:model" }),
        JSON.stringify({ event: "complete", timestamp: "2026-08-27T00:00:03.000Z", status: "unsat" }),
      ].join("\n"));
      retried.recordAttempt({ attempt: 2, status: 0, signal: null, hardTimeout: false });
      const manifestPath = retried.finish();
      if (!manifestPath) throw new Error("retried solver session did not retain evidence");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { attempts: unknown[]; source: string; testName: string; assessment: unknown };
      expect(manifest).toMatchObject({ source: "test/z3-backend.test.ts", testName: "fallback telemetry" });
      expect(manifest.attempts).toEqual([
        expect.objectContaining({ attempt: 1, status: 1, retryReason: "recognized-wasm-failure", process: expect.objectContaining({ rssBytes: expect.any(Number) }) }),
        expect.objectContaining({ attempt: 2, status: 0, process: expect.objectContaining({ rssBytes: expect.any(Number) }) }),
      ]);
      expect(manifest.assessment).toMatchObject({ classification: "transient-runtime-failure", programDigest: "sha256:model", finalOutcome: "passed-after-retry" });

      const clean = createSolverRetryEvidenceSession(root, "z3", "test/z3-backend.test.ts", "clean");
      clean.environmentForAttempt(1);
      clean.recordAttempt({ attempt: 1, status: 0, signal: null, hardTimeout: false });
      expect(clean.finish()).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
