import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCiDogfoodBudget, ciDogfoodBudgetMs, ciDogfoodPartitionCount, ciDogfoodPartitionStarts, ciDogfoodPartitionTimeoutMs, ciDogfoodProcessTimeoutMs, ciExternalVerifierTestFiles, ciIntegrationShards, ciIsolatedProcessTimeoutMs, ciIsolatedTestFiles, ciIsolatedTestNames, ciIsolatedTestTimeoutMs, ciMeasuredNativeProjectTimeoutMs, ciTestTiers, classifyIsolatedSolverFailure, classifyIsolatedVerifierFailure, didVitestRunExpectedTestCount, didVitestRunExactlyOneTest, isIsolatedSolverHardTimeout, parseCiTestIsolation, parseVitestListNames, partitionVitestTestNames, resolveCiProcessTimeoutMs, resolveCiTestIncludes, resolveCiTierFiles, shouldIsolateTestCases, shouldRetryIsolatedSolverFailure } from "../ci/test-tiers.js";
import { appendCiTimingEvent, classifyCiTimingFailure, measureCiTimingPhase, measureCiTimingPhaseAsync, readCiTimingEvents } from "../ci/timing-report.js";
import { classifySolverRetryAttempts, createSolverRetryEvidenceSession } from "../ci/solver-retry-evidence.js";
import { boundedRepetitions } from "../ci/run-solver-stress.js";
import { runBoundedVerifierAttempts } from "../ci/verifier-retry.js";
import { spawnSyncWithDeadline } from "../ci/process-deadline.js";

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

  it("partitions every integration file into one named shard", () => {
    const partitioned = Object.values(ciIntegrationShards).flat().sort();
    expect(partitioned).toEqual([...ciTestTiers.integration].sort());
    expect(partitioned.filter((file, index) => partitioned.indexOf(file) !== index)).toEqual([]);
    expect(resolveCiTierFiles("integration", undefined, "core")).toEqual(ciIntegrationShards.core);
    expect(resolveCiTierFiles("integration", undefined, "applications")).toEqual(ciIntegrationShards.applications);
    expect(resolveCiTierFiles("integration", undefined, "dogfood")).toEqual(ciIntegrationShards.dogfood);
    expect(() => resolveCiTierFiles("z3", undefined, "core")).toThrow(/only valid for integration/);
    expect(() => resolveCiTierFiles("integration", "test/dogfood.test.ts", "dogfood")).toThrow(/cannot be combined/);
    expect(() => resolveCiTierFiles("integration", undefined, "missing")).toThrow(/unknown integration shard/);
  });

  it("retains versioned CI timing events for completed and failed executions", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-ci-timing-"));
    const report = join(directory, "integration-core.jsonl");
    try {
      appendCiTimingEvent(report, {
        event: "start", tier: "integration", shard: "core", file: "test/evidence-optimizer.test.ts",
        testName: null, attempt: 1, timestamp: "2026-08-29T00:00:00.000Z",
      });
      appendCiTimingEvent(report, {
        event: "complete", tier: "integration", shard: "core", file: "test/evidence-optimizer.test.ts",
        testName: null, attempt: 1, timestamp: "2026-08-29T00:00:31.000Z", durationMs: 31_000,
        status: 1, signal: null, failureKind: "semantic-or-test-timeout",
      });
      expect(readCiTimingEvents(report)).toEqual([
        expect.objectContaining({ schema: "uneffect.ci-timing/v2", event: "start", attempt: 1, process: expect.objectContaining({ rssBytes: expect.any(Number) }) }),
        expect.objectContaining({ schema: "uneffect.ci-timing/v2", event: "complete", durationMs: 31_000, status: 1, process: expect.objectContaining({ maxRssBytes: expect.any(Number) }) }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records attributed CI phases with before/after resource snapshots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-ci-phases-"));
    const report = join(directory, "integration-dogfood.jsonl");
    const context = {
      tier: "integration", shard: "dogfood", file: "test/dogfood.test.ts",
      testName: "self dogfood", attempt: 1,
    } as const;
    try {
      expect(measureCiTimingPhase(report, { ...context, phase: "project-compiler-construction" }, () => 42)).toBe(42);
      await expect(measureCiTimingPhaseAsync(report, { ...context, phase: "semantic-query" }, async () => "ok"))
        .resolves.toBe("ok");
      expect(readCiTimingEvents(report)).toEqual([
        expect.objectContaining({ schema: "uneffect.ci-timing/v2", event: "phase-start", phase: "project-compiler-construction" }),
        expect.objectContaining({ schema: "uneffect.ci-timing/v2", event: "phase-complete", phase: "project-compiler-construction", status: 0, durationMs: expect.any(Number) }),
        expect.objectContaining({ schema: "uneffect.ci-timing/v2", event: "phase-start", phase: "semantic-query" }),
        expect.objectContaining({ schema: "uneffect.ci-timing/v2", event: "phase-complete", phase: "semantic-query", status: 0, durationMs: expect.any(Number) }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("partitions native dogfood while retaining 20 percent overall deadline headroom", () => {
    expect(ciDogfoodProcessTimeoutMs).toBe(10 * 60_000);
    expect(ciDogfoodPartitionCount).toBe(5);
    expect(ciDogfoodPartitionStarts).toHaveLength(ciDogfoodPartitionCount);
    expect(ciDogfoodPartitionTimeoutMs).toBe(5 * 60_000);
    expect(ciDogfoodBudgetMs).toBe(ciDogfoodProcessTimeoutMs * 0.8);
    expect(resolveCiProcessTimeoutMs("test/dogfood.test.ts", undefined, "file")).toBe(ciDogfoodProcessTimeoutMs);
    expect(resolveCiProcessTimeoutMs("test/dogfood.test.ts", "one case", "test")).toBe(ciIsolatedProcessTimeoutMs);
    expect(resolveCiProcessTimeoutMs("test/effects.test.ts", undefined, "file")).toBeUndefined();
    expect(() => assertCiDogfoodBudget(ciDogfoodBudgetMs)).not.toThrow();
    expect(() => assertCiDogfoodBudget(ciDogfoodBudgetMs + 1)).toThrow(/dogfood CI budget exceeded/);
    expect(partitionVitestTestNames(["a", "b", "c", "d", "e"], ["a", "c", "e"])).toEqual([
      ["a", "b"], ["c", "d"], ["e"],
    ]);
    expect(() => partitionVitestTestNames([], ["a"])).toThrow(/at least one test/);
    expect(() => partitionVitestTestNames(["a"], [])).toThrow(/first listed test/);
    expect(() => partitionVitestTestNames(["a", "b"], ["a", "missing"])).toThrow(/not a listed test/);
    expect(() => partitionVitestTestNames(["a", "b"], ["a", "b", "a"])).toThrow(/source ordered/);
    expect(didVitestRunExpectedTestCount("Tests  44 passed | 86 skipped (130)", 44)).toBe(true);
    expect(didVitestRunExpectedTestCount("Tests  43 passed | 87 skipped (130)", 44)).toBe(false);

    const dogfoodSource = readFileSync(join(process.cwd(), "test/dogfood.test.ts"), "utf8");
    const dogfoodNames = [...dogfoodSource.matchAll(/^  it\("([^"]+)"/gm)].map((match) => match[1]!);
    const dogfoodPartitions = partitionVitestTestNames(dogfoodNames, ciDogfoodPartitionStarts);
    expect(dogfoodPartitions.flat()).toEqual(dogfoodNames);
    expect(dogfoodPartitions.map(({ length }) => length)).toEqual([66, 12, 8, 13, 31]);
    expect(dogfoodSource).toContain("let sourceTreeEffectAnalysis");
    expect(dogfoodSource).toContain("function analyzeSourceTreeEffects");
    expect(dogfoodSource.match(/const result = analyzeSourceTreeEffects\(\);/g)).toHaveLength(13);

    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toMatch(/integration:[\s\S]*?UNEFFECT_TEST_ISOLATION: file/);
  });

  it("separates verifier runtime timing failures from semantic test failures", () => {
    expect(classifyCiTimingFailure(0, undefined, undefined)).toBeUndefined();
    expect(classifyCiTimingFailure(1, undefined, "external-process-timeout")).toBe("verifier-process-timeout");
    expect(classifyCiTimingFailure(1, undefined, "recognized-wasm-failure")).toBe("verifier-runtime-failure");
    expect(classifyCiTimingFailure(null, "ETIMEDOUT", "hard-timeout")).toBe("runtime-hard-timeout");
    expect(classifyCiTimingFailure(1, undefined, undefined)).toBe("semantic-or-test-failure");
  });

  it("calibrates the measured native project test above observed remote variance", () => {
    expect(ciMeasuredNativeProjectTimeoutMs).toBe(45_000);
    const source = readFileSync(join(process.cwd(), "test/evidence-optimizer.test.ts"), "utf8");
    const timeoutFor = (title: string) => source.split(`it("${title}"`, 2)[1]?.split("\n  it(", 1)[0];
    expect(timeoutFor("verifies solution projects as independent compiler domains and aggregates provenance fail closed"))
      .toContain("}, ciMeasuredNativeProjectTimeoutMs);");
    expect(timeoutFor("substitutes verified child-project Mutate regions through exact parameter and export identities"))
      .toContain("}, ciMeasuredNativeProjectTimeoutMs);");
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
    expect(workflow).toContain("matrix.integration-shard");
    expect(workflow).toContain("UNEFFECT_CI_SHARD");
    expect(workflow).toContain(".uneffect/ci-timing");
  });

  it("keeps solver-heavy test files serial to bound Z3 WASM memory", () => {
    const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain('fileParallelism: requestedTier === "fast"');
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.check).toContain("tsx ci/run-test-tiers.ts");
    const runner = readFileSync(join(process.cwd(), "ci/run-test-tiers.ts"), "utf8");
    expect(runner).toContain('["fast", "z3", "quint", "integration"]');
    expect(runner).toContain("resolveCiTierFiles(tier, requestedFile, requestedShard)");
    expect(runner).toContain("ciIsolatedTestNames[file]");
    expect(runner).toContain("const maxVerifierAttempts = 3");
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

  it("uploads retained verifier retry evidence even when a later attempt passes", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain(".uneffect/verifier-retry-evidence");
    expect(workflow).toContain("if-no-files-found: ignore");
    expect(workflow.match(/include-hidden-files: true/gu)).toHaveLength(6);
  });

  it("uploads retained external-verifier retry evidence from every verifier tier", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow.match(/path: \.uneffect\/verifier-retry-evidence/gu)).toHaveLength(3);
    expect(workflow.match(/name: verifier-retry-evidence-/gu)).toHaveLength(3);
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
    expect(ciIsolatedTestFiles).toContain("test/contract-dsl.test.ts");
    expect(ciIsolatedTestFiles).toContain("test/contracts.test.ts");
    expect(ciTestTiers.quint.every((file) => ciExternalVerifierTestFiles.includes(file))).toBe(true);
    expect(ciExternalVerifierTestFiles).toContain("test/temporal-map-default.test.ts");
    expect(ciTestTiers.quint.some((file) => ciIsolatedTestFiles.includes(file))).toBe(false);
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

  it("keeps per-test isolation for CI but permits a native local release gate to use file isolation", () => {
    expect(parseCiTestIsolation(undefined)).toBe("test");
    expect(parseCiTestIsolation("test")).toBe("test");
    expect(parseCiTestIsolation("file")).toBe("file");
    expect(() => parseCiTestIsolation("none")).toThrow(/test or file/);
    expect(shouldIsolateTestCases("test/contracts.test.ts", "test")).toBe(true);
    expect(shouldIsolateTestCases("test/contracts.test.ts", "file")).toBe(false);
    expect(shouldIsolateTestCases("test/effects.test.ts", "test")).toBe(false);
  });

  it("retries only process-level external verifier timeouts", () => {
    const timedOut = [
      "AssertionError: expected Error: spawnSync pnpm ETIMEDOUT to be undefined",
      "command: pnpm exec quint run /tmp/model.qnt",
    ].join("\n");
    expect(classifyIsolatedVerifierFailure("quint", timedOut)).toBe("external-process-timeout");
    expect(classifyIsolatedVerifierFailure("integration", timedOut)).toBe("external-process-timeout");
    expect(classifyIsolatedVerifierFailure("z3", timedOut)).toBeUndefined();
    expect(classifyIsolatedVerifierFailure("quint", "Invariant violated\nstatus: 1")).toBeUndefined();
    expect(classifyIsolatedVerifierFailure("quint", "QuintError: parse error at model.qnt:1:1")).toBeUndefined();
    expect(classifyIsolatedVerifierFailure("quint", "Test timed out in 30000ms")).toBeUndefined();
  });

  it("runs a deterministic bounded verifier retry loop without retrying semantic failures", () => {
    const transientRuns: number[] = [];
    const recovered = runBoundedVerifierAttempts(
      3,
      (attempt) => ({ status: attempt === 1 ? 1 : 0, timeout: attempt === 1 }),
      ({ timeout }) => timeout ? "external-process-timeout" as const : undefined,
      ({ attempt }) => transientRuns.push(attempt),
    );
    expect(recovered).toMatchObject({ result: { status: 0 }, attemptCount: 2 });
    expect(transientRuns).toEqual([1, 2]);

    const semanticRuns: number[] = [];
    const semanticFailure = runBoundedVerifierAttempts(
      3,
      (attempt) => ({ status: 1, verdict: "invariant-violated", attempt }),
      () => undefined,
      ({ attempt }) => semanticRuns.push(attempt),
    );
    expect(semanticFailure).toMatchObject({ result: { verdict: "invariant-violated" }, attemptCount: 1 });
    expect(semanticRuns).toEqual([1]);

    const exhausted = runBoundedVerifierAttempts(2, () => ({ status: 1 }), () => "external-process-timeout" as const);
    expect(exhausted).toMatchObject({ attemptCount: 2, exhausted: true });
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
    expect(runner).toContain("spawnSyncWithDeadline(pnpm, args, processTimeoutMs");
    expect(runner).toContain("resolveCiProcessTimeoutMs(file, testName, isolation)");
    expect(runner).toContain("isIsolatedSolverHardTimeout(captured.error)");
  });

  it("kills a deliberately hung child within the configured parent deadline", () => {
    const startedAt = Date.now();
    const result = spawnSyncWithDeadline(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], 100);
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
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

      const external = createSolverRetryEvidenceSession(root, "quint", "test/formal-models.test.ts", "model", 2, ["pnpm", "vitest", "run", "test/formal-models.test.ts"]);
      external.environmentForAttempt(1);
      external.recordAttempt({
        attempt: 1, status: 1, signal: null, hardTimeout: false,
        retryReason: "external-process-timeout", failureKind: "external-process-timeout",
        stdout: "", stderr: "Error: spawnSync pnpm ETIMEDOUT\ncommand: pnpm exec quint run model.qnt",
      });
      external.environmentForAttempt(2);
      external.recordAttempt({ attempt: 2, status: 0, signal: null, hardTimeout: false, stdout: "No violation found", stderr: "" });
      const externalManifestPath = external.finish();
      if (!externalManifestPath) throw new Error("external verifier retry evidence was discarded");
      const externalManifest = JSON.parse(readFileSync(externalManifestPath, "utf8")) as {
        schema: string; command: string[]; attempts: Array<{ stdoutPath?: string; stderrPath?: string }>;
        assessment: { classification: string; finalOutcome: string };
      };
      expect(externalManifest.schema).toBe("uneffect.verifier-retry-evidence/v1");
      expect(externalManifest.command).toEqual(["pnpm", "vitest", "run", "test/formal-models.test.ts"]);
      expect(externalManifest.assessment).toMatchObject({
        classification: "transient-external-process-failure", finalOutcome: "passed-after-retry",
      });
      expect(readFileSync(join(external.directory, externalManifest.attempts[0]!.stderrPath!), "utf8")).toContain("ETIMEDOUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
