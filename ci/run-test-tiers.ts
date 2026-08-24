import { spawnSync } from "node:child_process";
import { ciIsolatedTestFiles, ciIsolatedTestNames, ciTestTiers, didVitestRunExactlyOneTest, parseVitestListNames, shouldRetryIsolatedSolverFailure, type CiTestTier } from "./test-tiers.js";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const allTiers = ["fast", "z3", "quint", "integration"] as const;
const maxSolverAttempts = 3;
const requested = process.argv[2] as CiTestTier | undefined;
if (requested && !allTiers.includes(requested)) throw new Error(`unknown CI test tier: ${requested}`);
const tiers: readonly CiTestTier[] = requested ? [requested] : allTiers;
for (const tier of tiers) {
  const files: readonly (string | undefined)[] = tier === "fast" ? [undefined] : ciTestTiers[tier];
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
      const args = ["vitest", "run", ...(file ? [file] : []), ...(testPattern ? ["-t", testPattern] : [])];
      const runIsolated = () => spawnSync(pnpm, args, {
        cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier },
        encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
      });
      const emit = (captured: ReturnType<typeof runIsolated>) => {
        if (captured.stdout) process.stdout.write(captured.stdout);
        if (captured.stderr) process.stderr.write(captured.stderr);
      };
      let result;
      if (testName) {
        let attempt = 1;
        for (;;) {
          result = runIsolated();
          emit(result);
          const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
          if (result.status === 0 || attempt >= maxSolverAttempts || !shouldRetryIsolatedSolverFailure(output)) break;
          attempt++;
          process.stderr.write(`retrying isolated test after a recognized transient solver-process failure (attempt ${attempt}/${maxSolverAttempts}): ${file} -t ${testName}\n`);
        }
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
