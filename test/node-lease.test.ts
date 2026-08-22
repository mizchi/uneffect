import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuint } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";
import { parseQuintItfCounterexample, replayModelCounterexample, type ModelState } from "../src/model-replay.js";
import { findTemporalCounterexampleWithZ3, lintTemporalReachabilityWithZ3 } from "../src/spec-lint.js";

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

function collectionLeaseModel(skewGrace: number): string {
  return `/* uneffect:
    clock realNow: 1
    state nodes: Set<int>
    state activeWriters: Set<int>
    state residentEpochs: Map<int, int>
    state lease: { owner: int, epoch: int }
    init nodes = Set(1, 2)
    init activeWriters = Set(1)
    init residentEpochs = Map([[1, 1], [2, 0]])
    init lease = { owner: 1, epoch: 1 }
    action takeover: lease' = { ...lease, owner: 2, epoch: lease.epoch + 1 }
    action_when takeover: lease.owner === 1 && realNow + 1 >= 10 + ${skewGrace}
    action publish: activeWriters' = activeWriters.union(Set(2)), residentEpochs' = residentEpochs.put(2, 2)
    action_when publish: lease.owner === 2 && !activeWriters.contains(2)
    temporal writersAreNodes: activeWriters.forall(node => nodes.contains(node))
    temporal epochsAreNonNegative: residentEpochs.values().forall(epoch => epoch >= 0)
    temporal singleWriter: !(activeWriters.contains(1) && realNow < 10 && activeWriters.contains(2))
  */`;
}

function runCollectionLease(skewGrace: number) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-node-lease-set-"));
  const path = join(directory, "lease-set.qnt");
  const model = generateQuint("node_lease_set", parseSpec("node-lease-set.ts", collectionLeaseModel(skewGrace)).temporal);
  writeFileSync(path, model);
  const execution = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=singleWriter", "--max-steps=15", "--max-samples=1000", "--seed=0x7365746c65617365"], { encoding: "utf8", timeout: 30_000 });
  rmSync(directory, { recursive: true, force: true });
  return { model, execution };
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

function leaseLifecycleModel(fencedCommit: boolean): string {
  return `/* uneffect:
    clock realNow: 1
    state leaseExpiry: int
    state ownerEpoch: int
    state workerAlive: bool
    state renewalInFlight: bool
    state renewalEpoch: int
    state selfFenced: bool
    state resourceHeld: bool
    state writeInFlight: bool
    state writeEpoch: int
    state badCommit: bool
    init leaseExpiry = 2
    init ownerEpoch = 1
    init workerAlive = true
    init renewalInFlight = false
    init renewalEpoch = 0
    init selfFenced = false
    init resourceHeld = true
    init writeInFlight = false
    init writeEpoch = 0
    init badCommit = false
    action startRenewal: renewalInFlight' = true, renewalEpoch' = ownerEpoch
    action_when startRenewal: workerAlive && !selfFenced && !renewalInFlight
    action completeRenewal: renewalInFlight' = false, leaseExpiry' = realNow + 2
    action_when completeRenewal: renewalInFlight && workerAlive && !selfFenced && renewalEpoch === ownerEpoch
    action renewalCasFailure: renewalInFlight' = false, selfFenced' = true
    action_when renewalCasFailure: renewalInFlight
    action startWrite: writeInFlight' = true, writeEpoch' = ownerEpoch
    action_when startWrite: workerAlive && !selfFenced && !writeInFlight
    action takeover: ownerEpoch' = ownerEpoch + 1
    action_when takeover: realNow >= leaseExpiry
    action normalizeInvalidEpoch: ownerEpoch' = 0
    action_when normalizeInvalidEpoch: ownerEpoch < 0
    action observeZeroEpoch: badCommit' = true
    action_when observeZeroEpoch: ownerEpoch === 0
    action completeWrite: writeInFlight' = false, badCommit' = writeEpoch !== ownerEpoch
    action_when completeWrite: writeInFlight${fencedCommit ? " && writeEpoch === ownerEpoch" : ""}
    action crash: workerAlive' = false
    action_when crash: workerAlive
    action gc: resourceHeld' = false
    action_when gc: !workerAlive && resourceHeld
    temporal noStaleCommit: !badCommit
    temporal ownerEpochPositive: ownerEpoch > 0
    temporal casFailureFences: !selfFenced || !renewalInFlight
    temporal gcDoesNotInventResources: resourceHeld || !workerAlive
  */`;
}

