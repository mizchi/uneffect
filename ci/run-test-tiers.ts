import { spawnSync } from "node:child_process";
import { ciTestTiers, type CiTestTier } from "./test-tiers.js";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const allTiers = ["fast", "z3", "quint", "integration"] as const;
const requested = process.argv[2] as CiTestTier | undefined;
if (requested && !allTiers.includes(requested)) throw new Error(`unknown CI test tier: ${requested}`);
const tiers: readonly CiTestTier[] = requested ? [requested] : allTiers;

for (const tier of tiers) {
  const files: readonly (string | undefined)[] = tier === "fast" ? [undefined] : ciTestTiers[tier];
  for (const file of files) {
    const result = spawnSync(pnpm, ["vitest", "run", ...(file ? [file] : [])], {
      cwd: process.cwd(),
      env: { ...process.env, UNEFFECT_CI_TIER: tier },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
