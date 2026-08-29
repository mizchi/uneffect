import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createZ3Context } from "../src/z3.js";
import { generateQuint, generateSmtLib } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";
import { findTemporalCounterexampleWithZ3, lintSpec, lintSpecWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpec, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import { parseTlcCounterexample, replayModelCounterexample } from "../src/model-replay.js";
import { extractAnnotations } from "../src/annotations.js";
import { createDefaultTemporalDomainRegistry, createPhysicalClockDomain } from "../src/temporal-domains.js";
import { generateRuntimeAssertionExpression } from "../src/temporal-expressions.js";

const hasJava = spawnSync("java", ["-version"], { encoding: "utf8" }).status === 0;

const source = `
  /* uneffect:temporal state epoch: int */ /* uneffect:temporal state cachedAt: int */ /* uneffect:temporal state cacheValid: bool */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal init cachedAt = 0 */ /* uneffect:temporal init cacheValid = false */ /* uneffect:temporal action read: cachedAt' = epoch, cacheValid' = true */ /* uneffect:temporal action suspend: epoch' = epoch + 1, cacheValid' = false */ /* uneffect:temporal invariant cacheIsSound: !cacheValid || cachedAt === epoch */

  /* uneffect:capability effect Console | Fetch<GET, "https://example.com/**"> */ /* uneffect:contract requires x >= 0 */ /* uneffect:contract ensures result > x */
  function inc(x: number) { console.log(x); return x + 1 }
`;

describe("spec IR and generated verifier programs", () => {
  it("splits action assignments after comparison operators without treating them as type arguments", () => {
    const temporal = parseSpec("comparison-assignments.ts", `/* uneffect:temporal state attempted: int */ /* uneffect:temporal state processed: int */ /* uneffect:temporal state finalized: int */ /* uneffect:temporal init attempted = 0 */ /* uneffect:temporal init processed = 0 */ /* uneffect:temporal init finalized = 0 */ /* uneffect:temporal action finish: processed' = attempted < 0 ? processed : processed + 1, finalized' = finalized + 1 */`).temporal;
    expect(temporal.actions[0]?.assignments.map(({ target }) => target)).toEqual(["processed", "finalized"]);
  });

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
    const temporal = parseSpec("domain.ts", `/* uneffect:temporal queue_depth pending */ /* uneffect:temporal invariant nonNegative: pending >= 0 */`, { temporalDomains: registry }).temporal;
    expect(temporal.states).toEqual([{ name: "pending", type: "int" }]);
    expect(temporal.init[0]?.expression).toBe("0");
    expect(temporal.actions[0]?.name).toBe("enqueue_pending");
    expect(generateQuint("domain", temporal)).toContain("pending' = pending + 1");
    expect(() => registry.register({ name: "duplicate", directives: ["queue_depth"], expand: () => ({}) })).toThrow(/already owned/);
  });

  it("models monotonic time, wall-clock rollback, and bounded skew as an optional domain pack", () => {
    const registry = createDefaultTemporalDomainRegistry().register(createPhysicalClockDomain());
    const temporal = parseSpec("physical-clock.ts", `/* uneffect:temporal monotonic_clock mono: 1 */ /* uneffect:temporal wall_clock wall: 1 */ /* uneffect:temporal clock_skew wall, mono: 1 */ /* uneffect:temporal action_fair tick_mono: weak */`, { temporalDomains: registry }).temporal;
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

  it("expands variable clock rates and bounded wall-clock jumps", () => {
    const registry = createDefaultTemporalDomainRegistry().register(createPhysicalClockDomain());
    const temporal = parseSpec("variable-physical-clock.ts", `/* uneffect:temporal monotonic_clock mono: 1..2 */ /* uneffect:temporal wall_clock wall: 1..3 */ /* uneffect:temporal wall_clock_jump wall: 1..2 */ /* uneffect:temporal clock_skew wall, mono: 3 */`, { temporalDomains: registry }).temporal;
    expect(temporal.actions.map((action) => action.name)).toEqual(expect.arrayContaining([
      "tick_mono_1", "tick_mono_2", "tick_wall_1", "tick_wall_2", "tick_wall_3", "jump_back_wall_1", "jump_back_wall_2",
    ]));
    expect(temporal.actions.find((action) => action.name === "jump_back_wall_2")?.assignments[0]?.expression).toBe("wall - 2");
    expect(temporal.actions.find((action) => action.name === "jump_back_wall_2")?.guard?.expression).toContain("wall >= 2");
  });

  it("parses and verifies finite Set state without flattening node identities", async () => {
    const temporal = parseSpec("sets.ts", `/* uneffect:temporal state nodes: Set<int> */ /* uneffect:temporal state owners: Set<int> */ /* uneffect:temporal init nodes = Set(1, 2) */ /* uneffect:temporal init owners = Set() */ /* uneffect:temporal action acquireOne: owners' = owners.union(Set(1)) */ /* uneffect:temporal invariant ownersAreNodes: owners.forall(node => nodes.contains(node)) */`).temporal;
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

  it("lowers finite existential collection predicates across backends", async () => {
    const temporal = parseSpec("collection-exists.ts", `/* uneffect:temporal state owners: Set<int> */ /* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal init owners = Set(1) */ /* uneffect:temporal init epochs = Map([[1, 2]]) */ /* uneffect:temporal action stay: owners' = owners, epochs' = epochs */ /* uneffect:temporal invariant hasPositiveOwner: owners.exists(owner => owner > 0) */ /* uneffect:temporal invariant hasKnownEpoch: epochs.values().exists(epoch => epoch === 2) */`).temporal;
    const quint = generateQuint("collection_exists", temporal);
    expect(quint).toContain("owners.exists(owner => owner > 0)");
    expect(quint).toContain("epochs.keys().map(_uneffect_key => epochs.get(_uneffect_key)).exists(epoch => epoch == 2)");
    expect(generateRuntimeAssertionExpression(temporal.properties[0]!.expressionAst))
      .toBe("Array.from(owners).some(owner => owner > 0)");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-collection-exists-"));
    const path = join(directory, "exists.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=hasPositiveOwner", "--max-steps=2", "--max-samples=20"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 1 })).resolves.not.toContainEqual(
      expect.objectContaining({ code: "unsupported-backend-domain" }),
    );
  });

  it("semantically lints scalar-element Set predicates and extracts complete finite traces with Z3", async () => {
    const temporal = parseSpec("set-lint.ts", `/* uneffect:temporal state owners: Set<int> */ /* uneffect:temporal init owners = Set() */ /* uneffect:temporal action impossible: owners' = owners.union(Set(1)) */ /* uneffect:temporal action_when impossible: owners.contains(1) && !owners.contains(1) */ /* uneffect:temporal invariant excludedMiddle: owners.forall(owner => owners.contains(owner) || !owners.contains(owner)) */ /* uneffect:temporal invariant impossibleOwners: owners.contains(1) && !owners.contains(1) */`).temporal;
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
    const broken = parseSpec("set-counterexample.ts", `/* uneffect:temporal state nodes: Set<int> */ /* uneffect:temporal state owners: Set<int> */ /* uneffect:temporal init nodes = Set(1) */ /* uneffect:temporal init owners = Set() */ /* uneffect:temporal action acquireUnknown: owners' = owners.union(Set(2)) */ /* uneffect:temporal invariant ownersAreNodes: owners.forall(owner => nodes.contains(owner)) */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "ownersAreNodes", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { initialState: { nodes: [1], owners: [] }, steps: [{ action: "acquireUnknown", after: { nodes: [1], owners: [2] } }] },
    });
    const booleans = parseSpec("bool-set.ts", `/* uneffect:temporal state flags: Set<bool> */ /* uneffect:temporal init flags = Set() */ /* uneffect:temporal action enable: flags' = flags.union(Set(true)) */ /* uneffect:temporal invariant enabledOrNot: flags.contains(true) || !flags.contains(true) */`).temporal;
    await expect(lintTemporalSpecWithZ3(booleans)).resolves.toContainEqual(expect.objectContaining({ code: "solver-tautology", name: "enabledOrNot" }));
    await expect(findTemporalCounterexampleWithZ3(booleans, "enabledOrNot", { maxSteps: 2 })).resolves.toEqual({ status: "safe-within-bound", depth: 2 });
  });

  it("keeps Set counterexample extraction honest outside the literal finite universe", async () => {
    const dynamic = parseSpec("dynamic-set.ts", `/* uneffect:temporal state owner: int */ /* uneffect:temporal state owners: Set<int> */ /* uneffect:temporal init owner = 1 */ /* uneffect:temporal init owners = Set() */ /* uneffect:temporal action acquire: owners' = owners.union(Set(owner)) */ /* uneffect:temporal invariant empty: !owners.contains(owner) */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(dynamic, "empty", { maxSteps: 2 })).resolves.toEqual({ status: "unknown", depth: 0 });

    const signed = parseSpec("signed-set.ts", `/* uneffect:temporal state values: Set<int> */ /* uneffect:temporal init values = Set() */ /* uneffect:temporal action insert: values' = values.union(Set(-1)) */ /* uneffect:temporal invariant nonnegative: !values.contains(-1) */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(signed, "nonnegative", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { initialState: { values: [] }, steps: [{ action: "insert", after: { values: [-1] } }] },
    });
  });

  it("reports Set cardinality as an explicit Z3 non-proof instead of throwing", async () => {
    const temporal = parseSpec("set-size-z3.ts", `/* uneffect:temporal state owners: Set<int> */ /* uneffect:temporal init owners = Set(1) */ /* uneffect:temporal action add: owners' = owners.union(Set(2)) */ /* uneffect:temporal invariant singleOwner: owners.size() <= 1 */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain", backend: "z3",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain", backend: "z3",
    }));
    await expect(findTemporalCounterexampleWithZ3(temporal, "singleOwner", { maxSteps: 2 })).resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("parses and verifies finite Map state with immutable updates", () => {
    const temporal = parseSpec("maps.ts", `/* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal init epochs = Map([[1, 1], [2, 0]]) */ /* uneffect:temporal action publish: epochs' = epochs.put(2, 1) */ /* uneffect:temporal invariant nonNegative: epochs.values().forall(epoch => epoch >= 0) */ /* uneffect:temporal invariant firstEpoch: epochs.keys().contains(1) && epochs.get(1) === 1 */`).temporal;
    expect(temporal.states).toEqual([{ name: "epochs", type: { kind: "map", key: "int", value: "int" } }]);
    const quint = generateQuint("finite_maps", temporal);
    expect(quint).toContain("var epochs: int -> int");
    expect(quint).toContain("epochs' = epochs.put(2, 1)");
    expect(quint).toContain("epochs.keys().map(_uneffect_key => epochs.get(_uneffect_key)).forall(epoch => epoch >= 0)");
    expect(quint).toContain("epochs.keys().contains(1) and epochs.get(1) == 1");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-finite-maps-"));
    const path = join(directory, "maps.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=nonNegative", "--max-steps=4", "--max-samples=50"], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const getResult = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=firstEpoch", "--max-steps=4", "--max-samples=50"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(getResult.status, getResult.stdout + getResult.stderr).toBe(0);
    expect(() => parseSpec("unguarded-map-get.ts", `/* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal init epochs = Map([[1, 1]]) */ /* uneffect:temporal invariant unsafeLookup: epochs.get(1) === 1 */`)).toThrow(/Map\.get requires a conjunctive .*keys\(\)\.contains\(key\) guard/);
  });

  it("semantically checks scalar Map keys and values with Z3", async () => {
    const temporal = parseSpec("map-z3.ts", `/* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal init epochs = Map([[1, 0]]) */ /* uneffect:temporal action publish: epochs' = epochs.put(2, 1) */ /* uneffect:temporal invariant nonnegative: epochs.values().forall(epoch => epoch >= 0) */ /* uneffect:temporal invariant keysKnown: epochs.keys().forall(node => node === 1 || node === 2) */ /* uneffect:temporal invariant excludedMiddle: epochs.values().forall(epoch => epoch >= 0 || epoch < 0) */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toContainEqual(expect.objectContaining({
      code: "solver-tautology", name: "excludedMiddle", backend: "z3",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));

    const broken = parseSpec("map-z3-broken.ts", `/* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal init epochs = Map([[1, 0]]) */ /* uneffect:temporal action corrupt: epochs' = epochs.put(2, -1) */ /* uneffect:temporal invariant nonnegative: epochs.values().forall(epoch => epoch >= 0) */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "nonnegative", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { initialState: { epochs: [[1, 0]] }, steps: [{ action: "corrupt", after: { epochs: [[1, 0], [2, -1]] } }] },
    });

    const flags = parseSpec("bool-map-z3.ts", `/* uneffect:temporal state flags: Map<bool, bool> */ /* uneffect:temporal init flags = Map([[false, false], [true, false]]) */ /* uneffect:temporal action enable: flags' = flags.put(true, true) */ /* uneffect:temporal invariant booleanValues: flags.values().forall(flag => flag || !flag) */ /* uneffect:temporal invariant bothKeys: flags.keys().contains(false) && flags.keys().contains(true) */ /* uneffect:temporal invariant enabledValue: flags.keys().contains(true) && flags.get(true) === true */`).temporal;
    await expect(lintTemporalSpecWithZ3(flags)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "solver-tautology", name: "booleanValues" }),
    ]));
    await expect(findTemporalCounterexampleWithZ3(flags, "bothKeys", { maxSteps: 2 })).resolves.toEqual({
      status: "safe-within-bound", depth: 2,
    });
    await expect(findTemporalCounterexampleWithZ3(flags, "enabledValue", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 0,
    });

    const dynamic = parseSpec("dynamic-map-z3.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal init epoch = 1 */ /* uneffect:temporal init epochs = Map([[1, 0]]) */ /* uneffect:temporal action publish: epochs' = epochs.put(epoch, 1) */ /* uneffect:temporal invariant empty: !epochs.keys().contains(epoch) */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(dynamic, "empty", { maxSteps: 2 })).resolves.toEqual({ status: "unknown", depth: 0 });
    await expect(lintTemporalReachabilityWithZ3(dynamic, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
  });

  it("executes Set difference and Map key removal in Quint and Z3", async () => {
    const temporal = parseSpec("collection-removal.ts", `/* uneffect:temporal state owners: Set<int> */ /* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal init owners = Set(1, 2) */ /* uneffect:temporal init epochs = Map([[1, 0], [2, 1]]) */ /* uneffect:temporal action revoke: owners' = owners.exclude(Set(2)), epochs' = epochs.remove(2) */ /* uneffect:temporal invariant knownOwners: owners.forall(owner => owner === 1 || owner === 2) */ /* uneffect:temporal invariant ownerTwoPresent: owners.contains(2) */ /* uneffect:temporal invariant epochTwoPresent: epochs.keys().contains(2) */`).temporal;
    const quint = generateQuint("collection_removal", temporal);
    expect(quint).toContain("owners' = owners.exclude(Set(2))");
    expect(quint).toContain("epochs' = epochs.keys().exclude(Set(2)).mapBy(_uneffect_key => epochs.get(_uneffect_key))");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-collection-removal-"));
    const path = join(directory, "removal.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", ["exec", "quint", "run", path, "--invariant=knownOwners", "--max-steps=4", "--max-samples=50"], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    await expect(findTemporalCounterexampleWithZ3(temporal, "ownerTwoPresent", { maxSteps: 1 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { steps: [{ action: "revoke", after: { owners: [1], epochs: [[1, 0]] } }] },
    });
    await expect(findTemporalCounterexampleWithZ3(temporal, "epochTwoPresent", { maxSteps: 1 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
    });
  });

  it("parses and verifies record state with field reads and immutable updates", () => {
    const temporal = parseSpec("records.ts", `/* uneffect:temporal state lease: { owner: int, valid: bool } */ /* uneffect:temporal init lease = { owner: 1, valid: true } */ /* uneffect:temporal action transfer: lease' = { ...lease, owner: 2 } */ /* uneffect:temporal invariant validOwner: !lease.valid || lease.owner > 0 */`).temporal;
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
    const temporal = parseSpec("record-z3.ts", `/* uneffect:temporal state lease: { owner: int, valid: bool } */ /* uneffect:temporal init lease = { owner: 1, valid: true } */ /* uneffect:temporal action transfer: lease' = { ...lease, owner: 2 } */ /* uneffect:temporal invariant validOwner: !lease.valid || lease.owner > 0 */ /* uneffect:temporal invariant booleanValidity: lease.valid || !lease.valid */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.toContainEqual(expect.objectContaining({
      code: "solver-tautology", name: "booleanValidity", backend: "z3",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(temporal, "validOwner", { maxSteps: 2 })).resolves.toEqual({
      status: "safe-within-bound", depth: 2,
    });

    const broken = parseSpec("record-z3-broken.ts", `/* uneffect:temporal state lease: { owner: int, valid: bool } */ /* uneffect:temporal init lease = { owner: 1, valid: true } */ /* uneffect:temporal action invalidate: lease' = { ...lease, owner: 0 } */ /* uneffect:temporal invariant validOwner: !lease.valid || lease.owner > 0 */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "validOwner", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: {
        initialState: { lease: { owner: 1, valid: true } },
        steps: [{ action: "invalidate", after: { lease: { owner: 0, valid: true } } }],
      },
    });

    const nested = parseSpec("nested-record-z3.ts", `/* uneffect:temporal state lease: { owners: Set<int>, valid: bool } */ /* uneffect:temporal init lease = { owners: Set(1), valid: true } */ /* uneffect:temporal invariant valid: lease.valid */`).temporal;
    await expect(lintTemporalSpecWithZ3(nested)).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(nested, "valid", { maxSteps: 1 })).resolves.toEqual({ status: "safe-within-bound", depth: 1 });
  });

  it("nests record values inside finite Maps", async () => {
    const temporal = parseSpec("nested-records.ts", `/* uneffect:temporal state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:temporal init leases = Map([[1, { epoch: 1, valid: true }], [2, { epoch: 0, valid: false }]]) */ /* uneffect:temporal action publish: leases' = leases.put(2, { epoch: 1, valid: true }) */ /* uneffect:temporal invariant validEpochs: leases.values().forall(lease => !lease.valid || lease.epoch > 0) */`).temporal;
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
    const broken = parseSpec("nested-records-broken.ts", `/* uneffect:temporal state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:temporal init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:temporal action corrupt: leases' = leases.put(2, { epoch: -1, valid: true }) */ /* uneffect:temporal invariant validEpochs: leases.values().forall(lease => !lease.valid || lease.epoch > 0) */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "validEpochs", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { steps: [{ action: "corrupt", after: { leases: [[1, { epoch: 1, valid: true }], [2, { epoch: -1, valid: true }]] } }] },
    });
  });

  it("reasons about Set fields inside records without flattening them", async () => {
    const temporal = parseSpec("record-set-z3.ts", `/* uneffect:temporal state lease: { owners: Set<int>, valid: bool } */ /* uneffect:temporal init lease = { owners: Set(1), valid: true } */ /* uneffect:temporal action addOwner: lease' = { ...lease, owners: lease.owners.union(Set(2)) } */ /* uneffect:temporal invariant ownersPositive: lease.owners.forall(owner => owner > 0) */`).temporal;
    await expect(lintTemporalSpecWithZ3(temporal)).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(temporal, "ownersPositive", { maxSteps: 2 })).resolves.toEqual({ status: "safe-within-bound", depth: 2 });
    const broken = parseSpec("record-set-z3-broken.ts", `/* uneffect:temporal state lease: { owners: Set<int>, valid: bool } */ /* uneffect:temporal init lease = { owners: Set(1), valid: true } */ /* uneffect:temporal action addInvalid: lease' = { ...lease, owners: lease.owners.union(Set(-1)) } */ /* uneffect:temporal invariant ownersPositive: lease.owners.forall(owner => owner > 0) */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "ownersPositive", { maxSteps: 2 })).resolves.toMatchObject({
      status: "counterexample", depth: 1,
      trace: { steps: [{ action: "addInvalid", after: { lease: { owners: [-1, 1], valid: true } } }] },
    });

    const recordSet = parseSpec("record-element-set-z3.ts", `/* uneffect:temporal state leases: Set<{ owner: int, valid: bool }> */ /* uneffect:temporal init leases = Set({ owner: 1, valid: true }) */ /* uneffect:temporal invariant validOwners: leases.forall(lease => !lease.valid || lease.owner > 0) */`).temporal;
    await expect(lintTemporalSpecWithZ3(recordSet)).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(lintTemporalReachabilityWithZ3(recordSet, { maxSteps: 1 })).resolves.not.toContainEqual(expect.objectContaining({
      code: "unsupported-backend-domain",
    }));
    await expect(findTemporalCounterexampleWithZ3(recordSet, "validOwners", { maxSteps: 1 })).resolves.toEqual({ status: "safe-within-bound", depth: 1 });
  });
  it("extracts the shortest bounded Z3 trace and replays its actions", async () => {
    const temporal = parseSpec("counter.ts", `/* uneffect:temporal state value: int */ /* uneffect:temporal init value = 0 */ /* uneffect:temporal action increment: value' = value + 1 */ /* uneffect:temporal invariant belowTwo: value < 2 */`).temporal;
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
    const initiallyBroken = parseSpec("initial.ts", `/* uneffect:temporal state ready: bool */ /* uneffect:temporal init ready = false */ /* uneffect:temporal invariant readyNow: ready */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(initiallyBroken, "readyNow", { maxSteps: 3 })).resolves.toMatchObject({
      status: "counterexample", depth: 0, trace: { initialState: { ready: false }, steps: [] },
    });

    const boundedSafe = parseSpec("safe.ts", `/* uneffect:temporal state value: int */ /* uneffect:temporal init value = 0 */ /* uneffect:temporal action increment: value' = value + 1 */ /* uneffect:temporal invariant belowThree: value < 3 */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(boundedSafe, "belowThree", { maxSteps: 2 })).resolves.toEqual({
      status: "safe-within-bound", depth: 2,
    });
  });

  it.runIf(hasJava)("normalizes an actual TLC counterexample when Java is available", () => {
    const temporal = parseSpec("tlc-counter.ts", `/* uneffect:temporal state value: int */ /* uneffect:temporal init value = 0 */ /* uneffect:temporal action increment: value' = value + 1 */ /* uneffect:temporal invariant belowTwo: value < 2 */`).temporal;
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
    expect(() => parseSpec("broken.ts", `\n/* uneffect:capability effect Fetch<GET */\nfunction f() {}`))
      .toThrow(/broken\.ts:2:\d+: invalid effect/);
  });

  it("rejects an unsupported Uneffect directive instead of ignoring it", () => {
    expect(() => parseSpec("broken.ts", `/* uneffect:temporal effects Console */\nfunction f() {}`))
      .toThrow(/broken\.ts:1:\d+: Uneffect directive `effects` is not valid in an `uneffect:temporal` block/);
  });

  it("rejects an empty member in an effect union", () => {
    expect(() => parseSpec("broken.ts", `/* uneffect:capability effect Console | */\nfunction f() {}`))
      .toThrow(/broken\.ts:1:\d+: empty member/);
  });

  it("preserves an explicit empty effect declaration and rejects mixed none unions", () => {
    expect(parseSpec("pure.ts", `/* uneffect:capability effect none */\nfunction pure() {}`)).toMatchObject({
      capabilities: [{ functionName: "pure", effects: [] }],
    });
    expect(() => parseSpec("broken.ts", `/* uneffect:capability effect none | Console */\nfunction f() {}`))
      .toThrow(/broken\.ts:1:\d+: `none` must be the only member of an effect set/);
    expect(() => parseSpec("broken.ts", `/*\n * uneffect:capability\n * effect none\n * effect Console\n */\nfunction f() {}`))
      .toThrow(/broken\.ts:3:\d+: `none` cannot be combined with another effect declaration/);
  });

  it("generates an SMT-LIB proof obligation accepted as unsat by Z3", async () => {
    const fn = parseSpec("input.ts", source).invariants[0]!;
    const smt = generateSmtLib(fn);
    expect(smt).toContain("(assert (= result (+ x 1)))");
    const context = await createZ3Context("spec_backends_test");
    const solver = new context.Solver();
    solver.fromString(smt);
    expect(String(await solver.check())).toBe("unsat");
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
      /* uneffect:temporal clock clock: 1 */ /* uneffect:temporal state pending: bool */ /* uneffect:temporal state deadline: int */ /* uneffect:temporal init pending = false */ /* uneffect:temporal init deadline = 0 */ /* uneffect:temporal action release: pending' = true, deadline' = clock + 3 */ /* uneffect:temporal action_when release: !pending */ /* uneffect:temporal action complete: pending' = false */ /* uneffect:temporal action_when complete: pending && clock <= deadline */ ${guarded ? "/* uneffect:temporal action_when tick_clock: !pending || clock < deadline */" : ""} /* uneffect:temporal action_fair tick_clock: weak */ /* uneffect:temporal invariant deadlineSafe: !pending || clock <= deadline */
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

  it("parses a TypeScript-style response property and lowers it to Quint leads-to", () => {
    const temporal = parseSpec("response.ts", `/* uneffect:temporal state pending: bool */ /* uneffect:temporal init pending = false */ /* uneffect:temporal action release: pending' = true */ /* uneffect:temporal action_when release: !pending */ /* uneffect:temporal action complete: pending' = false */ /* uneffect:temporal action_when complete: pending */ /* uneffect:temporal response requestCompletes: pending => !pending */`).temporal;
    expect(temporal.responses).toEqual([expect.objectContaining({
      name: "requestCompletes",
      trigger: "pending",
      response: "!pending",
    })]);
    const quint = generateQuint("response", temporal);
    expect(quint).toContain(
      "temporal requestCompletes = pending leadsTo not(pending)",
    );
    const directory = mkdtempSync(join(tmpdir(), "uneffect-response-"));
    const path = join(directory, "response.qnt");
    writeFileSync(path, quint);
    const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", path], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
    expect(() => parseSpec("broken-response.ts", `/* uneffect:temporal state pending: bool */ /* uneffect:temporal response requestCompletes: pending */`)).toThrow(/expected trigger => response/);
    expect(() => parseSpec("typed-response.ts", `/* uneffect:temporal state attempts: int */ /* uneffect:temporal state done: bool */ /* uneffect:temporal response completes: attempts => done */`)).toThrow(/response trigger .* must be boolean/);
  });

  it("parses a typed recurrence property and lowers it to always-eventually", () => {
    const temporal = parseSpec("recurrence.ts", `/* uneffect:temporal state idle: bool */ /* uneffect:temporal init idle = true */ /* uneffect:temporal action toggle: idle' = !idle */ /* uneffect:temporal repeatedly returnsIdle: idle */`).temporal;
    expect(temporal.recurrences).toEqual([expect.objectContaining({
      name: "returnsIdle",
      expression: "idle",
    })]);
    const quint = generateQuint("recurrence", temporal);
    expect(quint).toContain("temporal returnsIdle = always(eventually(idle))");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-recurrence-"));
    const path = join(directory, "recurrence.qnt");
    writeFileSync(path, quint);
    const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", path], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
    expect(() => parseSpec("typed-recurrence.ts", `/* uneffect:temporal state attempts: int */ /* uneffect:temporal repeatedly retries: attempts */`)).toThrow(/recurrence property .* must be boolean/);
  });

  it("parses a typed stabilization property and lowers it to eventually-always", () => {
    const temporal = parseSpec("stabilization.ts", `/* uneffect:temporal state drained: bool */ /* uneffect:temporal init drained = false */ /* uneffect:temporal action finish: drained' = true */ /* uneffect:temporal stabilizes remainsDrained: drained */`).temporal;
    expect(temporal.stabilizations).toEqual([expect.objectContaining({
      name: "remainsDrained",
      expression: "drained",
    })]);
    const quint = generateQuint("stabilization", temporal);
    expect(quint).toContain("temporal remainsDrained = eventually(always(drained))");
    const directory = mkdtempSync(join(tmpdir(), "uneffect-stabilization-"));
    const path = join(directory, "stabilization.qnt");
    writeFileSync(path, quint);
    const typecheck = spawnSync("pnpm", ["exec", "quint", "typecheck", path], { encoding: "utf8", timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
    expect(() => parseSpec("typed-stabilization.ts", `/* uneffect:temporal state remaining: int */ /* uneffect:temporal stabilizes drains: remaining */`)).toThrow(/stabilization property .* must be boolean/);
  });

  it("protects structured clocks from arbitrary writes", () => {
    expect(() => parseSpec("clock.ts", `/* uneffect:temporal clock now: 0 */`)).toThrow(/granularity must be a positive integer/);
    expect(() => parseSpec("clock.ts", `/* uneffect:temporal clock now: 1 */ /* uneffect:temporal action rewind: now' = now - 1 */`)).toThrow(/only generated action `tick_now` may update clock `now`/);
    expect(() => parseSpec("clock.ts", `/* uneffect:temporal clock now: 1 */ /* uneffect:temporal init now = 10 */`)).toThrow(/clock `now` has an implicit zero init/);
  });

  it("reports syntactically valid but meaningless temporal declarations", () => {
    const result = lintSpec("meaningless.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal action idle: epoch' = epoch */ /* uneffect:temporal invariant tautology: epoch === epoch */ /* uneffect:temporal invariant contradiction: epoch !== epoch */ /* uneffect:temporal response neverStarts: false => epoch === 1 */ /* uneffect:temporal response alreadyDone: epoch === 0 => epoch === 0 */`);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "tautological-invariant", name: "tautology" }),
      expect.objectContaining({ code: "contradictory-invariant", name: "contradiction" }),
      expect.objectContaining({ code: "no-op-action", name: "idle" }),
      expect.objectContaining({ code: "unsatisfiable-response-trigger", name: "neverStarts" }),
      expect.objectContaining({ code: "statewise-vacuous-response", name: "alreadyDone" }),
    ]));
  });

  it("uses Z3 to reject semantic tautologies, contradictions, inconsistent init, unreachable guards, and subsumed properties", async () => {
    const temporal = parseSpec("semantic-lint.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal state ready: bool */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal init epoch = 1 */ /* uneffect:temporal init ready = false */ /* uneffect:temporal action impossible: ready' = true */ /* uneffect:temporal action_when impossible: epoch > 0 && epoch <= 0 */ /* uneffect:temporal invariant totalOrder: epoch > 0 || epoch <= 0 */ /* uneffect:temporal invariant impossibleState: epoch > 0 && epoch <= 0 */ /* uneffect:temporal invariant positive: epoch > 0 */ /* uneffect:temporal invariant nonnegative: epoch >= 0 */ /* uneffect:temporal invariant positiveAgain: epoch > 0 */`).temporal;
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

  it("uses Z3 to reject response properties with impossible or immediately satisfied triggers", async () => {
    const temporal = parseSpec("response-vacuity.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal action advance: epoch' = epoch + 1 */ /* uneffect:temporal response impossible: epoch < 0 && epoch >= 0 => epoch === 0 */ /* uneffect:temporal response immediate: epoch > 0 => epoch >= 0 */ /* uneffect:temporal response meaningful: epoch > 0 => epoch === 0 */`).temporal;
    const diagnostics = await lintTemporalSpecWithZ3(temporal);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "unsatisfiable-response-trigger", name: "impossible", backend: "z3",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "statewise-vacuous-response", name: "immediate", backend: "z3",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "statewise-vacuous-response", name: "meaningful",
    }));
  });

  it("rejects impossible and statewise-vacuous recurrence targets", async () => {
    const temporal = parseSpec("recurrence-vacuity.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal action advance: epoch' = epoch + 1 */ /* uneffect:temporal repeatedly impossible: epoch < 0 && epoch >= 0 */ /* uneffect:temporal repeatedly automatic: epoch > 0 || epoch <= 0 */ /* uneffect:temporal repeatedly meaningful: epoch === 0 */`).temporal;
    const diagnostics = await lintTemporalSpecWithZ3(temporal);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "unsatisfiable-recurrence-target", name: "impossible", backend: "z3",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "statewise-vacuous-recurrence", name: "automatic", backend: "z3",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "meaningful" }));
  });

  it("rejects impossible and statewise-vacuous stabilization targets", async () => {
    const temporal = parseSpec("stabilization-vacuity.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal action advance: epoch' = epoch + 1 */ /* uneffect:temporal stabilizes impossible: epoch < 0 && epoch >= 0 */ /* uneffect:temporal stabilizes automatic: epoch > 0 || epoch <= 0 */ /* uneffect:temporal stabilizes meaningful: epoch === 0 */`).temporal;
    const diagnostics = await lintTemporalSpecWithZ3(temporal);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "unsatisfiable-stabilization-target", name: "impossible", backend: "z3",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "statewise-vacuous-stabilization", name: "automatic", backend: "z3",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "meaningful" }));
  });

  it("combines syntax and solver diagnostics from source text", async () => {
    const result = await lintSpecWithZ3("combined-lint.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal action idle: epoch' = epoch */ /* uneffect:temporal invariant totalOrder: epoch > 0 || epoch <= 0 */`);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "no-op-action", name: "idle" }),
      expect.objectContaining({ code: "solver-tautology", name: "totalOrder", backend: "z3" }),
    ]));
  });

  it("distinguishes bounded transition reachability from globally satisfiable guards", async () => {
    const temporal = parseSpec("reachability.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action advance: phase' = 1 */ /* uneffect:temporal action_when advance: phase === 0 */ /* uneffect:temporal action finish: phase' = 2 */ /* uneffect:temporal action_when finish: phase === 1 */ /* uneffect:temporal action never: phase' = 3 */ /* uneffect:temporal action_when never: phase === 99 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "bounded-unreachable-action", name: "never", depth: 3 }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "advance" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "finish" }));
  });

  it("upgrades an unreachable action only when one-step induction proves it", async () => {
    const temporal = parseSpec("inductive-unreachable.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action advance: phase' = phase + 1 */ /* uneffect:temporal action_when advance: phase >= 0 */ /* uneffect:temporal action negative: phase' = 0 */ /* uneffect:temporal action_when negative: phase < 0 */ /* uneffect:temporal action distant: phase' = phase */ /* uneffect:temporal action_when distant: phase === 99 */`).temporal;
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

  it("accepts only proven inductive properties as strengthening invariants", async () => {
    const temporal = parseSpec("strengthened-unreachable.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action descend: phase' = phase - 1 */ /* uneffect:temporal action impossible: phase' = phase */ /* uneffect:temporal action_when impossible: phase === 2 */ /* uneffect:temporal invariant nonpositive: phase <= 0 */ /* uneffect:temporal invariant merelyInitial: phase === 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 3,
      strengtheningProperties: ["nonpositive", "merelyInitial"],
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action", name: "impossible", relatedName: "nonpositive",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "non-inductive-strengthening-property", name: "merelyInitial",
    }));
  });

  it("discovers declared inductive properties as strengthening candidates", async () => {
    const temporal = parseSpec("discovered-strengthening.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action descend: phase' = phase - 1 */ /* uneffect:temporal action recoverMalformed: phase' = 2 */ /* uneffect:temporal action_when recoverMalformed: phase > 1 */ /* uneffect:temporal action impossible: phase' = phase */ /* uneffect:temporal action_when impossible: phase === 2 */ /* uneffect:temporal invariant nonpositive: phase <= 0 */ /* uneffect:temporal invariant notInvariant: phase === 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      discoverStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action", name: "impossible", relatedName: "nonpositive",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "non-inductive-strengthening-property", name: "notInvariant",
    }));
  });

  it("synthesizes and proves simple sign strengthening invariants", async () => {
    const temporal = parseSpec("synthesized-strengthening.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action descend: phase' = phase - 1 */ /* uneffect:temporal action recoverMalformed: phase' = 2 */ /* uneffect:temporal action_when recoverMalformed: phase > 1 */ /* uneffect:temporal action impossible: phase' = phase */ /* uneffect:temporal action_when impossible: phase === 2 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:phase <= 0>",
    }));
  });

  it("synthesizes relational strengthening invariants separately", async () => {
    const temporal = parseSpec("relational-strengthening.ts", `/* uneffect:temporal state left: int */ /* uneffect:temporal state right: int */ /* uneffect:temporal init left = 0 */ /* uneffect:temporal init right = 0 */ /* uneffect:temporal action descendTogether: left' = left - 1, right' = right - 1 */ /* uneffect:temporal action corruptMalformed: left' = right - 1 */ /* uneffect:temporal action_when corruptMalformed: left > right */ /* uneffect:temporal action impossible: left' = left */ /* uneffect:temporal action_when impossible: left < right */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:left === right>",
    }));
  });

  it("synthesizes initial-difference affine strengthening invariants", async () => {
    const temporal = parseSpec("affine-strengthening.ts", `/* uneffect:temporal state left: int */ /* uneffect:temporal state right: int */ /* uneffect:temporal init left = 2 */ /* uneffect:temporal init right = 0 */ /* uneffect:temporal action descendTogether: left' = left - 1, right' = right - 1 */ /* uneffect:temporal action corruptMalformed: left' = right */ /* uneffect:temporal action_when corruptMalformed: left > right + 2 */ /* uneffect:temporal action impossible: left' = left */ /* uneffect:temporal action_when impossible: left < right + 2 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:left === right + 2>",
    }));
  });

  it("synthesizes small-coefficient affine strengthening invariants", async () => {
    const temporal = parseSpec("scaled-affine-strengthening.ts", `/* uneffect:temporal state used: int */ /* uneffect:temporal state capacity: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init used = 1 */ /* uneffect:temporal init capacity = 2 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action allocateBalanced: used' = used + 1, capacity' = capacity + 2 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && 2 * used > capacity */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:2 * used === capacity>",
    }));
  });

  it("synthesizes explicitly bounded larger affine coefficients", async () => {
    const temporal = parseSpec("bounded-affine-strengthening.ts", `/* uneffect:temporal state used: int */ /* uneffect:temporal state capacity: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init used = 1 */ /* uneffect:temporal init capacity = 3 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action allocateBalanced: used' = used + 1, capacity' = capacity + 3 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && 3 * used > capacity */`).temporal;
    const defaults = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(defaults).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:3 * used === capacity>",
    }));
    const expanded = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxCoefficient: 3,
    });
    expect(expanded).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:3 * used === capacity>",
    }));
  });

  it("synthesizes pairwise affine sum conservation", async () => {
    const temporal = parseSpec("pairwise-sum-strengthening.ts", `/* uneffect:temporal state used: int */ /* uneffect:temporal state remaining: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init used = 1 */ /* uneffect:temporal init remaining = 9 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action consume: used' = used + 1, remaining' = remaining - 1 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && used + remaining !== 10 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:used + remaining === 10>",
    }));
  });

  it("exposes the affine coefficient bound through the CLI", () => {
    const expanded = spawnSync("pnpm", ["tsx", "src/cli.ts", "spec", "lint", "examples/dogfood/telemetry-capacity.ts",
      "--synthesize-relational-strengthening", "--relational-max-coefficient=3"], {
      encoding: "utf8", timeout: 30_000,
    });
    expect(expanded.stdout).toContain("<synth:3 * accepted === byteBudget>");
    const invalid = spawnSync("pnpm", ["tsx", "src/cli.ts", "spec", "lint", "examples/dogfood/telemetry-capacity.ts",
      "--synthesize-relational-strengthening", "--relational-max-coefficient=9"], {
      encoding: "utf8", timeout: 30_000,
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("--relational-max-coefficient must be an integer between 1 and 8");
  });

  it("synthesizes three-variable conservation equalities", async () => {
    const temporal = parseSpec("conservation-strengthening.ts", `/* uneffect:temporal state accepted: int */ /* uneffect:temporal state rejected: int */ /* uneffect:temporal state total: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init accepted = 0 */ /* uneffect:temporal init rejected = 0 */ /* uneffect:temporal init total = 0 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action accept: accepted' = accepted + 1, total' = total + 1 */ /* uneffect:temporal action reject: rejected' = rejected + 1, total' = total + 1 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && accepted + rejected < total */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:accepted + rejected === total>",
    }));
  });

  it("prioritizes an initial equality boundary from a strict unreachable guard", async () => {
    const temporal = parseSpec("guarded-conservation-seed.ts", `/* uneffect:temporal state accepted: int */ /* uneffect:temporal state rejected: int */ /* uneffect:temporal state attempted: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init accepted = 0 */ /* uneffect:temporal init rejected = 0 */ /* uneffect:temporal init attempted = 0 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action accept: accepted' = accepted + 1, attempted' = attempted + 1 */ /* uneffect:temporal action reject: rejected' = rejected + 1, attempted' = attempted + 1 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && accepted + rejected < attempted */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningCandidateLimit: 1,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:accepted + rejected === attempted>",
    }));
  });

  it("synthesizes bounded weighted conservation equalities", async () => {
    const temporal = parseSpec("weighted-conservation-strengthening.ts", `/* uneffect:temporal state accepted: int */ /* uneffect:temporal state rejected: int */ /* uneffect:temporal state attempted: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init accepted = 0 */ /* uneffect:temporal init rejected = 0 */ /* uneffect:temporal init attempted = 0 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action accept: accepted' = accepted + 1, attempted' = attempted + 2 */ /* uneffect:temporal action reject: rejected' = rejected + 1, attempted' = attempted + 1 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && 2 * accepted + rejected !== attempted */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:2 * accepted + rejected === attempted>",
    }));
  });

  it("synthesizes multi-variable fixed-budget equalities", async () => {
    const temporal = parseSpec("fixed-budget-strengthening.ts", `/* uneffect:temporal state active: int */ /* uneffect:temporal state queued: int */ /* uneffect:temporal state remaining: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init active = 1 */ /* uneffect:temporal init queued = 2 */ /* uneffect:temporal init remaining = 7 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action activate: active' = active + 1, remaining' = remaining - 1 */ /* uneffect:temporal action enqueue: queued' = queued + 1, remaining' = remaining - 1 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && active + queued + remaining !== 10 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:active + queued + remaining === 10>",
    }));
  });

  it("keeps guard-seeded affine coefficients within the configured bound", async () => {
    const temporal = parseSpec("guard-seed-coefficient-bound.ts", `/* uneffect:temporal state used: int */ /* uneffect:temporal state capacity: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init used = 0 */ /* uneffect:temporal init capacity = 0 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action consume: used' = used + 1, capacity' = capacity + 3 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && 3 * used !== capacity */`).temporal;
    const bounded = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(bounded).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:3 * used === capacity>",
    }));
    const expanded = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxCoefficient: 3,
    });
    expect(expanded).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      relatedName: "<synth:3 * used === capacity>",
    }));
  });

  it("synthesizes bounded four-variable conservation equalities when requested", async () => {
    const temporal = parseSpec("four-counter-conservation-strengthening.ts", `/* uneffect:temporal state accepted: int */ /* uneffect:temporal state dropped: int */ /* uneffect:temporal state retried: int */ /* uneffect:temporal state attempted: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init accepted = 0 */ /* uneffect:temporal init dropped = 0 */ /* uneffect:temporal init retried = 0 */ /* uneffect:temporal init attempted = 0 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action accept: accepted' = accepted + 1, attempted' = attempted + 1 */ /* uneffect:temporal action drop: dropped' = dropped + 1, attempted' = attempted + 1 */ /* uneffect:temporal action retry: retried' = retried + 1, attempted' = attempted + 1 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && accepted + dropped + retried < attempted */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxArity: 4,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:accepted + dropped + retried === attempted>",
    }));
  });

  it("keeps relational conservation synthesis capped at three variables by default", async () => {
    const temporal = parseSpec("capped-conservation-strengthening.ts", `/* uneffect:temporal state accepted: int */ /* uneffect:temporal state dropped: int */ /* uneffect:temporal state retried: int */ /* uneffect:temporal state attempted: int */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init accepted = 0 */ /* uneffect:temporal init dropped = 0 */ /* uneffect:temporal init retried = 0 */ /* uneffect:temporal init attempted = 0 */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action accept: accepted' = accepted + 1, attempted' = attempted + 1 */ /* uneffect:temporal action drop: dropped' = dropped + 1, attempted' = attempted + 1 */ /* uneffect:temporal action retry: retried' = retried + 1, attempted' = attempted + 1 */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && accepted + dropped + retried < attempted */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
    });
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
    }));

    const candidateDisabledDiagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxArity: 4,
      relationalStrengtheningCandidateLimit: 0,
    });
    expect(candidateDisabledDiagnostics).not.toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
    }));

    const prioritizedDiagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeRelationalStrengtheningProperties: true,
      relationalStrengtheningMaxArity: 4,
      relationalStrengtheningCandidateLimit: 1,
    });
    expect(prioritizedDiagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:accepted + dropped + retried === attempted>",
    }));
  });

  it("synthesizes equality invariants for collection state pairs", async () => {
    const temporal = parseSpec("collection-strengthening.ts", `/* uneffect:temporal state left: Set<int> */ /* uneffect:temporal state right: Set<int> */ /* uneffect:temporal init left = Set(1) */ /* uneffect:temporal init right = Set(1) */ /* uneffect:temporal action growTogether: left' = left.union(Set(3)), right' = right.union(Set(3)) */ /* uneffect:temporal action corruptMalformed: left' = left.union(Set(2)) */ /* uneffect:temporal action_when corruptMalformed: left.contains(9) && !right.contains(9) */ /* uneffect:temporal action impossible: left' = left */ /* uneffect:temporal action_when impossible: left.contains(2) && !right.contains(2) */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeCollectionStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:left === right>",
    }));
  });

  it("synthesizes directional subset invariants for Set state pairs", async () => {
    const temporal = parseSpec("set-subset-strengthening.ts", `/* uneffect:temporal state requested: Set<int> */ /* uneffect:temporal state allowed: Set<int> */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init requested = Set(1) */ /* uneffect:temporal init allowed = Set(1, 2) */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action requestAllowed: requested' = requested.union(Set(2)) */ /* uneffect:temporal action_when requestAllowed: allowed.contains(2) */ /* uneffect:temporal action expandAuthority: allowed' = allowed.union(Set(3)) */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: requested' = requested */ /* uneffect:temporal action_when impossible: armed && requested.contains(2) && !allowed.contains(2) */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeCollectionStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:requested subset allowed>",
    }));
  });

  it("synthesizes subset invariants between Set fields in one record state", async () => {
    const temporal = parseSpec("record-set-subset-strengthening.ts", `/* uneffect:temporal state authority: { requested: Set<int>, allowed: Set<int> } */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init authority = { requested: Set(1), allowed: Set(1, 2) } */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action requestAllowed: authority' = { ...authority, requested: authority.requested.union(Set(2)) } */ /* uneffect:temporal action_when requestAllowed: authority.allowed.contains(2) */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossible: armed' = armed */ /* uneffect:temporal action_when impossible: armed && authority.requested.contains(2) && !authority.allowed.contains(2) */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeCollectionStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossible",
      relatedName: "<synth:authority.requested subset authority.allowed>",
    }));
  });

  it("synthesizes subset invariants from Map key and scalar value domains", async () => {
    const temporal = parseSpec("map-domain-subset-strengthening.ts", `/* uneffect:temporal state allocated: Set<int> */ /* uneffect:temporal state allowedOwners: Set<int> */ /* uneffect:temporal state owners: Map<int, int> */ /* uneffect:temporal state armed: bool */ /* uneffect:temporal init allocated = Set(1, 2) */ /* uneffect:temporal init allowedOwners = Set(10, 20) */ /* uneffect:temporal init owners = Map([[1, 10]]) */ /* uneffect:temporal init armed = false */ /* uneffect:temporal action assignAllocated: owners' = owners.put(2, 20) */ /* uneffect:temporal action_when assignAllocated: allocated.contains(2) && allowedOwners.contains(20) */ /* uneffect:temporal action arm: armed' = true */ /* uneffect:temporal action impossibleResource: armed' = armed */ /* uneffect:temporal action_when impossibleResource: armed && owners.keys().contains(2) && !allocated.contains(2) */ /* uneffect:temporal action impossibleOwner: armed' = armed */ /* uneffect:temporal action_when impossibleOwner: armed && owners.values().contains(20) && !allowedOwners.contains(20) */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      synthesizeCollectionStrengtheningProperties: true,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossibleResource",
      relatedName: "<synth:owners.keys() subset allocated>",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action",
      name: "impossibleOwner",
      relatedName: "<synth:owners.values() subset allowedOwners>",
    }));
  });

  it("combines proven strengthening invariants when no single property excludes a guard", async () => {
    const temporal = parseSpec("combined-strengthening.ts", `/* uneffect:temporal state left: int */ /* uneffect:temporal state right: int */ /* uneffect:temporal init left = 0 */ /* uneffect:temporal init right = 0 */ /* uneffect:temporal action descendLeft: left' = left - 1 */ /* uneffect:temporal action descendRight: right' = right - 1 */ /* uneffect:temporal action growOutsideInvariant: left' = left + 1 */ /* uneffect:temporal action_when growOutsideInvariant: left > 0 */ /* uneffect:temporal action impossible: left' = left */ /* uneffect:temporal action_when impossible: left + right > 0 */ /* uneffect:temporal invariant leftNonpositive: left <= 0 */ /* uneffect:temporal invariant rightNonpositive: right <= 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      strengtheningProperties: ["leftNonpositive", "rightNonpositive"],
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-action", name: "impossible",
      relatedName: "leftNonpositive & rightNonpositive",
    }));
  });

  it("uses a complete finite-state bound to prove unreachable boolean states", async () => {
    const temporal = parseSpec("finite-complete.ts", `/* uneffect:temporal state left: bool */ /* uneffect:temporal state right: bool */ /* uneffect:temporal init left = false */ /* uneffect:temporal init right = false */ /* uneffect:temporal action toggle: left' = !left, right' = !right */ /* uneffect:temporal action_when toggle: left === right */ /* uneffect:temporal action unreachableBridge: left' = false, right' = true */ /* uneffect:temporal action_when unreachableBridge: left && !right */ /* uneffect:temporal action observeMismatch: left' = left */ /* uneffect:temporal action_when observeMismatch: !left && right */`).temporal;
    const complete = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(complete).toContainEqual(expect.objectContaining({
      code: "finite-state-unreachable-action", name: "observeMismatch", depth: 3,
    }));
    const incomplete = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 });
    expect(incomplete).not.toContainEqual(expect.objectContaining({
      code: "finite-state-unreachable-action", name: "observeMismatch",
    }));
  });

  it("proves an initial deadlock without claiming unbounded reachability", async () => {
    const temporal = parseSpec("deadlock.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action advance: phase' = 1 */ /* uneffect:temporal action_when advance: phase > 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "deadlocked-initial-state", name: "<init>" }));
  });

  it("finds the shortest reachable deadlock within the explicit bound", async () => {
    const temporal = parseSpec("later-deadlock.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action advance: phase' = phase + 1 */ /* uneffect:temporal action_when advance: phase < 2 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 4 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-reachable-deadlock", name: "<deadlock>", depth: 2,
    }));
  });

  it("finds a reachable state where every enabled action only stutters", async () => {
    const temporal = parseSpec("later-stutter.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action advance: phase' = 1 */ /* uneffect:temporal action_when advance: phase === 0 */ /* uneffect:temporal action idle: phase' = phase */ /* uneffect:temporal action_when idle: phase === 1 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-no-state-progress", name: "<progress>", depth: 1,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "reachable-stutter-cycle", name: "<liveness>", depth: 1,
      message: expect.stringContaining("fairness"),
    }));
  });

  it("finds liveness lassos and respects weak action fairness", async () => {
    const model = (fair: boolean) => parseSpec("liveness-lasso.ts", `/* uneffect:temporal state done: bool */ /* uneffect:temporal init done = false */ /* uneffect:temporal action idle: done' = done */ /* uneffect:temporal action finish: done' = true */ /* uneffect:temporal action_when finish: !done */ /* uneffect:temporal ${fair ? "action_fair finish: weak" : ""} */ /* uneffect:temporal eventually completes: done */`).temporal;
    const unfair = await lintTemporalReachabilityWithZ3(model(false), { maxSteps: 2 });
    expect(unfair).toContainEqual(expect.objectContaining({
      code: "reachable-liveness-cycle", name: "completes", depth: 1, loopStart: 0,
    }));
    expect(unfair).not.toContainEqual(expect.objectContaining({
      code: "initially-vacuous-liveness", name: "completes",
    }));
    const fair = await lintTemporalReachabilityWithZ3(model(true), { maxSteps: 2 });
    expect(fair).not.toContainEqual(expect.objectContaining({
      code: "reachable-liveness-cycle", name: "completes",
    }));
  });

  it("reports an eventuality already guaranteed by every initial state as temporally vacuous", async () => {
    const temporal = parseSpec("initial-eventuality.ts", `/* uneffect:temporal state done: bool */ /* uneffect:temporal init done = true */ /* uneffect:temporal action reset: done' = false */ /* uneffect:temporal eventually completes: done */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "initially-vacuous-liveness", name: "completes", backend: "z3", depth: 0,
    }));
  });

  it("finds a response-property lasso and discharges it only with matching weak fairness", async () => {
    const model = (fair: boolean) => parseSpec("response-lasso.ts", `/* uneffect:temporal state pending: bool */ /* uneffect:temporal init pending = false */ /* uneffect:temporal action release: pending' = true */ /* uneffect:temporal action_when release: !pending */ /* uneffect:temporal action idle: pending' = pending */ /* uneffect:temporal action_when idle: pending */ /* uneffect:temporal action complete: pending' = false */ /* uneffect:temporal action_when complete: pending */ /* uneffect:temporal ${fair ? "action_fair complete: weak" : ""} */ /* uneffect:temporal response requestCompletes: pending => !pending */`).temporal;
    await expect(lintTemporalReachabilityWithZ3(model(false), { maxSteps: 3 })).resolves.toContainEqual(
      expect.objectContaining({
        code: "reachable-response-cycle", name: "requestCompletes", depth: 2, loopStart: 1, triggerDepth: 1,
      }),
    );
    await expect(lintTemporalReachabilityWithZ3(model(true), { maxSteps: 3 })).resolves.not.toContainEqual(
      expect.objectContaining({ code: "reachable-response-cycle", name: "requestCompletes" }),
    );
  });

  it("finds a recurrence lasso and discharges it only with matching weak fairness", async () => {
    const model = (fair: boolean) => parseSpec("recurrence-lasso.ts", `/* uneffect:temporal state idle: bool */ /* uneffect:temporal init idle = true */ /* uneffect:temporal action start: idle' = false */ /* uneffect:temporal action_when start: idle */ /* uneffect:temporal action wait: idle' = idle */ /* uneffect:temporal action_when wait: !idle */ /* uneffect:temporal action complete: idle' = true */ /* uneffect:temporal action_when complete: !idle */ /* uneffect:temporal ${fair ? "action_fair complete: weak" : ""} */ /* uneffect:temporal repeatedly returnsIdle: idle */`).temporal;
    await expect(lintTemporalReachabilityWithZ3(model(false), { maxSteps: 3 })).resolves.toContainEqual(
      expect.objectContaining({ code: "reachable-recurrence-cycle", name: "returnsIdle", depth: 2, loopStart: 1 }),
    );
    await expect(lintTemporalReachabilityWithZ3(model(true), { maxSteps: 3 })).resolves.not.toContainEqual(
      expect.objectContaining({ code: "reachable-recurrence-cycle", name: "returnsIdle" }),
    );
  });

  it("finds a stabilization lasso and discharges it only with matching weak fairness", async () => {
    const model = (fair: boolean) => parseSpec("stabilization-lasso.ts", `/* uneffect:temporal state settled: bool */ /* uneffect:temporal state stable: bool */ /* uneffect:temporal init settled = false */ /* uneffect:temporal init stable = false */ /* uneffect:temporal action churn: stable' = !stable */ /* uneffect:temporal action_when churn: !settled */ /* uneffect:temporal action settle: settled' = true, stable' = true */ /* uneffect:temporal action_when settle: !settled */ /* uneffect:temporal action idle: settled' = settled, stable' = stable */ /* uneffect:temporal action_when idle: settled */ /* uneffect:temporal ${fair ? "action_fair settle: weak" : ""} */ /* uneffect:temporal stabilizes converges: stable */`).temporal;
    await expect(lintTemporalReachabilityWithZ3(model(false), { maxSteps: 3 })).resolves.toContainEqual(
      expect.objectContaining({ code: "reachable-stabilization-cycle", name: "converges", depth: 2, loopStart: 0 }),
    );
    await expect(lintTemporalReachabilityWithZ3(model(true), { maxSteps: 3 })).resolves.not.toContainEqual(
      expect.objectContaining({ code: "reachable-stabilization-cycle", name: "converges" }),
    );
  });

  it("distinguishes globally satisfiable response triggers from transition-reachable triggers", async () => {
    const temporal = parseSpec("unreachable-response-trigger.ts", `/* uneffect:temporal state epoch: int */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal action advance: epoch' = epoch + 1 */ /* uneffect:temporal action_when advance: epoch < 2 */ /* uneffect:temporal response impossible: epoch < 0 => epoch === 0 */ /* uneffect:temporal response reached: epoch === 2 => epoch === 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-unreachable-response-trigger", name: "impossible", depth: 3,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "inductively-unreachable-response-trigger", name: "impossible", depth: 1,
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      code: "bounded-unreachable-response-trigger", name: "reached",
    }));

    const finite = parseSpec("finite-unreachable-response-trigger.ts", `/* uneffect:temporal state active: bool */ /* uneffect:temporal init active = false */ /* uneffect:temporal action idle: active' = false */ /* uneffect:temporal response activated: active => false */`).temporal;
    await expect(lintTemporalReachabilityWithZ3(finite, { maxSteps: 1 })).resolves.toContainEqual(
      expect.objectContaining({ code: "finite-state-unreachable-response-trigger", name: "activated", depth: 1 }),
    );
  });

  it("distinguishes globally satisfiable recurrence and stabilization targets from reachable targets", async () => {
    const temporal = parseSpec("unreachable-progress-targets.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action idle: phase' = 0 */ /* uneffect:temporal repeatedly returnsToOne: phase === 1 */ /* uneffect:temporal stabilizes settlesAtTwo: phase === 2 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-unreachable-recurrence-target", name: "returnsToOne", depth: 2,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "inductively-unreachable-recurrence-target", name: "returnsToOne", depth: 1,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "bounded-unreachable-stabilization-target", name: "settlesAtTwo", depth: 2,
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "inductively-unreachable-stabilization-target", name: "settlesAtTwo", depth: 1,
    }));

    const finite = parseSpec("finite-unreachable-progress-targets.ts", `/* uneffect:temporal state active: bool */ /* uneffect:temporal init active = false */ /* uneffect:temporal action idle: active' = false */ /* uneffect:temporal repeatedly activeAgain: active */ /* uneffect:temporal stabilizes remainsActive: active */`).temporal;
    const finiteDiagnostics = await lintTemporalReachabilityWithZ3(finite, { maxSteps: 1 });
    expect(finiteDiagnostics).toContainEqual(expect.objectContaining({
      code: "finite-state-unreachable-recurrence-target", name: "activeAgain", depth: 1,
    }));
    expect(finiteDiagnostics).toContainEqual(expect.objectContaining({
      code: "finite-state-unreachable-stabilization-target", name: "remainsActive", depth: 1,
    }));
  });

  it("uses proven strengthening to exclude recurrence and stabilization targets", async () => {
    const temporal = parseSpec("strengthened-progress-targets.ts", `/* uneffect:temporal state gate: int */ /* uneffect:temporal state value: int */ /* uneffect:temporal init gate = 0 */ /* uneffect:temporal init value = 0 */ /* uneffect:temporal action hiddenDecrease: value' = value - 1 */ /* uneffect:temporal action_when hiddenDecrease: gate < 0 */ /* uneffect:temporal invariant gateNonnegative: gate >= 0 */ /* uneffect:temporal repeatedly negativeAgain: value < 0 */ /* uneffect:temporal stabilizes staysNegative: value < 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      strengtheningProperties: ["gateNonnegative"],
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-recurrence-target", name: "negativeAgain", relatedName: "gateNonnegative",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-stabilization-target", name: "staysNegative", relatedName: "gateNonnegative",
    }));
  });

  it("uses a proven strengthening invariant to exclude a response trigger", async () => {
    const temporal = parseSpec("strengthened-response-trigger.ts", `/* uneffect:temporal state gate: int */ /* uneffect:temporal state value: int */ /* uneffect:temporal init gate = 0 */ /* uneffect:temporal init value = 0 */ /* uneffect:temporal action hiddenDecrease: value' = value - 1 */ /* uneffect:temporal action_when hiddenDecrease: gate < 0 */ /* uneffect:temporal invariant gateNonnegative: gate >= 0 */ /* uneffect:temporal response negativeValue: value < 0 => false */`).temporal;
    const bounded = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 });
    expect(bounded).toContainEqual(expect.objectContaining({
      code: "bounded-unreachable-response-trigger", name: "negativeValue",
    }));
    expect(bounded).not.toContainEqual(expect.objectContaining({
      code: "inductively-unreachable-response-trigger", name: "negativeValue",
    }));
    const strengthened = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 2,
      strengtheningProperties: ["gateNonnegative"],
    });
    expect(strengthened).toContainEqual(expect.objectContaining({
      code: "strengthened-unreachable-response-trigger", name: "negativeValue", relatedName: "gateNonnegative",
    }));
  });

  it("distinguishes strong fairness from intermittent weak fairness", async () => {
    const model = (fairness: "weak" | "strong") => parseSpec("strong-fairness-lasso.ts", `/* uneffect:temporal state ready: bool */ /* uneffect:temporal state done: bool */ /* uneffect:temporal init ready = false */ /* uneffect:temporal init done = false */ /* uneffect:temporal action toggle: ready' = !ready */ /* uneffect:temporal action finish: done' = true */ /* uneffect:temporal action_when finish: ready */ /* uneffect:temporal action_fair finish: ${fairness} */ /* uneffect:temporal eventually completes: done */`).temporal;
    await expect(lintTemporalReachabilityWithZ3(model("weak"), { maxSteps: 3 })).resolves.toContainEqual(
      expect.objectContaining({ code: "reachable-liveness-cycle", name: "completes", depth: 2, loopStart: 0 }),
    );
    await expect(lintTemporalReachabilityWithZ3(model("strong"), { maxSteps: 3 })).resolves.not.toContainEqual(
      expect.objectContaining({ code: "reachable-liveness-cycle", name: "completes" }),
    );
  });

  it("reports a bounded invariant that holds only because its referenced state is frozen", async () => {
    const temporal = parseSpec("vacuous-property.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal state counter: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal init counter = 0 */ /* uneffect:temporal action tick: counter' = counter + 1 */ /* uneffect:temporal invariant phaseFixed: phase === 0 */ /* uneffect:temporal invariant counterNonnegative: counter >= 0 */`).temporal;
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
    const temporal = parseSpec("bounded-only-vacuity.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action unreachableChange: phase' = 1 */ /* uneffect:temporal action_when unreachableChange: phase < 0 */ /* uneffect:temporal invariant phaseFixed: phase === 0 */ /* uneffect:temporal invariant phaseNonnegative: phase >= 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "bounded-vacuous-property", name: "phaseFixed" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "inductively-vacuous-property", name: "phaseFixed" }));
    const strengthened = await lintTemporalReachabilityWithZ3(temporal, {
      maxSteps: 3,
      strengtheningProperties: ["phaseNonnegative"],
    });
    expect(strengthened).toContainEqual(expect.objectContaining({
      code: "strengthened-vacuous-property", name: "phaseFixed", relatedName: "phaseNonnegative",
    }));
  });

  it("detects models whose enabled initial transitions cannot change state", async () => {
    const temporal = parseSpec("stuttering.ts", `/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal action idle: phase' = phase */ /* uneffect:temporal invariant fixed: phase === 0 */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 1 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "no-state-progress-from-init", name: "<init>" }));
  });

  it("does not treat a source file without a temporal model as a deadlocked model", async () => {
    const result = await lintSpecWithZ3("plain.ts", `export function add(a: number, b: number) { return a + b }`);
    expect(result.diagnostics).toEqual([]);
  });
});
