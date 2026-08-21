import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuint } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";

function leaseModel(skewGrace: number): string {
  return `
    /*
     * uneffect:
     * clock realNow: 1
     * state leaseExpiryA: int
     * state localDeadlineA: int
     * state ownerEpoch: int
     * state residentEpochA: int
     * state residentEpochB: int
     * state ownerIsA: bool
     * init leaseExpiryA = 10
     * init localDeadlineA = 10
     * init ownerEpoch = 1
     * init residentEpochA = 1
     * init residentEpochB = 0
     * init ownerIsA = true
     * action takeoverB: ownerIsA' = false, ownerEpoch' = ownerEpoch + 1
     * action_when takeoverB: ownerIsA && realNow + 1 >= leaseExpiryA + ${skewGrace}
     * action publishB: residentEpochB' = ownerEpoch
     * action_when publishB: !ownerIsA && residentEpochB !== ownerEpoch
     * temporal singleWriter: !(residentEpochA > 0 && realNow < localDeadlineA && residentEpochB > 0)
     */
  `;
}

function checkLeaseModel(skewGrace: number) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-node-lease-"));
  const path = join(directory, "lease.qnt");
  writeFileSync(path, generateQuint("node_lease", parseSpec("node-lease.ts", leaseModel(skewGrace)).temporal));
  return spawnSync("pnpm", ["exec", "quint", "run", path,
    "--invariant=singleWriter", "--max-steps=15", "--max-samples=1000",
    "--seed=0x6c65617365", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
}

describe("Node Lease clock-skew model", () => {
  it("reproduces the early-takeover double-writer counterexample", () => {
    const result = checkLeaseModel(0);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/violation|counterexample/i);
  });

  it("keeps the bounded two-node model safe when takeover waits for the skew bound", () => {
    const result = checkLeaseModel(1);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("No violation found");
  });
});
