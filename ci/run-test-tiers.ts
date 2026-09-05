import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createSolverRetryEvidenceSession } from "./solver-retry-evidence.js";
import { assertCiDogfoodBudget, ciDogfoodPartitionStarts, ciDogfoodPartitionTimeoutMs, ciDogfoodProcessTimeoutMs, ciExternalVerifierTestFiles, ciIsolatedTestNames, ciIsolatedTestTimeoutMs, classifyIsolatedSolverFailure, classifyIsolatedVerifierFailure, didVitestRunExpectedTestCount, didVitestRunExactlyOneTest, isIsolatedSolverHardTimeout, parseCiTestIsolation, parseVitestListNames, partitionVitestTestNames, resolveCiProcessTimeoutMs, resolveCiTierFiles, shouldIsolateTestCases, type CiTestTier } from "./test-tiers.js";
import { appendCiTimingEvent, classifyCiTimingFailure, type CiTimingRetryReason } from "./timing-report.js";
import { runBoundedVerifierAttempts } from "./verifier-retry.js";
import { spawnSyncWithDeadline } from "./process-deadline.js";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const allTiers = ["fast", "z3", "quint", "integration"] as const;
const maxVerifierAttempts = 3;
const requested = process.argv[2] as CiTestTier | undefined;
const requestedFile = process.argv[3];
const requestedShard = process.env.UNEFFECT_CI_SHARD;
const timingPath = process.env.UNEFFECT_CI_TIMING_PATH;
const isolation = parseCiTestIsolation(process.env.UNEFFECT_TEST_ISOLATION);
interface TestSelection {
  readonly name?: string;
  readonly pattern?: string;
  readonly expectedCount?: number;
  readonly timeoutMs?: number;
}

function escapeTestPattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (requested && !allTiers.includes(requested)) throw new Error(`unknown CI test tier: ${requested}`);
if (requestedFile && !requested) throw new Error("a requested test file requires an explicit CI tier");
const tiers: readonly CiTestTier[] = requested ? [requested] : allTiers;
for (const tier of tiers) {
  const files = resolveCiTierFiles(tier, requestedFile, requestedShard);
  for (const file of files) {
    const isolateTestCases = file ? shouldIsolateTestCases(file, isolation) : false;
    const partitionDogfood = file === "test/dogfood.test.ts" && isolation === "file";
    const dogfoodStartedAt = partitionDogfood ? Date.now() : undefined;
    let selections: readonly TestSelection[] = file && ciIsolatedTestNames[file]
      ? ciIsolatedTestNames[file].map((name) => ({ name }))
      : [{}];
    if (file && (isolateTestCases || partitionDogfood)) {
      const listed = spawnSync(pnpm, ["vitest", "list", file], {
        cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier }, encoding: "utf8",
      });
      if (listed.error) throw listed.error;
      if (listed.status !== 0) {
        if (listed.stdout) process.stdout.write(listed.stdout);
        if (listed.stderr) process.stderr.write(listed.stderr);
        process.exit(listed.status ?? 1);
      }
      const listedNames = parseVitestListNames(file, listed.stdout);
      if (partitionDogfood) {
        selections = partitionVitestTestNames(listedNames, ciDogfoodPartitionStarts).map((names, index, groups) => ({
          name: `partition-${index + 1}-of-${groups.length}`,
          pattern: `(?:${names.map(escapeTestPattern).join("|")})$`,
          expectedCount: names.length,
          timeoutMs: ciDogfoodPartitionTimeoutMs,
        }));
      } else {
        selections = listedNames.map((name) => ({ name, pattern: escapeTestPattern(name), expectedCount: 1 }));
      }
    }
    let dogfoodDurationMs = 0;
    for (const selection of selections) {
      const testName = selection.name;
      const testPattern = selection.pattern ?? testName;
      const args = [
        "vitest", "run", ...(file ? [file] : []), ...(testPattern ? ["-t", testPattern] : []),
        ...(file && isolateTestCases ? ["--testTimeout", String(ciIsolatedTestTimeoutMs)] : []),
      ];
      const configuredTimeoutMs = selection.timeoutMs ?? resolveCiProcessTimeoutMs(file, testName, isolation);
      const remainingDogfoodMs = dogfoodStartedAt === undefined
        ? undefined
        : ciDogfoodProcessTimeoutMs - (Date.now() - dogfoodStartedAt);
      if (remainingDogfoodMs !== undefined && remainingDogfoodMs <= 0) {
        throw new Error(`dogfood CI hard deadline exceeded before ${testName}`);
      }
      const processTimeoutMs = configuredTimeoutMs === undefined ? remainingDogfoodMs
        : remainingDogfoodMs === undefined ? configuredTimeoutMs
        : Math.min(configuredTimeoutMs, remainingDogfoodMs);
      const runIsolated = (attemptEnvironment: NodeJS.ProcessEnv = {}) => processTimeoutMs !== undefined
        ? spawnSyncWithDeadline(pnpm, args, processTimeoutMs, {
          cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier, ...attemptEnvironment },
          maxBuffer: 20 * 1024 * 1024,
        })
        : spawnSync(pnpm, args, {
        cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier, ...attemptEnvironment },
        encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
      });
      const startTiming = (attempt: number) => {
        const startedAt = Date.now();
        if (timingPath && file) appendCiTimingEvent(timingPath, {
          event: "start", tier, shard: requestedShard ?? null, file, testName: testName ?? null,
          attempt, timestamp: new Date(startedAt).toISOString(),
        });
        return startedAt;
      };
      const completeTiming = (
        attempt: number,
        startedAt: number,
        captured: ReturnType<typeof runIsolated>,
        retryReason?: CiTimingRetryReason,
      ) => {
        const failureKind = classifyCiTimingFailure(captured.status, captured.error?.code, retryReason);
        if (timingPath && file) appendCiTimingEvent(timingPath, {
          event: "complete", tier, shard: requestedShard ?? null, file, testName: testName ?? null,
          attempt, timestamp: new Date().toISOString(), durationMs: Date.now() - startedAt,
          status: captured.status, signal: captured.signal,
          ...(failureKind ? { failureKind } : {}),
        });
      };
      const emit = (captured: ReturnType<typeof runIsolated>) => {
        if (captured.stdout) process.stdout.write(captured.stdout);
        if (captured.stderr) process.stderr.write(captured.stderr);
      };
      let result;
      let completedDurationMs: number | undefined;
      if (!partitionDogfood && (testName || (file && ciExternalVerifierTestFiles.includes(file)))) {
        const verifierMaxAttempts = maxVerifierAttempts;
        const evidence = createSolverRetryEvidenceSession(
          resolve(process.env.UNEFFECT_VERIFIER_RETRY_EVIDENCE_ROOT ?? process.env.UNEFFECT_SOLVER_RETRY_EVIDENCE_ROOT ?? ".uneffect/verifier-retry-evidence"),
          tier,
          file!,
          testName ?? "<file>",
          verifierMaxAttempts,
          [pnpm, ...args],
        );
        const execution = runBoundedVerifierAttempts(verifierMaxAttempts, (attempt) => {
          const startedAt = startTiming(attempt);
          const captured = runIsolated(evidence.environmentForAttempt(attempt));
          const output = `${captured.stdout ?? ""}\n${captured.stderr ?? ""}`;
          const hardTimeout = isIsolatedSolverHardTimeout(captured.error);
          const externalVerifierFailure = classifyIsolatedVerifierFailure(tier, output);
          const classifiedFailure = classifyIsolatedSolverFailure(output);
          const retryReason = hardTimeout ? "hard-timeout" as const
            : externalVerifierFailure ? "external-process-timeout" as const
            : classifiedFailure ? "recognized-wasm-failure" as const : undefined;
          completeTiming(attempt, startedAt, captured, retryReason);
          return {
            captured,
            durationMs: Date.now() - startedAt,
            hardTimeout,
            externalVerifierFailure,
            classifiedFailure,
            retryReason,
          };
        }, ({ captured, retryReason }) => captured.status === 0 ? undefined : retryReason, ({ attempt, result: attempted, retryReason, willRetry }) => {
          emit(attempted.captured);
          evidence.recordAttempt({
            attempt,
            status: attempted.captured.status,
            signal: attempted.captured.signal,
            hardTimeout: attempted.hardTimeout,
            retryReason,
            failureKind: attempted.hardTimeout ? "hard-timeout" : attempted.externalVerifierFailure ?? attempted.classifiedFailure,
            durationMs: attempted.durationMs,
            stdout: attempted.captured.stdout ?? "",
            stderr: attempted.captured.stderr ?? "",
          });
          if (willRetry) process.stderr.write(`retrying isolated test after a recognized transient verifier-process ${retryReason} (attempt ${attempt + 1}/${maxVerifierAttempts}): ${file}${testName ? ` -t ${testName}` : ""}\n`);
        });
        result = execution.result.captured;
        completedDurationMs = execution.result.durationMs;
        const evidenceManifest = evidence.finish();
        if (evidenceManifest) process.stderr.write(`retained verifier retry evidence: ${evidenceManifest}\n`);
      } else {
        const startedAt = startTiming(1);
        result = processTimeoutMs === undefined
          ? spawnSync(pnpm, args, {
            cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier }, stdio: "inherit",
          })
          : runIsolated();
        if (processTimeoutMs !== undefined) emit(result);
        completedDurationMs = Date.now() - startedAt;
        completeTiming(1, startedAt, result);
      }
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
      if (partitionDogfood) {
        dogfoodDurationMs += completedDurationMs ?? Number.POSITIVE_INFINITY;
      }
      if (testName && file && isolateTestCases && !didVitestRunExactlyOneTest(result.stdout ?? "")) {
        throw new Error(`isolated selector did not execute exactly one test: ${file} -t ${testName}`);
      }
      if (selection.expectedCount !== undefined
        && !didVitestRunExpectedTestCount(result.stdout ?? "", selection.expectedCount)) {
        throw new Error(`selector executed the wrong number of tests: ${file} ${testName}; expected ${selection.expectedCount}`);
      }
    }
    if (partitionDogfood) assertCiDogfoodBudget(dogfoodDurationMs);
  }
}
