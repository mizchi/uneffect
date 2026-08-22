import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const tier of ["fast", "z3", "quint", "integration"] as const) {
  const result = spawnSync(pnpm, ["vitest", "run"], {
    cwd: process.cwd(),
    env: { ...process.env, UNEFFECT_CI_TIER: tier },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
