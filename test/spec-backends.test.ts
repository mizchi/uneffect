import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuint, generateSmtLib } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";
import { findTemporalCounterexampleWithZ3, lintSpec, lintSpecWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpec, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import { parseTlcCounterexample, replayModelCounterexample } from "../src/model-replay.js";
import { extractAnnotations } from "../src/annotations.js";
import { createDefaultTemporalDomainRegistry, createPhysicalClockDomain } from "../src/temporal-domains.js";

const hasJava = spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0;

const source = `
  /*
   * uneffect:
   * state epoch: int
   * state cachedAt: int
   * state cacheValid: bool
   * init epoch = 0
   * init cachedAt = 0
   * init cacheValid = false
   * action read: cachedAt' = epoch, cacheValid' = true
   * action suspend: epoch' = epoch + 1, cacheValid' = false
   * temporal cacheIsSound: !cacheValid || cachedAt === epoch
   */

  /*
   * uneffect:
   * effect Console | Fetch<GET, "https://example.com/**">
   * requires x >= 0
   * ensures result > x
   */
  function inc(x: number) { console.log(x); return x + 1 }
`;

describe("spec IR and generated verifier programs", () => {
  it("expands registered temporal semantic domains without core parser conditionals", () => {
    const registry = createDefaultTemporalDomainRegistry().register({
      name: "queue-depth",
      directives: ["queue_depth"],
      expand(source) {
        const names = extractAnnotations(source, "queue_depth");
        return {
          states: names.map((name) => ({ name, type: "int" as const })),
          init: names.map((name) => `${name} = 0`),
          actions: names.map((name) => ({ name: `enqueue_${name}`, assignments: [`${name}' = ${name} + 1`] })),
          protectedStates: Object.fromEntries(names.map((name) => [name, {
            explicitInit: `queue depth \`${name}\` owns its init`,
            explicitAssignment: `queue depth \`${name}\` owns its transitions`,
          }])),
        };
      },
    });
    const temporal = parseSpec("domain.ts", `/* uneffect:
      queue_depth pending
      temporal nonNegative: pending >= 0
    */`, { temporalDomains: registry }).temporal;
    expect(temporal.states).toEqual([{ name: "pending", type: "int" }]);
    expect(temporal.init[0]?.expression).toBe("0");
    expect(temporal.actions[0]?.name).toBe("enqueue_pending");
    expect(generateQuint("domain", temporal)).toContain("pending' = pending + 1");
    expect(() => registry.register({ name: "duplicate", directives: ["queue_depth"], expand: () => ({}) })).toThrow(/already owned/);
  });

  it("models monotonic time, wall-clock rollback, and bounded skew as an optional domain pack", () => {
    const registry = createDefaultTemporalDomainRegistry().register(createPhysicalClockDomain());
    const temporal = parseSpec("physical-clock.ts", `/* uneffect:
      monotonic_clock mono: 1
      wall_clock wall: 1
      clock_skew wall, mono: 1
      action_fair tick_mono: weak
    */`, { temporalDomains: registry }).temporal;
    expect(temporal.states).toEqual([{ name: "mono", type: "int" }, { name: "wall", type: "int" }]);
    expect(temporal.actions.find((action) => action.name === "jump_back_wall")?.guard?.expression).toContain("wall >= 1");
    expect(temporal.properties).toContainEqual(expect.objectContaining({ name: "skew_wall_mono" }));
    const quint = generateQuint("physical_clock", temporal);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-physical-clock-"));
    const path = join(directory, "clock.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=skew_wall_mono", "--max-steps=20", "--max-samples=100"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("parses and verifies finite Set state without flattening node identities", async () => {
    const temporal = parseSpec("sets.ts", `/* uneffect:
      state nodes: Set<int>
      state owners: Set<int>
      init nodes = Set(1, 2)
      init owners = Set()
      action acquireOne: owners' = owners.union(Set(1))
      temporal ownersAreNodes: owners.forall(node => nodes.contains(node))
    */`).temporal;
    expect(temporal.states).toEqual([
      { name: "nodes", type: { kind: "set", element: "int" } },
      { name: "owners", type: { kind: "set", element: "int" } },
    ]);
    const quint = generateQuint("finite_sets", temporal);
    expect(quint).toContain("var owners: Set[int]");
    expect(quint).toContain("owners' = owners.union(Set(1))");
    expect(quint).toContain("owners.forall(node => nodes.contains(node))");
    expect(lintTemporalSpec(temporal)).toEqual([]);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-finite-sets-"));
    const path = join(directory, "sets.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=ownersAreNodes", "--max-steps=4", "--max-samples=50"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    await expect(findTemporalCounterexampleWithZ3(temporal, "ownersAreNodes")).resolves.toEqual({ status: "safe-within-bound", depth: 8 });
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toEqual([]);
  });

  it("semantically lints scalar-element Set predicates and extracts complete finite traces with Z3", async () => {
    const temporal = parseSpec("set-lint.ts", `/* uneffect:
      state owners: Set<int>
      init owners = Set()
      action impossible: owners' = owners.union(Set(1))
      action_when impossible: owners.contains(1) && !owners.contains(1)
      temporal excludedMiddle: owners.forall(owner => owners.contains(owner) || !owners.contains(owner))
      temporal impossibleOwners: owners.contains(1) && !owners.contains(1)
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "solver-tautology", name: "excludedMiddle", backend: "z3" }),
      expect.objectContaining({ code: "solver-contradiction", name: "impossibleOwners", backend: "z3" }),
      expect.objectContaining({ code: "unreachable-action", name: "impossible", backend: "z3" }),
    ]));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "deadlocked-initial-state", backend: "z3" }),
      expect.objectContaining({ code: "bounded-unreachable-action", name: "impossible", backend: "z3", depth: 2 }),
    ]));
    await expect(findTemporalCounterexampleWithZ3(temporal, "excludedMiddle")).resolves.toEqual({ status: "safe-within-bound", depth: 8 });
    const broken = parseSpec("set-counterexample.ts", `/* uneffect:
      state nodes: Set<int>
      state owners: Set<int>
      init nodes = Set(1)
      init owners = Set()
      action acquireUnknown: owners' = owners.union(Set(2))
      temporal ownersAreNodes: owners.forall(owner => nodes.contains(owner))
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "ownersAreNodes", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { initialState: { nodes: [1], owners: [] }, steps: [{ action: "acquireUnknown", after: { nodes: [1], owners: [2] } }] },
    });
    const booleans = parseSpec("bool-set.ts", `/* uneffect:
      state flags: Set<bool>
      init flags = Set()
      action enable: flags' = flags.union(Set(true))
      temporal enabledOrNot: flags.contains(true) || !flags.contains(true)
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(booleans)).resolves.toContainEqual(expect.objectContaining({ code: "solver-tautology", name: "enabledOrNot" }));
    await expect(findTemporalCounterexampleWithZ3(booleans, "enabledOrNot", { maxSteps: 2 })).resolves.toEqual({ status: "safe-within-bound", depth: 2 });
  });

  it("keeps Set counterexample extraction honest outside the literal finite universe", async () => {
    const dynamic = parseSpec("dynamic-set.ts", `/* uneffect:
      state owner: int
      state owners: Set<int>
      init owner = 1
      init owners = Set()
      action acquire: owners' = owners.union(Set(owner))
      temporal empty: !owners.contains(owner)
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(dynamic, "empty", { maxSteps: 2 })).resolves.toEqual({ status: "unknown", depth: 0 });

    const signed = parseSpec("signed-set.ts", `/* uneffect:
      state values: Set<int>
      init values = Set()
      action insert: values' = values.union(Set(-1))
      temporal nonnegative: !values.contains(-1)
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(signed, "nonnegative", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { initialState: { values: [] }, steps: [{ action: "insert", after: { values: [-1] } }] },
    });
  });

  it("reports Set cardinality as an explicit Z3 non-proof instead of throwing", async () => {
    const temporal = parseSpec("set-size-z3.ts", `/* uneffect:
      state owners: Set<int>
      init owners = Set(1)
      action add: owners' = owners.union(Set(2))
      temporal singleOwner: owners.size() <= 1
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain", backend: "z3",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain", backend: "z3",
    }));
    await expect(findTemporalCounterexampleWithZ3(temporal, "singleOwner", { maxSteps: 2 })).resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("parses and verifies finite Map state with immutable updates", () => {
    const temporal = parseSpec("maps.ts", `/* uneffect:
      state epochs: Map<int, int>
      init epochs = Map([[1, 1], [2, 0]])
      action publish: epochs' = epochs.put(2, 1)
      temporal nonNegative: epochs.values().forall(epoch => epoch >= 0)
    */`).temporal;
    expect(temporal.states).toEqual([{ name: "epochs", type: { kind: "map", key: "int", value: "int" } }]);
    const quint = generateQuint("finite_maps", temporal);
    expect(quint).toContain("var epochs: int -> int");
    expect(quint).toContain("epochs' = epochs.put(2, 1)");
    expect(quint).toContain("epochs.keys().map(_uneffect_key => epochs.get(_uneffect_key)).forall(epoch => epoch >= 0)");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-finite-maps-"));
    const path = join(directory, "maps.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=nonNegative", "--max-steps=4", "--max-samples=50"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("semantically checks scalar Map keys and values with Z3", async () => {
    const temporal = parseSpec("map-z3.ts", `/* uneffect:
      state epochs: Map<int, int>
      init epochs = Map([[1, 0]])
      action publish: epochs' = epochs.put(2, 1)
      temporal nonnegative: epochs.values().forall(epoch => epoch >= 0)
      temporal keysKnown: epochs.keys().forall(node => node === 1 || node === 2)
      temporal excludedMiddle: epochs.values().forall(epoch => epoch >= 0 || epoch < 0)
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toContainEqual(expect.objectContaining({
      code: "solver-tautology", name: "excludedMiddle", backend: "z3",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));

    const broken = parseSpec("map-z3-broken.ts", `/* uneffect:
      state epochs: Map<int, int>
      init epochs = Map([[1, 0]])
      action corrupt: epochs' = epochs.put(2, -1)
      temporal nonnegative: epochs.values().forall(epoch => epoch >= 0)
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "nonnegative", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { initialState: { epochs: [[1, 0]] }, steps: [{ action: "corrupt", after: { epochs: [[1, 0], [2, -1]] } }] },
    });

    const flags = parseSpec("bool-map-z3.ts", `/* uneffect:
      state flags: Map<bool, bool>
      init flags = Map([[false, false], [true, false]])
      action enable: flags' = flags.put(true, true)
      temporal booleanValues: flags.values().forall(flag => flag || !flag)
      temporal bothKeys: flags.keys().contains(false) && flags.keys().contains(true)
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(flags)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "solver-tautology", name: "booleanValues" }),
    ]));
    await expect(findTemporalCounterexampleWithZ3(flags, "bothKeys", { maxSteps: 2 })).resolves.toEqual({
      status: "safe-within-bound", depth: 2,
    });

    const dynamic = parseSpec("dynamic-map-z3.ts", `/* uneffect:
      state epoch: int
      state epochs: Map<int, int>
      init epoch = 1
      init epochs = Map([[1, 0]])
      action publish: epochs' = epochs.put(epoch, 1)
      temporal empty: !epochs.keys().contains(epoch)
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(dynamic, "empty", { maxSteps: 2 })).resolves.toEqual({ status: "unknown", depth: 0 });
    await expect(lintTemporalReachabilityWithZ3(dynamic, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
  });

  it("parses and verifies record state with field reads and immutable updates", () => {
    const temporal = parseSpec("records.ts", `/* uneffect:
      state lease: { owner: int, valid: bool }
      init lease = { owner: 1, valid: true }
      action transfer: lease' = { ...lease, owner: 2 }
      temporal validOwner: !lease.valid || lease.owner > 0
    */`).temporal;
    expect(temporal.states[0]?.type).toEqual({ kind: "record", fields: { owner: "int", valid: "bool" } });
    const quint = generateQuint("record_state", temporal);
    expect(quint).toContain("var lease: { owner: int, valid: bool }");
    expect(quint).toContain('lease\' = lease.with("owner", 2)');
    const directory = mkdtempSync(join(tmpdir(), "uneffect-record-state-"));
    const path = join(directory, "record.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=validOwner", "--max-steps=4", "--max-samples=50"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("semantically checks and extracts scalar record state with Z3", async () => {
    const temporal = parseSpec("record-z3.ts", `/* uneffect:
      state lease: { owner: int, valid: bool }
      init lease = { owner: 1, valid: true }
      action transfer: lease' = { ...lease, owner: 2 }
      temporal validOwner: !lease.valid || lease.owner > 0
      temporal booleanValidity: lease.valid || !lease.valid
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toContainEqual(expect.objectContaining({
      code: "solver-tautology", name: "booleanValidity", backend: "z3",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(temporal, "validOwner", { maxSteps: 2 })).resolves.toEqual({
      status: "safe-within-bound", depth: 2,
    });

    const broken = parseSpec("record-z3-broken.ts", `/* uneffect:
      state lease: { owner: int, valid: bool }
      init lease = { owner: 1, valid: true }
      action invalidate: lease' = { ...lease, owner: 0 }
      temporal validOwner: !lease.valid || lease.owner > 0
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "validOwner", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: {
        initialState: { lease: { owner: 1, valid: true } },
        steps: [{ action: "invalidate", after: { lease: { owner: 0, valid: true } } }],
      },
    });

    const nested = parseSpec("nested-record-z3.ts", `/* uneffect:
      state lease: { owners: Set<int>, valid: bool }
      init lease = { owners: Set(1), valid: true }
      temporal valid: lease.valid
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(nested)).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(nested, "valid", { maxSteps: 1 })).resolves.toEqual({ status: "safe-within-bound", depth: 1 });
  });

  it("nests record values inside finite Maps", async () => {
    const temporal = parseSpec("nested-records.ts", `/* uneffect:
      state leases: Map<int, { epoch: int, valid: bool }>
      init leases = Map([[1, { epoch: 1, valid: true }], [2, { epoch: 0, valid: false }]])
      action publish: leases' = leases.put(2, { epoch: 1, valid: true })
      temporal validEpochs: leases.values().forall(lease => !lease.valid || lease.epoch > 0)
    */`).temporal;
    expect(temporal.states[0]?.type).toEqual({ kind: "map", key: "int", value: { kind: "record", fields: { epoch: "int", valid: "bool" } } });
    const quint = generateQuint("nested_records", temporal);
    expect(quint).toContain("var leases: int -> { epoch: int, valid: bool }");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-nested-records-"));
    const path = join(directory, "nested.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=validEpochs", "--max-steps=4", "--max-samples=50"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(temporal, "validEpochs", { maxSteps: 2 })).resolves.toEqual({ status: "safe-within-bound", depth: 2 });
    const broken = parseSpec("nested-records-broken.ts", `/* uneffect:
      state leases: Map<int, { epoch: int, valid: bool }>
      init leases = Map([[1, { epoch: 1, valid: true }]])
      action corrupt: leases' = leases.put(2, { epoch: -1, valid: true })
      temporal validEpochs: leases.values().forall(lease => !lease.valid || lease.epoch > 0)
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "validEpochs", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { steps: [{ action: "corrupt", after: { leases: [[1, { epoch: 1, valid: true }], [2, { epoch: -1, valid: true }]] } }] },
    });
  });

  it("reasons about Set fields inside records without flattening them", async () => {
    const temporal = parseSpec("record-set-z3.ts", `/* uneffect:
      state lease: { owners: Set<int>, valid: bool }
      init lease = { owners: Set(1), valid: true }
      action addOwner: lease' = { ...lease, owners: lease.owners.union(Set(2)) }
      temporal ownersPositive: lease.owners.forall(owner => owner > 0)
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(temporal, "ownersPositive", { maxSteps: 2 })).resolves.toEqual({ status: "safe-within-bound", depth: 2 });
    const broken = parseSpec("record-set-z3-broken.ts", `/* uneffect:
      state lease: { owners: Set<int>, valid: bool }
      init lease = { owners: Set(1), valid: true }
      action addInvalid: lease' = { ...lease, owners: lease.owners.union(Set(-1)) }
      temporal ownersPositive: lease.owners.forall(owner => owner > 0)
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "ownersPositive", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { steps: [{ action: "addInvalid", after: { lease: { owners: [-1, 1], valid: true } } }] },
    });

    const recordSet = parseSpec("record-element-set-z3.ts", `/* uneffect:
      state leases: Set<{ owner: int, valid: bool }>
      init leases = Set({ owner: 1, valid: true })
      temporal validOwners: leases.forall(lease => !lease.valid || lease.owner > 0)
    */`).temporal;
    await expect(lintTemporalSpecWithZ3(recordSet)).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(lintTemporalReachabilityWithZ3(recordSet, { maxSteps: 1 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(recordSet, "validOwners", { maxSteps: 1 })).resolves.toEqual({ status: "unknown", depth: 0 });
  });
  it("extracts the shortest bounded Z3 trace and replays its actions", async () => {
    const temporal = parseSpec("counter.ts", `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
      temporal belowTwo: value < 2
    */`).temporal;
    const result = await findTemporalCounterexampleWithZ3(temporal, "belowTwo", { maxSteps: 4 });
    expect(result.status).toBe("counterexample");
    if (result.status !== "counterexample") return;
    expect(result.trace).toMatchObject({
      backend: "z3", initialState: { value: 0 },
      steps: [
        { action: "increment", before: { value: 0 }, after: { value: 1 } },
        { action: "increment", before: { value: 1 }, after: { value: 2 } },
      ],
    });
    const replay = await replayModelCounterexample(result.trace, {
      schema: "uneffect-refinement-adapter/v1", name: "counter", version: "1",
      create: (state) => ({ value: Number(state.value) }), observe: (runtime) => ({ value: runtime.value }),
      actions: { increment: (runtime) => { runtime.value++; } },
      invariants: { belowTwo: (runtime) => runtime.value < 2 },
    });
    expect(replay).toMatchObject({ status: "replayed", matchedSteps: 2, violations: [{ invariant: "belowTwo", step: 2 }] });
  });

  it("checks initial temporal violations and reports bounded safety honestly", async () => {
    const initiallyBroken = parseSpec("initial.ts", `/* uneffect:
      state ready: bool
      init ready = false
      temporal readyNow: ready
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(initiallyBroken, "readyNow", { maxSteps: 3 })).resolves.toMatchObject({
      status: "counterexample", depth: 0, trace: { initialState: { ready: false }, steps: [] },
    });

    const boundedSafe = parseSpec("safe.ts", `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
      temporal belowThree: value < 3
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(boundedSafe, "belowThree", { maxSteps: 2 })).resolves.toEqual({
      status: "safe-within-bound", depth: 2,
    });
  });

  it.runIf(hasJava)("normalizes an actual TLC counterexample when Java is available", () => {
    const temporal = parseSpec("tlc-counter.ts", `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
      temporal belowTwo: value < 2
    */`).temporal;
    const directory = mkdtempSync(join(tmpdir(), "uneffect-tlc-trace-"));
    const path = join(directory, "counter.qnt");
    const model = generateQuint("counter", temporal);
    writeFileSync(path, model);
    const result = spawnSync("pnpm", ["exec", "quint", "verify", path,
      "--backend=tlc", "--invariant=belowTwo", "--verbosity=3"], { encoding: "utf8", timeout: 120_000 });
    rmSync(directory, { recursive: true, force: true });
    const output = result.stdout + result.stderr;
    expect(result.status, output).not.toBe(0);
    const trace = parseTlcCounterexample(output, temporal, "generated-counter");
    expect(trace.steps).toEqual([
      { action: "increment", before: { value: 0 }, after: { value: 1 } },
      { action: "increment", before: { value: 1 }, after: { value: 2 } },
    ]);
  }, 125_000);

  it("classifies capability, invariant, and temporal specifications", () => {
    const spec = parseSpec("input.ts", source);
    expect(spec.capabilities[0]).toMatchObject({
      functionName: "inc",
      effects: [
        expect.objectContaining({ value: expect.objectContaining({ kind: "capability", name: "Console" }), span: expect.any(Object) }),
        expect.objectContaining({ value: expect.objectContaining({ kind: "capability", name: "Fetch" }), span: expect.any(Object) }),
      ],
    });
    expect(spec.invariants[0]).toMatchObject({
      functionName: "inc",
      parameters: ["x"],
      requires: ["x >= 0"],
      ensures: ["result > x"],
      result: "x + 1",
    });
    expect(spec.temporal).toMatchObject({
      states: [
        { name: "epoch", type: "int" },
        { name: "cachedAt", type: "int" },
        { name: "cacheValid", type: "bool" },
      ],
      properties: [{ name: "cacheIsSound", expression: "!cacheValid || cachedAt === epoch" }],
    });
  });

  it("reports malformed effects with their source location", () => {
    expect(() => parseSpec("broken.ts", `\n/* uneffect: effect Fetch<GET */\nfunction f() {}`))
      .toThrow(/broken\.ts:2:\d+: invalid effect/);
  });

  it("rejects an unsupported Uneffect directive instead of ignoring it", () => {
    expect(() => parseSpec("broken.ts", `/* uneffect: effects Console */\nfunction f() {}`))
      .toThrow(/broken\.ts:1:\d+: unknown Uneffect directive `effects`/);
  });

  it("rejects an empty member in an effect union", () => {
    expect(() => parseSpec("broken.ts", `/* uneffect: effect Console | */\nfunction f() {}`))
      .toThrow(/broken\.ts:1:\d+: empty member/);
  });

  it("generates an SMT-LIB proof obligation accepted as unsat by Z3", () => {
    const fn = parseSpec("input.ts", source).invariants[0]!;
    const smt = generateSmtLib(fn);
    expect(smt).toContain("(assert (= result (+ x 1)))");
    const result = spawnSync("z3", ["-in"], { input: smt, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unsat");
  });

  it("generates a Quint transition system that preserves its invariant", () => {
    const temporal = parseSpec("input.ts", source).temporal;
    const quint = generateQuint("generated", temporal);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-quint-"));
    const path = join(directory, "generated.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", [
      "exec", "quint", "run", path,
      "--invariant=cacheIsSound", "--max-steps=10", "--max-samples=100",
      "--seed=0x123456789abcdef", "--verbosity=1",
    ], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("No violation found");
  });

  it("generates guarded real-time actions and finds a load-bearing broken tick", () => {
    const model = (guarded: boolean) => parseSpec("realtime.ts", `
      /*
       * uneffect:
       * clock clock: 1
       * state pending: bool
       * state deadline: int
       * init pending = false
       * init deadline = 0
       * action release: pending' = true, deadline' = clock + 3
       * action_when release: !pending
       * action complete: pending' = false
       * action_when complete: pending && clock <= deadline
       ${guarded ? "* action_when tick_clock: !pending || clock < deadline" : ""}
       * action_fair tick_clock: weak
       * temporal deadlineSafe: !pending || clock <= deadline
       */
    `).temporal;
    expect(model(true).actions).toContainEqual(expect.objectContaining({
      name: "tick_clock", guard: expect.objectContaining({ expression: "!pending || clock < deadline" }),
    }));
    expect(model(true).clocks).toEqual([{ name: "clock", granularity: 1 }]);
    expect(model(true).actions.find((action) => action.name === "tick_clock")?.fairness).toBe("weak");
    expect(generateQuint("realtime", model(true))).toContain("tick_clock.weakFair(fairnessVars)");

    const run = (guarded: boolean) => {
      const directory = mkdtempSync(join(tmpdir(), "uneffect-realtime-"));
      const path = join(directory, "realtime.qnt");
      writeFileSync(path, generateQuint("realtime", model(guarded)));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=deadlineSafe", "--max-steps=8", "--max-samples=200",
        "--seed=0x123456789abcdef", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    const positive = run(true);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    expect(positive.stdout + positive.stderr).toContain("No violation found");
    const broken = run(false);
    expect(broken.status).not.toBe(0);
    expect(broken.stdout + broken.stderr).toMatch(/violation|counterexample/i);
  });

  it("protects structured clocks from arbitrary writes", () => {
    expect(() => parseSpec("clock.ts", `/*
      * uneffect:
      * clock now: 0
      */`)).toThrow(/granularity must be a positive integer/);
    expect(() => parseSpec("clock.ts", `/*
      * uneffect:
      * clock now: 1
      * action rewind: now' = now - 1
      */`)).toThrow(/only generated action `tick_now` may update clock `now`/);
    expect(() => parseSpec("clock.ts", `/*
      * uneffect:
      * clock now: 1
      * init now = 10
      */`)).toThrow(/clock `now` has an implicit zero init/);
  });

  it("reports syntactically valid but meaningless temporal declarations", () => {
    const result = lintSpec("meaningless.ts", `/* uneffect:
      state epoch: int
      init epoch = 0
      action idle: epoch' = epoch
      temporal tautology: epoch === epoch
      temporal contradiction: epoch !== epoch
    */`);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "tautological-invariant", name: "tautology" }),
      expect.objectContaining({ code: "contradictory-invariant", name: "contradiction" }),
      expect.objectContaining({ code: "no-op-action", name: "idle" }),
    ]));
  });

  it("uses Z3 to reject semantic tautologies, contradictions, inconsistent init, unreachable guards, and subsumed properties", async () => {
    const temporal = parseSpec("semantic-lint.ts", `/* uneffect:
      state epoch: int
      state ready: bool
      init epoch = 0
      init epoch = 1
      init ready = false
      action impossible: ready' = true
      action_when impossible: epoch > 0 && epoch <= 0
      temporal totalOrder: epoch > 0 || epoch <= 0
      temporal impossibleState: epoch > 0 && epoch <= 0
      temporal positive: epoch > 0
      temporal nonnegative: epoch >= 0
      temporal positiveAgain: epoch > 0
    */`).temporal;
    const diagnostics = await lintTemporalSpecWithZ3(temporal);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "inconsistent-init" }),
      expect.objectContaining({ code: "solver-tautology", name: "totalOrder" }),
      expect.objectContaining({ code: "solver-contradiction", name: "impossibleState" }),
      expect.objectContaining({ code: "unreachable-action", name: "impossible" }),
      expect.objectContaining({ code: "duplicate-property", name: "positiveAgain" }),
      expect.objectContaining({ code: "subsumed-property", name: "nonnegative", relatedName: "positive" }),
    ]));
  });

  it("combines syntax and solver diagnostics from source text", async () => {
    const result = await lintSpecWithZ3("combined-lint.ts", `/* uneffect:
      state epoch: int
      init epoch = 0
      action idle: epoch' = epoch
      temporal totalOrder: epoch > 0 || epoch <= 0
    */`);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "no-op-action", name: "idle" }),
      expect.objectContaining({ code: "solver-tautology", name: "totalOrder", backend: "z3" }),
    ]));
  });

  it("distinguishes bounded transition reachability from globally satisfiable guards", async () => {
    const temporal = parseSpec("reachability.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = 1
      action_when advance: phase === 0
      action finish: phase' = 2
      action_when finish: phase === 1
      action never: phase' = 3
      action_when never: phase === 99
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "bounded-unreachable-action", name: "never", depth: 3 }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "advance" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "finish" }));
  });

  it("upgrades an unreachable action only when one-step induction proves it", async () => {
    const temporal = parseSpec("inductive-unreachable.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = phase + 1
      action_when advance: phase >= 0
      action negative: phase' = 0
      action_when negative: phase < 0
      action distant: phase' = phase
      action_when distant: phase === 99
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "inductively-unreachable-action", name: "negative", backend: "z3", depth: 1,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-unreachable-action", name: "distant", backend: "z3", depth: 3,
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "inductively-unreachable-action", name: "distant",
    }));
  });

  it("proves an initial deadlock without claiming unbounded reachability", async () => {
    const temporal = parseSpec("deadlock.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = 1
      action_when advance: phase > 0
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "deadlocked-initial-state", name: "<init>" }));
  });

  it("finds the shortest reachable deadlock within the explicit bound", async () => {
    const temporal = parseSpec("later-deadlock.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = phase + 1
      action_when advance: phase < 2
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 4 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-reachable-deadlock", name: "<deadlock>", depth: 2,
    }));
  });

  it("finds a reachable state where every enabled action only stutters", async () => {
    const temporal = parseSpec("later-stutter.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = 1
      action_when advance: phase === 0
      action idle: phase' = phase
      action_when idle: phase === 1
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-no-state-progress", name: "<progress>", depth: 1,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "reachable-stutter-cycle", name: "<liveness>", depth: 1,
      message: expect.stringContaining("fairness"),
    }));
  });

  it("reports a bounded invariant that holds only because its referenced state is frozen", async () => {
    const temporal = parseSpec("vacuous-property.ts", `/* uneffect:
      state phase: int
      state counter: int
      init phase = 0
      init counter = 0
      action tick: counter' = counter + 1
      temporal phaseFixed: phase === 0
      temporal counterNonnegative: counter >= 0
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-vacuous-property", name: "phaseFixed", depth: 3,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "inductively-vacuous-property", name: "phaseFixed", depth: 1,
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "bounded-vacuous-property", name: "counterNonnegative" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "inductively-vacuous-property", name: "counterNonnegative" }));
  });

  it("does not promote reachability-specific frozen state to unbounded vacuity", async () => {
    const temporal = parseSpec("bounded-only-vacuity.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action unreachableChange: phase' = 1
      action_when unreachableChange: phase < 0
      temporal phaseFixed: phase === 0
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "bounded-vacuous-property", name: "phaseFixed" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "inductively-vacuous-property", name: "phaseFixed" }));
  });

  it("detects models whose enabled initial transitions cannot change state", async () => {
    const temporal = parseSpec("stuttering.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action idle: phase' = phase
      temporal fixed: phase === 0
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 1 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "no-state-progress-from-init", name: "<init>" }));
  });

  it("does not treat a source file without a temporal model as a deadlocked model", async () => {
    const result = await lintSpecWithZ3("plain.ts", `export function add(a: number, b: number) { return a + b }`);
    expect(result.diagnostics).toEqual([]);
  });
});
