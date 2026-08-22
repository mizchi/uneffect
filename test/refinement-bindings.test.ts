import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildRefinementBindingManifest, createAnnotatedRefinementAdapter, generateRefinementAdapterModule, validateRefinementActionBodies, validateRefinementActionBodiesInProgram, validateRefinementBindingCoverage, validateRefinementInvariantBodies, validateRefinementStateProjection } from "../src/refinement-bindings.js";
import { replayModelCounterexample } from "../src/model-replay.js";
import { parseSpec } from "../src/spec-ir.js";
import { findTemporalCounterexampleWithZ3 } from "../src/spec-lint.js";

describe("annotated refinement bindings", () => {
  it("binds a backend counterexample to exported implementation functions", async () => {
    const source = `
      /* uneffect:
       * state value: int
       * init value = 0
       * action increment: value' = value + 1
       * temporal belowTwo: value < 2
       */
      /* uneffect: refinement counter@1 create */
      export function createCounter(initial: { value: number }) { return { ...initial } }
      /* uneffect: refinement counter@1 observe */
      export function observeCounter(runtime: { value: number }) { return { ...runtime } }
      /* uneffect: refinement counter@1 action increment */
      export function incrementCounter(runtime: { value: number }) { runtime.value++ }
      /* uneffect: refinement counter@1 invariant belowTwo */
      export function belowTwoCounter(runtime: { value: number }) { return runtime.value < 2 }
    `;
    const exports = {
      createCounter: (initial: { value: number }) => ({ ...initial }),
      observeCounter: (runtime: { value: number }) => ({ ...runtime }),
      incrementCounter: (runtime: { value: number }) => { runtime.value++; },
      belowTwoCounter: (runtime: { value: number }) => runtime.value < 2,
    };
    const adapter = createAnnotatedRefinementAdapter("counter.ts", source, exports, "counter");
    const result = await findTemporalCounterexampleWithZ3(parseSpec("counter.ts", source).temporal, "belowTwo", { maxSteps: 3 });
    expect(result.status).toBe("counterexample");
    if (result.status !== "counterexample") return;
    await expect(replayModelCounterexample(result.trace, adapter)).resolves.toMatchObject({
      status: "replayed", matchedSteps: 2, violations: [{ invariant: "belowTwo", step: 2 }],
    });
  });

  it("generates a reviewable zero-wrapper adapter module", () => {
    const source = `
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: unknown) {}
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: unknown) {}
      /* uneffect: refinement counter@1 action increment */ export function incrementCounter(runtime: unknown) {}
    `;
    expect(generateRefinementAdapterModule("counter.ts", source, "./counter.js", "counter")).toContain(
      `actions: { "increment": implementation.incrementCounter }`,
    );
  });

  it("rejects non-exported, incomplete, and duplicate bindings", () => {
    expect(() => buildRefinementBindingManifest("private.ts", `
      /* uneffect: refinement counter@1 create */ function createCounter(initial: unknown) {}
    `, "counter")).toThrow(/must be exported/);
    expect(() => buildRefinementBindingManifest("incomplete.ts", `
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: unknown) {}
    `, "counter")).toThrow(/exactly one create/);
    expect(() => buildRefinementBindingManifest("duplicate.ts", `
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: unknown) {}
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: unknown) {}
      /* uneffect: refinement counter@1 action increment */ export function first(runtime: unknown) {}
      /* uneffect: refinement counter@1 action increment */ export function second(runtime: unknown) {}
    `, "counter")).toThrow(/duplicate action/);
    expect(() => buildRefinementBindingManifest("arity.ts", `
      /* uneffect: refinement counter@1 create */ export function createCounter() {}
    `, "counter")).toThrow(/expected exactly one parameter/);
  });

  it("reports stale and missing temporal model bindings", () => {
    const source = `
      /* uneffect:
       * state value: int
       * init value = 0
       * action increment: value' = value + 1
       * action reset: value' = 0
       * temporal nonNegative: value >= 0
       */
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: unknown) {}
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: unknown) {}
      /* uneffect: refinement counter@1 action increment */ export function incrementCounter(runtime: unknown) {}
      /* uneffect: refinement counter@1 action removed */ export function removedCounter(runtime: unknown) {}
      /* uneffect: refinement counter@1 invariant stale */ export function staleCounter(runtime: unknown) {}
    `;
    const temporal = parseSpec("counter.ts", source).temporal;
    expect(validateRefinementBindingCoverage("counter.ts", source, "counter", temporal)).toEqual([
      expect.objectContaining({ code: "missing-action-binding", modelName: "reset" }),
      expect.objectContaining({ code: "unknown-action-binding", modelName: "removed", exportName: "removedCounter" }),
      expect.objectContaining({ code: "missing-invariant-binding", modelName: "nonNegative" }),
      expect.objectContaining({ code: "unknown-invariant-binding", modelName: "stale", exportName: "staleCounter" }),
    ]);
  });

  it("proves direct scalar action updates and reports semantic mismatches", () => {
    const source = `
      /* uneffect:
       * state value: int
       * state armed: bool
       * init value = 0
       * init armed = false
       * action increment: value' = value + 1
       * action arm: armed' = true
       * action observe: armed' = armed
       * action badExtra: value' = value
       */
      interface Runtime { value: number; armed: boolean }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action increment */ export function increment(runtime: Runtime) { runtime.value++ }
      /* uneffect: refinement counter@1 action arm */ export function arm(runtime: Runtime) { runtime.armed = false }
      /* uneffect: refinement counter@1 action observe */ export function observe(_runtime: Runtime) {}
      /* uneffect: refinement counter@1 action badExtra */ export function badExtra(runtime: Runtime) { runtime.armed = true }
    `;
    expect(validateRefinementActionBodies("counter.ts", source, "counter", parseSpec("counter.ts", source).temporal)).toEqual([
      expect.objectContaining({
        code: "action-update-mismatch",
        modelName: "arm",
        target: "armed",
        expected: "true",
        actual: "false",
      }),
      expect.objectContaining({
        code: "action-update-mismatch",
        modelName: "badExtra",
        target: "armed",
        expected: "armed",
        actual: "true",
      }),
    ]);
  });

  it("composes repeated writes sequentially without confusing them with model simultaneous updates", () => {
    const source = `/* uneffect:
      state value: int
      state left: int
      state right: int
      init value = 0
      init left = 1
      init right = 2
      action incrementTwice: value' = value + 1 + 1
      action brokenSwap: left' = right, right' = left
    */
      interface Runtime { value: number; left: number; right: number }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action incrementTwice */
      export function incrementTwice(runtime: Runtime) { runtime.value++; runtime.value++ }
      /* uneffect: refinement counter@1 action brokenSwap */
      export function brokenSwap(runtime: Runtime) { runtime.left = runtime.right; runtime.right = runtime.left }
    `;
    expect(validateRefinementActionBodies("counter.ts", source, "counter", parseSpec("counter.ts", source).temporal)).toEqual([
      expect.objectContaining({ code: "action-update-mismatch", modelName: "brokenSwap", target: "right", expected: "left", actual: "right" }),
    ]);
  });

  it("preserves immutable action-local snapshots across later writes", () => {
    const source = `/* uneffect:
      state left: int
      state right: int
      init left = 1
      init right = 2
      action swap: left' = right, right' = left
    */
      interface Runtime { left: number; right: number }
      /* uneffect: refinement pair@1 create */ export function createPair(initial: Runtime) { return initial }
      /* uneffect: refinement pair@1 observe */ export function observePair(runtime: Runtime) { return runtime }
      /* uneffect: refinement pair@1 action swap */
      export function swap(runtime: Runtime) {
        const previousLeft = runtime.left;
        runtime.left = runtime.right;
        runtime.right = previousLeft;
      }
    `;
    expect(validateRefinementActionBodies("swap.ts", source, "pair", parseSpec("swap.ts", source).temporal)).toEqual([]);
    const mutable = source.replace("const previousLeft", "let previousLeft");
    expect(validateRefinementActionBodies("mutable-swap.ts", mutable, "pair", parseSpec("mutable-swap.ts", mutable).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "swap" }),
    ]);
  });

  it("composes an if branch into a conditional model update", () => {
    const source = `/* uneffect:
      state value: int
      state armed: bool
      init value = 0
      init armed = false
      action maybeIncrement: value' = armed ? value + 1 : value
    */
      interface Runtime { value: number; armed: boolean }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action maybeIncrement */
      export function maybeIncrement(runtime: Runtime) { if (runtime.armed) runtime.value++ }
    `;
    expect(validateRefinementActionBodies("conditional.ts", source, "counter", parseSpec("conditional.ts", source).temporal)).toEqual([]);
  });

  it("unrolls a statically bounded ascending for loop and rejects dynamic bounds", () => {
    const model = `/* uneffect:
      state value: int
      init value = 0
      action addThree: value' = value + 1 + 1 + 1
    */`;
    const safe = `${model}
      interface Runtime { value: number }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action addThree */
      export function addThree(runtime: Runtime) { for (let index = 0; index < 3; index++) runtime.value++ }
    `;
    expect(validateRefinementActionBodies("loop.ts", safe, "counter", parseSpec("loop.ts", safe).temporal)).toEqual([]);
    const dynamic = safe.replace("index < 3", "index < runtime.value");
    expect(validateRefinementActionBodies("dynamic-loop.ts", dynamic, "counter", parseSpec("dynamic-loop.ts", dynamic).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addThree" }),
    ]);
  });

  it("inlines acyclic same-file action helpers and rejects recursion", () => {
    const model = `/* uneffect:
      state value: int
      init value = 0
      action addTwo: value' = value + 1 + 1
    */`;
    const safe = `${model}
      interface Runtime { value: number }
      function increment(runtime: Runtime, amount: number) { runtime.value += amount }
      function add(runtime: Runtime, amount: number) { increment(runtime, amount) }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action addTwo */
      export function addTwo(runtime: Runtime) { add(runtime, 1); add(runtime, 1) }
    `;
    expect(validateRefinementActionBodies("helper.ts", safe, "counter", parseSpec("helper.ts", safe).temporal)).toEqual([]);

    const recursive = safe.replace(
      "function increment(runtime: Runtime, amount: number) { runtime.value += amount }",
      "function increment(runtime: Runtime, amount: number) { increment(runtime, amount) }",
    );
    expect(validateRefinementActionBodies("recursive-helper.ts", recursive, "counter", parseSpec("recursive-helper.ts", recursive).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addTwo" }),
    ]);
  });

  it("composes terminal void returns and return-forwarded action helpers", () => {
    const source = `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
    */
      interface Runtime { value: number }
      function applyIncrement(runtime: Runtime) { runtime.value++; return }
      function forwardIncrement(runtime: Runtime) { return applyIncrement(runtime) }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action increment */
      export function increment(runtime: Runtime) { return forwardIncrement(runtime) }
    `;
    expect(validateRefinementActionBodies("return-helper.ts", source, "counter", parseSpec("return-helper.ts", source).temporal)).toEqual([]);

    const nonterminal = source.replace("runtime.value++; return", "return; runtime.value++");
    expect(validateRefinementActionBodies("nonterminal-return.ts", nonterminal, "counter", parseSpec("nonterminal-return.ts", nonterminal).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "increment" }),
    ]);
  });

  it("lowers one nested scalar field mutation to an immutable record update", () => {
    const source = `/* uneffect:
      state lease: { owner: int, epoch: int }
      init lease = { owner: 1, epoch: 0 }
      action renew: lease' = { ...lease, epoch: lease.epoch + 1 }
    */
      interface Runtime { lease: { owner: number; epoch: number } }
      /* uneffect: refinement lease@1 create */ export function createLease(initial: Runtime) { return initial }
      /* uneffect: refinement lease@1 observe */ export function observeLease(runtime: Runtime) { return runtime }
      /* uneffect: refinement lease@1 action renew */ export function renew(runtime: Runtime) { runtime.lease.epoch++ }
    `;
    expect(validateRefinementActionBodies("nested-action.ts", source, "lease", parseSpec("nested-action.ts", source).temporal)).toEqual([]);

    const wrong = source.replace("runtime.lease.epoch++", "runtime.lease.owner++");
    expect(validateRefinementActionBodies("wrong-nested-action.ts", wrong, "lease", parseSpec("wrong-nested-action.ts", wrong).temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "renew", target: "lease" }),
    );
  });

  it("merges multiple nested member writes independent of model field order", () => {
    const source = `/* uneffect:
      state lease: { owner: int, epoch: int }
      init lease = { owner: 1, epoch: 0 }
      action advance: lease' = { ...lease, epoch: lease.epoch + 1, owner: lease.owner + 1 }
    */
      interface Runtime { lease: { owner: number; epoch: number } }
      /* uneffect: refinement lease@1 create */ export function createLease(initial: Runtime) { return initial }
      /* uneffect: refinement lease@1 observe */ export function observeLease(runtime: Runtime) { return runtime }
      /* uneffect: refinement lease@1 action advance */
      export function advance(runtime: Runtime) { runtime.lease.owner++; runtime.lease.epoch++ }
    `;
    expect(validateRefinementActionBodies("multi-nested-action.ts", source, "lease", parseSpec("multi-nested-action.ts", source).temporal)).toEqual([]);

    const missing = source.replace(" runtime.lease.epoch++", "");
    expect(validateRefinementActionBodies("missing-nested-write.ts", missing, "lease", parseSpec("missing-nested-write.ts", missing).temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "advance", target: "lease" }),
    );
  });

  it("normalizes an immutable object-spread action assignment", () => {
    const source = `/* uneffect:
      state lease: { owner: int, epoch: int }
      init lease = { owner: 1, epoch: 0 }
      action renew: lease' = { ...lease, epoch: lease.epoch + 1 }
    */
      interface Runtime { lease: { owner: number; epoch: number } }
      /* uneffect: refinement lease@1 create */ export function createLease(initial: Runtime) { return initial }
      /* uneffect: refinement lease@1 observe */ export function observeLease(runtime: Runtime) { return runtime }
      /* uneffect: refinement lease@1 action renew */
      export function renew(runtime: Runtime) { runtime.lease = { ...runtime.lease, epoch: runtime.lease.epoch + 1 } }
    `;
    expect(validateRefinementActionBodies("immutable-action.ts", source, "lease", parseSpec("immutable-action.ts", source).temporal)).toEqual([]);

    const wrongSpread = source.replace("...runtime.lease", "...runtime.otherLease");
    expect(validateRefinementActionBodies("wrong-spread.ts", wrongSpread, "lease", parseSpec("wrong-spread.ts", wrongSpread).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "renew" }),
    );
  });

  it("lowers nested Set.add and Map.set mutations to immutable collection updates", () => {
    const source = `/* uneffect:
      state authority: { owners: Set<int>, epochs: Map<int, int> }
      init authority = { owners: Set(1), epochs: Map([[1, 0]]) }
      action addOwner: authority' = { ...authority, owners: authority.owners.union(Set(2)) }
      action publishEpoch: authority' = { ...authority, epochs: authority.epochs.put(2, 1) }
      action clearOwners: authority' = { ...authority, owners: Set() }
      action clearEpochs: authority' = { ...authority, epochs: Map([]) }
      action deleteOwner: authority' = { ...authority, owners: authority.owners.exclude(Set(2)) }
      action deleteEpoch: authority' = { ...authority, epochs: authority.epochs.remove(2) }
    */
      interface Runtime { authority: { owners: Set<number>; epochs: Map<number, number> } }
      /* uneffect: refinement authority@1 create */ export function createAuthority(initial: Runtime) { return initial }
      /* uneffect: refinement authority@1 observe */ export function observeAuthority(runtime: Runtime) { return runtime }
      /* uneffect: refinement authority@1 action addOwner */ export function addOwner(runtime: Runtime) { runtime.authority.owners.add(2) }
      /* uneffect: refinement authority@1 action publishEpoch */ export function publishEpoch(runtime: Runtime) { runtime.authority.epochs.set(2, 1) }
      /* uneffect: refinement authority@1 action clearOwners */ export function clearOwners(runtime: Runtime) { runtime.authority.owners.clear() }
      /* uneffect: refinement authority@1 action clearEpochs */ export function clearEpochs(runtime: Runtime) { runtime.authority.epochs.clear() }
      /* uneffect: refinement authority@1 action deleteOwner */ export function deleteOwner(runtime: Runtime) { runtime.authority.owners.delete(2) }
      /* uneffect: refinement authority@1 action deleteEpoch */ export function deleteEpoch(runtime: Runtime) { runtime.authority.epochs.delete(2) }
    `;
    expect(validateRefinementActionBodies("collection-action.ts", source, "authority", parseSpec("collection-action.ts", source).temporal)).toEqual([]);

    const wrong = source.replace("owners.add(2)", "owners.add(3)");
    expect(validateRefinementActionBodies("wrong-collection.ts", wrong, "authority", parseSpec("wrong-collection.ts", wrong).temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "addOwner", target: "authority" }),
    );
  });

  it("requires builtin collection receiver identity in the TypeChecker-backed path", () => {
    const model = `/* uneffect:
      state owners: Set<int>
      init owners = Set(1)
      action addOwner: owners' = owners.union(Set(2))
    */`;
    const standard = `${model}
      interface Runtime { owners: Set<number> }
      /* uneffect: refinement authority@1 create */ export function createAuthority(initial: Runtime) { return initial }
      /* uneffect: refinement authority@1 observe */ export function observeAuthority(runtime: Runtime) { return runtime }
      /* uneffect: refinement authority@1 action addOwner */ export function addOwner(runtime: Runtime) { runtime.owners.add(2) }
    `;
    const aliased = `${model}
      type Owners = Set<number>
      interface Runtime { owners: Owners }
      /* uneffect: refinement authority@1 create */ export function createAuthority(initial: Runtime) { return initial }
      /* uneffect: refinement authority@1 observe */ export function observeAuthority(runtime: Runtime) { return runtime }
      /* uneffect: refinement authority@1 action addOwner */ export function addOwner(runtime: Runtime) { runtime.owners.add(2) }
    `;
    const constrained = `${model}
      interface Runtime<T extends Set<number>> { owners: T }
      /* uneffect: refinement authority@1 create */ export function createAuthority<T extends Set<number>>(initial: Runtime<T>) { return initial }
      /* uneffect: refinement authority@1 observe */ export function observeAuthority<T extends Set<number>>(runtime: Runtime<T>) { return runtime }
      /* uneffect: refinement authority@1 action addOwner */ export function addOwner<T extends Set<number>>(runtime: Runtime<T>) { runtime.owners.add(2) }
    `;
    const lookalike = `${model}
      class AuditSet<T> extends Set<T> { override add(value: T) { return super.add(value) } }
      interface Runtime { owners: AuditSet<number> }
      /* uneffect: refinement authority@1 create */ export function createAuthority(initial: Runtime) { return initial }
      /* uneffect: refinement authority@1 observe */ export function observeAuthority(runtime: Runtime) { return runtime }
      /* uneffect: refinement authority@1 action addOwner */ export function addOwner(runtime: Runtime) { runtime.owners.add(2) }
    `;
    const directory = mkdtempSync(join(tmpdir(), "uneffect-refinement-types-"));
    try {
      const verify = (name: string, source: string) => {
        const fileName = join(directory, name);
        writeFileSync(fileName, source);
        const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
        return validateRefinementActionBodiesInProgram(program, fileName, "authority", parseSpec(fileName, source).temporal);
      };
      expect(verify("standard.ts", standard)).toEqual([]);
      expect(verify("aliased.ts", aliased)).toEqual([]);
      expect(verify("constrained.ts", constrained)).toEqual([]);
      expect(verify("lookalike.ts", lookalike)).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body", modelName: "addOwner",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("specializes one local class method call and rejects unsupported control flow", () => {
    const source = `
      /* uneffect:
       * state delivered: int
       * state attempted: int
       * init delivered = 0
       * init attempted = 0
       * action deliver: delivered' = delivered + 1, attempted' = attempted + 1
       * action conditional: delivered' = delivered + 1
       */
      class Runtime {
        delivered = 0
        attempted = 0
        record(outcome: "delivered") { this.attempted += 1; this[outcome] += 1 }
      }
      /* uneffect: refinement routing@1 create */ export function createRouting(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observeRouting(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action deliver */ export function deliver(runtime: Runtime) { runtime.record("delivered") }
      /* uneffect: refinement routing@1 action conditional */ export function conditional(runtime: Runtime) { if (runtime.delivered === 0) runtime.delivered++ }
    `;
    expect(validateRefinementActionBodies("routing.ts", source, "routing", parseSpec("routing.ts", source).temporal)).toEqual([
      expect.objectContaining({ code: "action-update-mismatch", modelName: "conditional", exportName: "conditional", actual: "delivered === 0 ? delivered + 1 : delivered" }),
    ]);
  });

  it("does not treat a missing action binding as a successful body proof", () => {
    const source = `
      /* uneffect:
       * state value: int
       * init value = 0
       * action increment: value' = value + 1
       */
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: unknown) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: unknown) { return runtime }
    `;
    expect(validateRefinementActionBodies("counter.ts", source, "counter", parseSpec("counter.ts", source).temporal)).toEqual([
      expect.objectContaining({ code: "missing-action-binding", modelName: "increment" }),
    ]);
  });

  it("proves scalar invariant predicates without accepting missing, stale, or unsupported bodies", () => {
    const source = `
      /* uneffect:
       * state value: int
       * state armed: bool
       * init value = 0
       * init armed = false
       * temporal nonNegative: value >= 0
       * temporal guarded: !armed || value > 0
       * temporal unsupported: value < 10
       * temporal strictZero: value === 0
       * temporal missing: value === 0
       */
      interface Runtime { value: number; armed: boolean }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 invariant nonNegative */ export function nonNegative(runtime: Runtime) { return runtime.value >= 0 }
      /* uneffect: refinement counter@1 invariant guarded */ export function guarded(runtime: Runtime) { return !runtime.armed && runtime.value > 0 }
      /* uneffect: refinement counter@1 invariant unsupported */ export function unsupported(runtime: Runtime) { const limit = 10; return runtime.value < limit }
      /* uneffect: refinement counter@1 invariant strictZero */ export function strictZero(runtime: Runtime) { return runtime.value == 0 }
      /* uneffect: refinement counter@1 invariant stale */ export function stale(runtime: Runtime) { return runtime.value === 0 }
    `;
    expect(validateRefinementInvariantBodies("counter.ts", source, "counter", parseSpec("counter.ts", source).temporal)).toEqual([
      expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "guarded" }),
      expect.objectContaining({ code: "unsupported-invariant-body", modelName: "strictZero", exportName: "strictZero" }),
      expect.objectContaining({ code: "missing-invariant-binding", modelName: "missing" }),
      expect.objectContaining({ code: "unknown-invariant-binding", modelName: "stale", exportName: "stale" }),
    ]);
  });

  it("proves immutable local scalar aliases in invariant bodies", () => {
    const source = `/* uneffect:
      state value: int
      state armed: bool
      init value = 0
      init armed = false
      temporal guarded: !armed || value > 0
    */
      interface Runtime { value: number; armed: boolean }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 invariant guarded */
      export function guarded(runtime: Runtime) {
        const enabled = runtime.armed;
        const positive = runtime.value > 0;
        return !enabled || positive;
      }
    `;
    expect(validateRefinementInvariantBodies("counter.ts", source, "counter", parseSpec("counter.ts", source).temporal)).toEqual([]);
  });

  it("inlines an acyclic local pure invariant helper graph without trusting recursive calls", () => {
    const model = `/* uneffect:
      state value: int
      state armed: bool
      init value = 0
      init armed = false
      temporal guarded: !armed || value > 0
    */`;
    const safe = `${model}
      interface Runtime { value: number; armed: boolean }
      function isGuarded(state: Runtime) { return !state.armed || state.value > 0 }
      function remainsSafe(state: Runtime) { return isGuarded(state) }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 invariant guarded */ export function guarded(runtime: Runtime) { return remainsSafe(runtime) }
    `;
    expect(validateRefinementInvariantBodies("safe.ts", safe, "counter", parseSpec("safe.ts", safe).temporal)).toEqual([]);

    const recursive = `${model}
      interface Runtime { value: number; armed: boolean }
      function isGuarded(state: Runtime): boolean { return isGuarded(state) }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 invariant guarded */ export function guarded(runtime: Runtime) { return isGuarded(runtime) }
    `;
    expect(validateRefinementInvariantBodies("recursive.ts", recursive, "counter", parseSpec("recursive.ts", recursive).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-invariant-body", modelName: "guarded" }),
    ]);
  });

  it("proves create/observe state projection and reports transformed or swapped fields", () => {
    const model = `/* uneffect:
      state left: int
      state right: int
      init left = 0
      init right = 0
    */`;
    const safe = `${model}
      interface State { left: number; right: number }
      class Runtime { left = 0; right = 0 }
      /* uneffect: refinement pair@1 create */ export function createPair(initial: State) { return Object.assign(new Runtime(), initial) }
      /* uneffect: refinement pair@1 observe */ export function observePair(runtime: Runtime) { const { left, right } = runtime; return { left, right } }
    `;
    expect(validateRefinementStateProjection("safe.ts", safe, "pair", parseSpec("safe.ts", safe).temporal)).toEqual([]);

    const broken = `${model}
      interface State { left: number; right: number }
      /* uneffect: refinement pair@1 create */ export function createPair(initial: State) { return { ...initial, left: initial.left + 1 } }
      /* uneffect: refinement pair@1 observe */ export function observePair(runtime: State) { return { left: runtime.right, right: runtime.right } }
    `;
    expect(validateRefinementStateProjection("broken.ts", broken, "pair", parseSpec("broken.ts", broken).temporal)).toEqual([
      expect.objectContaining({ code: "create-state-mismatch", field: "left", expected: "left", actual: "left + 1" }),
      expect.objectContaining({ code: "observe-state-mismatch", field: "left", expected: "left", actual: "right" }),
    ]);
  });

  it("inlines acyclic same-file create and observe projection helpers", () => {
    const model = `/* uneffect:
      state left: int
      state right: int
      init left = 0
      init right = 0
    */`;
    const safe = `${model}
      interface State { left: number; right: number }
      class Runtime { left = 0; right = 0 }
      function hydrate(initial: State) { return Object.assign(new Runtime(), initial) }
      function createRuntime(initial: State) { return hydrate(initial) }
      function snapshot(runtime: Runtime) { const { left, right } = runtime; return { left, right } }
      function observeRuntime(runtime: Runtime) { return snapshot(runtime) }
      /* uneffect: refinement pair@1 create */ export function createPair(initial: State) { return createRuntime(initial) }
      /* uneffect: refinement pair@1 observe */ export function observePair(runtime: Runtime) { return observeRuntime(runtime) }
    `;
    expect(validateRefinementStateProjection("projection-helper.ts", safe, "pair", parseSpec("projection-helper.ts", safe).temporal)).toEqual([]);

    const recursive = safe.replace(
      "function hydrate(initial: State) { return Object.assign(new Runtime(), initial) }",
      "function hydrate(initial: State): Runtime { return createRuntime(initial) }",
    );
    expect(validateRefinementStateProjection("recursive-projection.ts", recursive, "pair", parseSpec("recursive-projection.ts", recursive).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-create-body", exportName: "createPair" }),
    ]);
  });

  it("proves complete nested-record reconstruction and rejects missing nested fields", () => {
    const model = `/* uneffect:
      state lease: { owner: int, valid: bool }
      init lease = { owner: 1, valid: true }
    */`;
    const safe = `${model}
      interface State { lease: { owner: number; valid: boolean } }
      /* uneffect: refinement lease@1 create */
      export function createLease(initial: State) { return { lease: { owner: initial.lease.owner, valid: initial.lease.valid } } }
      /* uneffect: refinement lease@1 observe */
      export function observeLease(runtime: State) { const { lease } = runtime; return { lease: { owner: lease.owner, valid: lease.valid } } }
    `;
    expect(validateRefinementStateProjection("nested-projection.ts", safe, "lease", parseSpec("nested-projection.ts", safe).temporal)).toEqual([]);

    const missing = safe.replace("owner: lease.owner, valid: lease.valid", "owner: lease.owner");
    expect(validateRefinementStateProjection("missing-nested.ts", missing, "lease", parseSpec("missing-nested.ts", missing).temporal)).toContainEqual(
      expect.objectContaining({ code: "observe-state-mismatch", field: "lease" }),
    );
  });

  it("does not accept arbitrary create or observe calls as a state projection", () => {
    const source = `
      /* uneffect:
       * state value: int
       * init value = 0
       */
      interface State { value: number }
      declare function factory(value: State): State
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: State) { return factory(initial) }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: State) { return factory(runtime) }
    `;
    expect(validateRefinementStateProjection("counter.ts", source, "counter", parseSpec("counter.ts", source).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-create-body", exportName: "createCounter" }),
      expect.objectContaining({ code: "unsupported-observe-body", exportName: "observeCounter" }),
    ]);
  });

  it("does not confuse same-named globals with model state fields", () => {
    const source = `
      /* uneffect:
       * state value: int
       * init value = 0
       * action increment: value' = value + 1
       * temporal nonNegative: value >= 0
       */
      const value = 0
      interface Runtime { value: number }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action increment */ export function increment(runtime: Runtime) { runtime.value = value + 1 }
      /* uneffect: refinement counter@1 invariant nonNegative */ export function nonNegative(_runtime: Runtime) { return value >= 0 }
    `;
    const temporal = parseSpec("counter.ts", source).temporal;
    expect(validateRefinementActionBodies("counter.ts", source, "counter", temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "increment" }),
    ]);
    expect(validateRefinementInvariantBodies("counter.ts", source, "counter", temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-invariant-body", modelName: "nonNegative" }),
    ]);
  });

  it("requires guarded model actions to enforce the same early-return predicate", () => {
    const model = `/* uneffect:
      state value: int
      state armed: bool
      init value = 0
      init armed = false
      action increment: value' = value + 1
      action_when increment: armed && value > 0
    */`;
    const safe = `${model}
      interface Runtime { value: number; armed: boolean }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action increment */
      export function increment(runtime: Runtime) { if (!(runtime.armed && runtime.value > 0)) return; runtime.value++ }
    `;
    expect(validateRefinementActionBodies("safe.ts", safe, "counter", parseSpec("safe.ts", safe).temporal)).toEqual([]);

    const missing = safe.replace("if (!(runtime.armed && runtime.value > 0)) return; ", "");
    expect(validateRefinementActionBodies("missing.ts", missing, "counter", parseSpec("missing.ts", missing).temporal)).toEqual([
      expect.objectContaining({ code: "missing-action-guard", modelName: "increment" }),
    ]);

    const mismatch = safe.replace("runtime.value > 0", "runtime.value >= 0");
    expect(validateRefinementActionBodies("mismatch.ts", mismatch, "counter", parseSpec("mismatch.ts", mismatch).temporal)).toEqual([
      expect.objectContaining({ code: "action-guard-mismatch", modelName: "increment", expected: "armed && value > 0", actual: "armed && value >= 0" }),
    ]);

    const unexpected = safe.replace("      action_when increment: armed && value > 0\n", "");
    expect(validateRefinementActionBodies("unexpected.ts", unexpected, "counter", parseSpec("unexpected.ts", unexpected).temporal)).toEqual([
      expect.objectContaining({ code: "unexpected-action-guard", modelName: "increment", expected: "<none>", actual: "armed && value > 0" }),
    ]);
  });
});
