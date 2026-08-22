import { spawnSync } from "node:child_process";
import { ciIsolatedTestNames, ciTestTiers, shouldRetryIsolatedSolverFailure, type CiTestTier } from "./test-tiers.js";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const allTiers = ["fast", "z3", "quint", "integration"] as const;
const requested = process.argv[2] as CiTestTier | undefined;
if (requested && !allTiers.includes(requested)) throw new Error(`unknown CI test tier: ${requested}`);
const tiers: readonly CiTestTier[] = requested ? [requested] : allTiers;
for (const tier of tiers) {
  const files: readonly (string | undefined)[] = tier === "fast" ? [undefined] : ciTestTiers[tier];
  for (const file of files) {
    const testNames: readonly (string | undefined)[] = file && ciIsolatedTestNames[file] ? ciIsolatedTestNames[file] : [undefined];
    for (const testName of testNames) {
      const args = ["vitest", "run", ...(file ? [file] : []), ...(testName ? ["-t", testName] : [])];
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
        result = runIsolated();
        emit(result);
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        if (result.status !== 0 && shouldRetryIsolatedSolverFailure(output)) {
          process.stderr.write(`retrying isolated test after transient Z3 WASM crash: ${file} -t ${testName}\n`);
          result = runIsolated();
          emit(result);
        }
      } else {
        result = spawnSync(pnpm, args, {
          cwd: process.cwd(), env: { ...process.env, UNEFFECT_CI_TIER: tier }, stdio: "inherit",
        });
      }
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