function runLeaseLifecycle(fencedCommit: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-node-lease-lifecycle-"));
  const path = join(directory, "lifecycle.qnt");
  writeFileSync(path, generateQuint("node_lease_lifecycle", parseSpec("lifecycle.ts", leaseLifecycleModel(fencedCommit)).temporal));
  const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=noStaleCommit", "--max-steps=20", "--max-samples=5000", "--seed=0x6c6966656379636c"], { encoding: "utf8", timeout: 30_000 });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe("Node Lease clock-skew model", () => {
  it("uses a proven lease-domain invariant to exclude invalid epoch actions", async () => {
    const temporal = parseSpec("lease-strengthening.ts", leaseLifecycleModel(true)).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 3,
      strengtheningProperties: ["ownerEpochPositive"],
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeZeroEpoch",
      relatedName: "ownerEpochPositive",
    }));
  });

  it("extracts the collection-valued Node Lease violation with Z3 finite observation", async () => {
    const broken = await findTemporalCounterexampleWithZ3(parseSpec("node-lease-collections-z3.ts", collectionLeaseModel(0)).temporal, "singleWriter", { maxSteps: 12 });
    expect(broken.status).toBe("counterexample");
    if (broken.status === "counterexample") {
      expect(broken.trace.steps.map((step) => step.action)).toEqual([
        ...Array.from({ length: 9 }, () => "tick_realNow"), "takeover", "publish",
      ]);
      expect(broken.trace.steps.at(-1)?.after).toMatchObject({
        activeWriters: [1, 2], nodes: [1, 2], residentEpochs: [[1, 1], [2, 2]], lease: { owner: 2, epoch: 2 },
      });
    }
    await expect(findTemporalCounterexampleWithZ3(parseSpec("node-lease-collections-z3-safe.ts", collectionLeaseModel(1)).temporal, "singleWriter", { maxSteps: 12 }))
      .resolves.toEqual({ status: "safe-within-bound", depth: 12 });
  });

  it("fences delayed writes across renewal, CAS failure, crash, GC, and takeover lifecycle", () => {
    const broken = runLeaseLifecycle(false);
    expect(broken.status).not.toBe(0);
    expect(broken.stdout + broken.stderr).toMatch(/violation|counterexample/i);
    const safe = runLeaseLifecycle(true);
    expect(safe.status, safe.stdout + safe.stderr).toBe(0);
  });

  it("uses finite Set and Map state without per-node writer or epoch fields", () => {
    const broken = runCollectionLease(0);
    expect(broken.model).toContain("var activeWriters: Set[int]");
    expect(broken.model).toContain("var residentEpochs: int -> int");
    expect(broken.model).toContain("activeWriters.forall(node => nodes.contains(node))");
    expect(broken.execution.status).not.toBe(0);
    expect(broken.execution.stdout + broken.execution.stderr).toMatch(/violation|counterexample/i);

    const safe = runCollectionLease(1);
    expect(safe.execution.status, safe.execution.stdout + safe.execution.stderr).toBe(0);
  });
  it("extracts and replays the same lease violation with bounded Z3", async () => {
    const broken = await findTemporalCounterexampleWithZ3(parseSpec("node-lease.ts", leaseModel(0)).temporal, "singleWriter", { maxSteps: 12 });
    expect(broken.status).toBe("counterexample");
    if (broken.status !== "counterexample") return;
    expect(broken.trace.steps.map((step) => step.action)).toEqual([
      ...Array.from({ length: 9 }, () => "tick_realNow"), "takeoverB", "publishB",
    ]);
    const replay = await replayModelCounterexample(broken.trace, {
      schema: "uneffect-refinement-adapter/v1", name: "node-lease-z3", version: "1",
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
    expect(replay).toMatchObject({ status: "replayed", violations: [{ invariant: "singleWriter", step: 11 }] });

    await expect(findTemporalCounterexampleWithZ3(parseSpec("node-lease.ts", leaseModel(1)).temporal, "singleWriter", { maxSteps: 12 })).resolves.toEqual({
      status: "safe-within-bound", depth: 12,
    });
  });

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
