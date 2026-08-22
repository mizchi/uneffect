import { describe, expect, it } from "vitest";
import { buildRefinementBindingManifest, createAnnotatedRefinementAdapter, generateRefinementAdapterModule, validateRefinementActionBodies, validateRefinementBindingCoverage } from "../src/refinement-bindings.js";
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
});
