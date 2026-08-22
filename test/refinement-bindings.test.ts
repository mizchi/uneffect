import { describe, expect, it } from "vitest";
import { buildRefinementBindingManifest, createAnnotatedRefinementAdapter, generateRefinementAdapterModule, validateRefinementActionBodies, validateRefinementBindingCoverage, validateRefinementInvariantBodies, validateRefinementStateProjection } from "../src/refinement-bindings.js";
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
      expect.objectContaining({ code: "unsupported-action-body", modelName: "conditional", exportName: "conditional" }),
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
