import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuint } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";
import { parseQuintItfCounterexample, replayModelCounterexample, type ModelState } from "../src/model-replay.js";

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
  const model = generateQuint("node_lease", parseSpec("node-lease.ts", leaseModel(skewGrace)).temporal);
  const tracePattern = join(directory, "trace_{seq}.itf.json"), tracePath = join(directory, "trace_0.itf.json");
  writeFileSync(path, model);
  const execution = spawnSync("pnpm", ["exec", "quint", "run", path,
    "--invariant=singleWriter", "--max-steps=15", "--max-samples=1000",
    "--seed=0x6c65617365", "--verbosity=1", "--mbt", `--out-itf=${tracePattern}`], { encoding: "utf8", timeout: 30_000 });
  const trace = execution.status === 0 ? undefined : readFileSync(tracePath, "utf8");
  rmSync(directory, { recursive: true, force: true });
  return { execution, trace, modelHash: createHash("sha256").update(model).digest("hex") };
}

describe("Node Lease clock-skew model", () => {
  it("reproduces the early-takeover double-writer counterexample", () => {
    const { execution: result } = checkLeaseModel(0);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/violation|counterexample/i);
  });

  it("keeps the bounded two-node model safe when takeover waits for the skew bound", () => {
    const { execution: result } = checkLeaseModel(1);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("No violation found");
  });

  it("normalizes the Quint counterexample and replays it against a TypeScript lease runtime", async () => {
    const result = checkLeaseModel(0);
    expect(result.trace).toBeTypeOf("string");
    const trace = parseQuintItfCounterexample(result.trace!, result.modelHash);
    const replay = await replayModelCounterexample(trace, {
      schema: "uneffect-refinement-adapter/v1", name: "node-lease", version: "1",
      create: (state) => structuredClone(state), observe: (runtime) => structuredClone(runtime),
      actions: {
        tick_realNow: (runtime) => { runtime.realNow = Number(runtime.realNow) + 1; },
        takeoverB: (runtime) => { runtime.ownerIsA = false; runtime.ownerEpoch = Number(runtime.ownerEpoch) + 1; },
        publishB: (runtime) => { runtime.residentEpochB = runtime.ownerEpoch; },
      },
      invariants: {
        singleWriter: (runtime: ModelState) => !(Number(runtime.residentEpochA) > 0 && Number(runtime.realNow) < Number(runtime.localDeadlineA) && Number(runtime.residentEpochB) > 0),
      },
    });
    expect(replay.status).toBe("replayed");
    expect(replay.violations.at(-1)).toEqual({ invariant: "singleWriter", step: trace.steps.length });
  });
});
