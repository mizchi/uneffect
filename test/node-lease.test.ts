import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuint } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";
import { parseQuintItfCounterexample, parseTlcCounterexample, replayModelCounterexample, type ModelState, type ModelValue } from "../src/model-replay.js";
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

function capabilityRequestModel(enforceAuthority: boolean): string {
  return `/* uneffect:
    state authority: { owners: Map<int, int>, allowedResources: Set<int>, allowedOwners: Set<int> }
    state auditArmed: bool
    init authority = { owners: Map([[1, 10]]), allowedResources: Set(1, 2), allowedOwners: Set(10, 20) }
    init auditArmed = false
    action requestWrite: authority' = { ...authority, owners: authority.owners.put(2, 20) }
    ${enforceAuthority ? "action_when requestWrite: authority.allowedResources.contains(2) && authority.allowedOwners.contains(20)" : ""}
    action armAudit: auditArmed' = true
    action observeEscalation: auditArmed' = auditArmed
    action_when observeEscalation: auditArmed && authority.owners.keys().contains(2) && !authority.allowedResources.contains(2)
    action observeOwnerEscalation: auditArmed' = auditArmed
    action_when observeOwnerEscalation: auditArmed && authority.owners.values().contains(20) && !authority.allowedOwners.contains(20)
    temporal requestWithinAuthority: authority.owners.keys().forall(resource => authority.allowedResources.contains(resource))
    temporal ownerWithinAuthority: authority.owners.values().forall(owner => authority.allowedOwners.contains(owner))
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
  it("extracts record-valued lease grants across Quint, Z3, TLC, and replay", async () => {
    const fileName = "examples/dogfood/node-lease-record-grants.ts";
    const source = readFileSync(fileName, "utf8");
    const safe = parseSpec(fileName, source).temporal;
    const directory = mkdtempSync(join(tmpdir(), "uneffect-node-lease-record-grants-"));
    const quintPath = join(directory, "record-grants.qnt");
    writeFileSync(quintPath, generateQuint("node_lease_record_grants", safe));
    const quintRun = spawnSync("pnpm", ["exec", "quint", "run", quintPath,
      "--invariant=validGrantHasEpoch", "--max-steps=3", "--max-samples=100"],
    { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(quintRun.status, quintRun.stdout + quintRun.stderr).toBe(0);
    await expect(findTemporalCounterexampleWithZ3(safe, "validGrantHasEpoch", { maxSteps: 2 }))
      .resolves.toEqual({ status: "safe-within-bound", depth: 2 });

    const broken = parseSpec(fileName, source.replace("epoch: 2", "epoch: 0")).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "validGrantHasEpoch", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 1,
        trace: { steps: [{
          action: "admitStandby",
          after: { grants: [
            { owner: "node-b", epoch: 0, valid: true },
            { owner: "node-a", epoch: 1, valid: true },
          ] },
        }] },
      });
    await expect(findTemporalCounterexampleWithZ3(broken, "validGrantHasEpoch", {
      maxSteps: 2,
      z3: { preference: "wasm" },
    })).resolves.toMatchObject({ status: "counterexample", depth: 1 });

    const dynamic = parseSpec("dynamic-record-grant.ts", `/* uneffect:
      state candidate: { owner: string, epoch: int, valid: bool }
      state grants: Set<{ owner: string, epoch: int, valid: bool }>
      init candidate = { owner: "node-a", epoch: 1, valid: true }
      init grants = Set(candidate)
      action retain: grants' = grants
      temporal validGrantHasEpoch: grants.forall(grant => !grant.valid || grant.epoch > 0)
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(dynamic, "validGrantHasEpoch", { maxSteps: 1 }))
      .resolves.toEqual({ status: "unknown", depth: 0 });

    const tlc = `Invariant validGrantHasEpoch is violated.\nState 1: <Initial predicate>\n/\\ grants = {[owner |-> "node-a", epoch |-> 1, valid |-> TRUE]}\nState 2: <admitStandby line 1, col 1 to line 1, col 1>\n/\\ grants = {[owner |-> "node-a", epoch |-> 1, valid |-> TRUE], [owner |-> "node-b", epoch |-> 0, valid |-> TRUE]}`;
    const trace = parseTlcCounterexample(tlc, broken, "record-grant-node-lease");
    expect(trace.steps[0]?.after).toEqual({ grants: [
      { owner: "node-b", epoch: 0, valid: true },
      { owner: "node-a", epoch: 1, valid: true },
    ] });
    await expect(replayModelCounterexample(trace, {
      schema: "uneffect-refinement-adapter/v1",
      name: "record-grant-node-lease",
      version: "1",
      create: (state) => structuredClone(state),
      observe: (state) => structuredClone(state),
      actions: {
        admitStandby: (state) => { state.grants = [
          { owner: "node-b", epoch: 0, valid: true },
          ...(state.grants as ModelValue[]),
        ]; },
      },
    })).resolves.toMatchObject({ status: "replayed", matchedSteps: 1 });
  });

  it("preserves production string node identities across Quint, Z3, TLC trace import, and replay", async () => {
    const fileName = "examples/dogfood/node-lease-string-identities.ts";
    const temporal = parseSpec(fileName, readFileSync(fileName, "utf8")).temporal;
    expect(temporal.states.slice(0, 3).map((state) => state.type)).toEqual([
      { kind: "set", element: "string" },
      "string",
      { kind: "map", key: "string", value: { kind: "record", fields: { epoch: "int", valid: "bool" } } },
    ]);
    const quint = generateQuint("node_lease_string_identities", temporal);
    expect(quint).toContain("  var selectedNode: string\n");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-node-lease-string-"));
    const quintPath = join(directory, "node-lease-string.qnt");
    writeFileSync(quintPath, quint);
    const quintRun = spawnSync("pnpm", ["exec", "quint", "run", quintPath,
      "--invariant=missingLeaseIsFenced", "--max-steps=5", "--max-samples=100"],
    { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(quintRun.status, quintRun.stdout + quintRun.stderr).toBe(0);
    await expect(findTemporalCounterexampleWithZ3(temporal, "missingLeaseIsFenced", { maxSteps: 3 }))
      .resolves.toMatchObject({
        status: "safe-within-bound", depth: 3,
        observationDomains: [expect.objectContaining({ values: ["node-a", "node-b"] })],
      });

    const broken = parseSpec(fileName, readFileSync(fileName, "utf8").replace(
      "{ epoch: 0, valid: false }).valid",
      "{ epoch: 0, valid: true }).valid",
    )).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "missingLeaseIsFenced", { maxSteps: 3 }))
      .resolves.toMatchObject({
        status: "counterexample",
        trace: { steps: expect.arrayContaining([
          expect.objectContaining({ action: "selectStandby", after: expect.objectContaining({ selectedNode: "node-b" }) }),
        ]) },
      });

    const tlc = `Invariant missingLeaseIsFenced is violated.\nState 1: <Initial predicate>\n/\\ nodes = {"node-a", "node-b"}\n/\\ selectedNode = "node-a"\n/\\ leases = ["node-a" |-> [epoch |-> 1, valid |-> TRUE]]\n/\\ writeAllowed = FALSE\nState 2: <selectStandby line 1, col 1 to line 1, col 1>\n/\\ nodes = {"node-a", "node-b"}\n/\\ selectedNode = "node-b"\n/\\ leases = ["node-a" |-> [epoch |-> 1, valid |-> TRUE]]\n/\\ writeAllowed = FALSE`;
    const trace = parseTlcCounterexample(tlc, temporal, "string-node-lease");
    expect(trace.steps).toEqual([
      expect.objectContaining({ action: "selectStandby", after: expect.objectContaining({ selectedNode: "node-b" }) }),
    ]);
    await expect(replayModelCounterexample(trace, {
      schema: "uneffect-refinement-adapter/v1",
      name: "string-node-lease",
      version: "1",
      create: (state) => structuredClone(state),
      observe: (state) => structuredClone(state),
      actions: {
        selectStandby: (state) => { state.selectedNode = "node-b"; state.writeAllowed = false; },
      },
    })).resolves.toMatchObject({ status: "replayed", matchedSteps: 1 });

    const unsupportedControlCharacter = parseSpec("string-control.ts", `/* uneffect:
      state id: string
      init id = "\\n"
      action retain: id' = id
      temporal stable: id === "\\n"
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(unsupportedControlCharacter, "stable", { maxSteps: 1 }))
      .resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("defaults a missing node lease to a fenced record across Quint and Z3", async () => {
    const fileName = "examples/dogfood/node-lease-total-map-lookup.ts";
    const source = readFileSync(fileName, "utf8");
    const safe = parseSpec(fileName, source).temporal;
    const directory = mkdtempSync(join(tmpdir(), "uneffect-node-lease-default-"));
    const path = join(directory, "node-lease-default.qnt");
    writeFileSync(path, generateQuint("node_lease_default", safe));
    const execution = spawnSync(
      "pnpm",
      ["exec", "quint", "run", path, "--invariant=unknownNodeCannotWrite", "--max-steps=3", "--max-samples=100"],
      { encoding: "utf8", timeout: 30_000 },
    );
    rmSync(directory, { recursive: true, force: true });
    expect(execution.status, execution.stdout + execution.stderr).toBe(0);
    await expect(findTemporalCounterexampleWithZ3(safe, "unknownNodeCannotWrite", { maxSteps: 2 }))
      .resolves.toEqual({ status: "safe-within-bound", depth: 2 });

    const brokenSource = source.replace(
      "{ epoch: 0, valid: false }).valid",
      "{ epoch: 0, valid: true }).valid",
    );
    const broken = parseSpec(fileName, brokenSource).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "unknownNodeCannotWrite", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 1,
        trace: { steps: [{ action: "checkLease", after: expect.objectContaining({ writeAllowed: true }) }] },
      });

    const dynamicSource = source
      .replace("state leases:", "state requestedNode: int\n  state leases:")
      .replace("init leases =", "init requestedNode = 3\n  init leases =")
      .replace("leases.getOrElse(3,", "leases.getOrElse(requestedNode,")
      .replace("nodes.contains(3)", "nodes.contains(requestedNode)");
    const dynamic = parseSpec(fileName, dynamicSource).temporal;
    await expect(findTemporalCounterexampleWithZ3(dynamic, "unknownNodeCannotWrite", { maxSteps: 2 }))
      .resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("dogfoods synthesized subset authority and catches an unchecked request", async () => {
    const safe = parseSpec("capability-request-safe.ts", capabilityRequestModel(true)).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(safe, {
      maxSteps: 2,
      synthesizeCollectionStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeEscalation",
      relatedName: "<synth:authority.owners.keys() subset authority.allowedResources>",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeOwnerEscalation",
      relatedName: "<synth:authority.owners.values() subset authority.allowedOwners>",
    }));

    const broken = parseSpec("capability-request-broken.ts", capabilityRequestModel(false)
      .replace("allowedResources: Set(1, 2)", "allowedResources: Set(1)")
      .replace("allowedOwners: Set(10, 20)", "allowedOwners: Set(10)")).temporal;
    const brokenDiagnostics = await lintTemporalReachabilityWithZ3(broken, {
      maxSteps: 2,
      synthesizeCollectionStrengtheningProperties: true,
    });
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:authority.owners.keys() subset authority.allowedResources>",
    }));
    expect(brokenDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:authority.owners.values() subset authority.allowedOwners>",
    }));
    const counterexample = await findTemporalCounterexampleWithZ3(broken, "requestWithinAuthority", { maxSteps: 2 });
    expect(counterexample.status).toBe("counterexample");
    if (counterexample.status === "counterexample") {
      expect(counterexample.trace.steps.map((step) => step.action)).toContain("requestWrite");
      expect(counterexample.trace.steps.at(-1)?.after).toMatchObject({
        authority: { owners: [[1, 10], [2, 20]], allowedResources: [1], allowedOwners: [10] },
      });
    }
    await expect(findTemporalCounterexampleWithZ3(broken, "ownerWithinAuthority", { maxSteps: 2 }))
      .resolves.toMatchObject({ status: "counterexample" });
  });

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
  }, 60_000);

  it("synthesizes a lease-domain invariant to exclude invalid epoch actions", async () => {
    const withoutDeclaredEpochInvariant = parseSpec(
      "lease-synthesized-strengthening.ts",
      leaseLifecycleModel(true).replace("temporal ownerEpochPositive: ownerEpoch > 0", ""),
    ).temporal;
    const synthesized = await lintTemporalReachabilityWithZ3(withoutDeclaredEpochInvariant, {
      maxSteps: 3,
      synthesizeStrengtheningProperties: true,
    });
    expect(synthesized).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "observeZeroEpoch",
      relatedName: "<synth:ownerEpoch > 0>",
    }));
  }, 60_000);

  it("rules out worker-resource starvation only under the declared weak fairness", async () => {
    const model = (fair: boolean) => parseSpec("lease-gc-liveness.ts", `/* uneffect:
      state workerAlive: bool
      state resourceHeld: bool
      init workerAlive = true
      init resourceHeld = true
      action idle: resourceHeld' = resourceHeld
      action crash: workerAlive' = false
      action_when crash: workerAlive
      action gc: resourceHeld' = false
      action_when gc: !workerAlive && resourceHeld
      ${fair ? "action_fair crash: weak" : ""}
      ${fair ? "action_fair gc: weak" : ""}
      temporal_eventually resourceReleased: !resourceHeld
    */`).temporal;
    const unfair = await lintTemporalReachabilityWithZ3(model(false), { maxSteps: 4 });
    expect(unfair).toContainEqual(expect.objectContaining({
      code: "reachable-liveness-cycle", name: "resourceReleased",
    }));
    const fair = await lintTemporalReachabilityWithZ3(model(true), { maxSteps: 4 });
    expect(fair).not.toContainEqual(expect.objectContaining({
      code: "reachable-liveness-cycle", name: "resourceReleased",
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
