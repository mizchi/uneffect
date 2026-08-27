import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createSolverRetryEvidenceSession } from "./solver-retry-evidence.js";
import { ciExternalVerifierTestFiles, ciIsolatedProcessTimeoutMs, ciIsolatedTestFiles, ciIsolatedTestNames, ciIsolatedTestTimeoutMs, classifyIsolatedSolverFailure, classifyIsolatedVerifierFailure, didVitestRunExactlyOneTest, isIsolatedSolverHardTimeout, parseVitestListNames, resolveCiTierFiles, type CiTestTier } from "./test-tiers.js";
import { runBoundedVerifierAttempts } from "./verifier-retry.js";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const allTiers = ["fast", "z3", "quint", "integration"] as const;
const maxVerifierAttempts = 3;
const requested = process.argv[2] as CiTestTier | undefined;
const requestedFile = process.argv[3];
if (requested && !allTiers.includes(requested)) throw new Error(`unknown CI test tier: ${requested}`);
if (requestedFile && !requested) throw new Error("a requested test file requires an explicit CI tier");
const tiers: readonly CiTestTier[] = requested ? [requested] : allTiers;
for (const tier of tiers) {
  const files = resolveCiTierFiles(tier, requestedFile);
  for (const file of files) {
    let testNames: readonly (string | undefined)[] = file && ciIsolatedTestNames[file] ? ciIsolatedTestNames[file] : [undefined];
    if (file && ciIsolatedTestFiles.includes(file)) {
      const listed = spawnSync(pnpm, ["vitest", "list", file], {
        cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier }, encoding: "utf8",
      });
      if (listed.error) throw listed.error;
      if (listed.status !== 0) {
        if (listed.stdout) process.stdout.write(listed.stdout);
        if (listed.stderr) process.stderr.write(listed.stderr);
        process.exit(listed.status ?? 1);
      }
      testNames = parseVitestListNames(file, listed.stdout);
      if (testNames.length === 0) throw new Error(`no tests discovered for isolated file: ${file}`);
    }
    for (const testName of testNames) {
      const testPattern = testName && file && ciIsolatedTestFiles.includes(file)
        ? testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : testName;
      const args = [
        "vitest", "run", ...(file ? [file] : []), ...(testPattern ? ["-t", testPattern] : []),
        ...(file && ciIsolatedTestFiles.includes(file) ? ["--testTimeout", String(ciIsolatedTestTimeoutMs)] : []),
      ];
      const runIsolated = (attemptEnvironment: NodeJS.ProcessEnv = {}) => spawnSync(pnpm, args, {
        cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier, ...attemptEnvironment },
        encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
        ...(testName ? { timeout: ciIsolatedProcessTimeoutMs, killSignal: "SIGKILL" as const } : {}),
      });
      const emit = (captured: ReturnType<typeof runIsolated>) => {
        if (captured.stdout) process.stdout.write(captured.stdout);
        if (captured.stderr) process.stderr.write(captured.stderr);
      };
      let result;
      if (testName || (file && ciExternalVerifierTestFiles.includes(file))) {
        const evidence = createSolverRetryEvidenceSession(
          resolve(process.env.UNEFFECT_VERIFIER_RETRY_EVIDENCE_ROOT ?? process.env.UNEFFECT_SOLVER_RETRY_EVIDENCE_ROOT ?? ".uneffect/verifier-retry-evidence"),
          tier,
          file!,
          testName ?? "<file>",
          maxVerifierAttempts,
          [pnpm, ...args],
        );
        const execution = runBoundedVerifierAttempts(maxVerifierAttempts, (attempt) => {
          const startedAt = Date.now();
          const captured = runIsolated(evidence.environmentForAttempt(attempt));
          const output = `${captured.stdout ?? ""}\n${captured.stderr ?? ""}`;
          const hardTimeout = isIsolatedSolverHardTimeout(captured.error);
          const externalVerifierFailure = classifyIsolatedVerifierFailure(tier, output);
          const classifiedFailure = classifyIsolatedSolverFailure(output);
          const retryReason = hardTimeout ? "hard-timeout" as const
            : externalVerifierFailure ? "external-process-timeout" as const
            : classifiedFailure ? "recognized-wasm-failure" as const : undefined;
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
        const evidenceManifest = evidence.finish();
        if (evidenceManifest) process.stderr.write(`retained verifier retry evidence: ${evidenceManifest}\n`);
      } else {
        result = spawnSync(pnpm, args, {
          cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier }, stdio: "inherit",
        });
      }
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
      if (testName && file && ciIsolatedTestFiles.includes(file) && !didVitestRunExactlyOneTest(result.stdout ?? "")) {
        throw new Error(`isolated selector did not execute exactly one test: ${file} -t ${testName}`);
      }
    }
  }
}
