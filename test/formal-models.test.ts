import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const commonArgs = [
  "exec",
  "quint",
  "run",
  "--invariant=cacheIsSound",
  "--max-steps=10",
  "--max-samples=100",
  "--seed=0x123456789abcdef",
  "--verbosity=1",
];

function runModel(path: string) {
  return spawnSync("pnpm", [...commonArgs.slice(0, 3), path, ...commonArgs.slice(3)], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("async invalidation Quint model", () => {
  test("preserves cache soundness when suspension invalidates facts", () => {
    const result = runModel("specs/invalidate.qnt");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("No violation found");
  });

  test("the invariant detects the deliberately stale-cache model", () => {
    const result = runModel("specs/invalidate-broken.qnt");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Invariant violated");
  });
});
