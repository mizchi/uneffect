import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeRefinementActionBodies, buildRefinementBindingManifest, createAnnotatedRefinementAdapter, extractRefinementBindings, generateRefinementAdapterModule, validateRefinementActionBodies, validateRefinementActionBodiesInProgram, validateRefinementActionBodiesWithZ3, validateRefinementBindingCoverage, validateRefinementInvariantBodies, validateRefinementInvariantBodiesInProgram, validateRefinementStateProjection, validateRefinementStateProjectionInProgram } from "../src/refinement-bindings.js";
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

  it("records an explicit same-realm globalThis runtime identity", () => {
    const source = `
      /* uneffect: runtime counter@1 = globalThis */
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: typeof globalThis) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: typeof globalThis) { return runtime }
      /* uneffect: refinement counter@1 action increment */ export function incrementCounter(runtime: typeof globalThis) { runtime }
    `;
    expect(buildRefinementBindingManifest("counter.ts", source, "counter")).toMatchObject({
      runtimeIdentity: {
        kind: "ambient", root: "globalThis", identity: "ecmascript:realm.globalThis",
      },
    });
    expect(() => buildRefinementBindingManifest("counter.ts", source.replace(
      "runtime counter@1 = globalThis", "runtime counter@2 = globalThis",
    ), "counter")).toThrow(/version 2, expected 1/);
    expect(() => buildRefinementBindingManifest("counter.ts", source.replace(
      "runtime counter@1 = globalThis", "runtime counter@1 = globalThis.counter",
    ), "counter")).toThrow(/supported identities are globalThis and node:global@<major>#<realm>/);
    expect(() => buildRefinementBindingManifest("counter.ts", source.replace(
      "/* uneffect: runtime counter@1 = globalThis */",
      "/* uneffect: runtime counter@1 = globalThis */\n/* uneffect: runtime counter@1 = globalThis */",
    ), "counter")).toThrow(/duplicate refinement runtime identity/);
  });

  it("records a versioned current-realm Node global identity", () => {
    const source = `
      /* uneffect: runtime counter@1 = node:global@24#main */
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: typeof global) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: typeof global) { return runtime }
      /* uneffect: refinement counter@1 action increment */ export function incrementCounter(runtime: typeof global) { runtime }
    `;
    expect(buildRefinementBindingManifest("counter.ts", source, "counter")).toMatchObject({
      runtimeIdentity: {
        kind: "host", host: "node", root: "global", version: "24", realm: "main",
        identity: "node:24:realm:main.global",
      },
    });
    expect(() => buildRefinementBindingManifest("counter.ts", source.replace(
      "node:global@24#main", "node:global@24",
    ), "counter")).toThrow(/unsupported refinement runtime identity/);
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

  it("rejects a refinement marker attached to an unsupported declaration shape", () => {
    expect(() => extractRefinementBindings("state-store.ts", `
      export class StateStore {
        /* uneffect: refinement stateStore@1 action set */
        async set(key: string, value: unknown): Promise<void> { void key; void value }
      }
    `)).toThrow(/refinement annotations are supported only on top-level function declarations.*state-store\.ts/);
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

  it("composes switch entry, fallthrough, break, and default into one model update", () => {
    const source = `/* uneffect:
      state value: int
      state mode: int
      init value = 0
      init mode = 0
      action route: value' = mode === 0 ? value + 1 : mode === 1 ? value + 2 + 4 : value + 4
    */
      interface Runtime { value: number; mode: number }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action route */
      export function route(runtime: Runtime) {
        switch (runtime.mode) {
          case 0:
            runtime.value += 1;
            break;
          case 1:
            runtime.value += 2;
          default:
            runtime.value += 4;
            break;
        }
      }
    `;
    expect(validateRefinementActionBodies("switch.ts", source, "counter", parseSpec("switch.ts", source).temporal)).toEqual([]);

    const dynamicLabel = source.replace("case 1:", "case chooseMode():");
    expect(validateRefinementActionBodies("dynamic-switch.ts", dynamicLabel, "counter", parseSpec("dynamic-switch.ts", dynamicLabel).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    ]);

    const duplicateLabel = source.replace("case 1:", "case 0:");
    expect(validateRefinementActionBodies("duplicate-switch.ts", duplicateLabel, "counter", parseSpec("duplicate-switch.ts", duplicateLabel).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    ]);

    const withoutDefault = source
      .replace("action route: value' = mode === 0 ? value + 1 : mode === 1 ? value + 2 + 4 : value + 4", "action route: value' = mode === 0 ? value + 1 : mode === 1 ? value + 2 : value")
      .replace("          default:\n            runtime.value += 4;\n            break;\n", "          break;\n");
    expect(validateRefinementActionBodies("switch-without-default.ts", withoutDefault, "counter", parseSpec("switch-without-default.ts", withoutDefault).temporal)).toEqual([]);
  });

  it("propagates switch return and throw paths through catch and finally", () => {
    const source = `/* uneffect:
      state routed: int
      state failed: int
      state settled: int
      state observed: int
      state mode: int
      init routed = 0
      init failed = 0
      init settled = 0
      init observed = 0
      init mode = 0
      action route: routed' = mode === 0 ? routed + 1 : mode === 1 ? routed + 2 : routed + 3, failed' = mode === 1 ? failed + 1 : failed, settled' = settled + 1, observed' = mode === 0 ? observed : observed + 1
    */
      interface Runtime { routed: number; failed: number; settled: number; observed: number; mode: number }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 0: runtime.routed++; return
            case 1: runtime.routed += 2; throw "failed"
            default: runtime.routed += 3; break
          }
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
        runtime.observed++
      }
    `;
    expect(validateRefinementActionBodies("switch-completion.ts", source, "routing", parseSpec("switch-completion.ts", source).temporal)).toEqual([]);

    const valueReturn = source.replace("runtime.routed++; return", "runtime.routed++; return runtime.routed");
    expect(validateRefinementActionBodies("switch-value-return.ts", valueReturn, "routing", parseSpec("switch-value-return.ts", valueReturn).temporal)).toEqual([]);

    const effectfulReturn = source.replace("runtime.routed++; return", "runtime.routed++; return computeRoute(runtime)");
    expect(validateRefinementActionBodies("switch-effectful-return.ts", effectfulReturn, "routing", parseSpec("switch-effectful-return.ts", effectfulReturn).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    );

    const effectfulThrow = source.replace('throw "failed"', 'throw new Error("failed")');
    expect(validateRefinementActionBodies("switch-effectful-throw.ts", effectfulThrow, "routing", parseSpec("switch-effectful-throw.ts", effectfulThrow).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    );
  });

  it("composes mandatory finally updates after a normally completing try block", () => {
    const source = `/* uneffect:
      state attempted: int
      state phase: int
      init attempted = 0
      init phase = 0
      action account: attempted' = attempted + 1, phase' = 2
    */
      interface Runtime { attempted: number; phase: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action account */
      export function account(runtime: Runtime) {
        try {
          runtime.attempted++;
          runtime.phase = 1;
        } finally {
          runtime.phase = 2;
        }
      }
    `;
    expect(validateRefinementActionBodies("finally.ts", source, "accounting", parseSpec("finally.ts", source).temporal)).toEqual([]);

    const withCatch = source.replace("} finally {", "} catch (error) { runtime.phase = 3 } finally {");
    expect(validateRefinementActionBodies("catch-finally.ts", withCatch, "accounting", parseSpec("catch-finally.ts", withCatch).temporal)).toEqual([]);

    const unknownTryEdge = withCatch.replace("runtime.phase = 1;", "runtime.phase = 1; mayThrow();");
    expect(validateRefinementActionBodies("unknown-try-edge.ts", unknownTryEdge, "accounting", parseSpec("unknown-try-edge.ts", unknownTryEdge).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "account" }),
    );

    const abrupt = source.replace("runtime.phase = 1;", "runtime.phase = 1; return;");
    expect(validateRefinementActionBodies("return-finally.ts", abrupt, "accounting", parseSpec("return-finally.ts", abrupt).temporal)).toEqual([]);
  });

  it("routes a direct terminal throw through catch and mandatory finally updates", () => {
    const source = `/* uneffect:
      state attempted: int
      state failed: int
      state settled: int
      init attempted = 0
      init failed = 0
      init settled = 0
      action reject: attempted' = attempted + 1, failed' = failed + 1, settled' = settled + 1
    */
      interface Runtime { attempted: number; failed: number; settled: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          runtime.attempted++
          throw "delivery failed"
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    expect(validateRefinementActionBodies("caught-throw.ts", source, "accounting", parseSpec("caught-throw.ts", source).temporal)).toEqual([]);

    const stateBackedThrow = source.replace('throw "delivery failed"', "throw runtime.attempted");
    expect(validateRefinementActionBodies("state-backed-throw.ts", stateBackedThrow, "accounting", parseSpec("state-backed-throw.ts", stateBackedThrow).temporal)).toEqual([]);

    const readsCaughtValue = source.replace("catch {", "catch (error) {").replace("runtime.failed++", "if (error) runtime.failed++");
    expect(validateRefinementActionBodies("caught-value.ts", readsCaughtValue, "accounting", parseSpec("caught-value.ts", readsCaughtValue).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
    ]);

    const effectfulThrow = source.replace('throw "delivery failed"', "throw makeError(runtime)");
    expect(validateRefinementActionBodies("effectful-throw.ts", effectfulThrow, "accounting", parseSpec("effectful-throw.ts", effectfulThrow).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
    ]);
  });

  it("joins conditional throw and normal paths before finally and trailing updates", () => {
    const source = `/* uneffect:
      state attempted: int
      state delivered: int
      state failed: int
      state settled: int
      state observed: int
      state shouldFail: bool
      init attempted = 0
      init delivered = 0
      init failed = 0
      init settled = 0
      init observed = 0
      init shouldFail = false
      action deliver: attempted' = attempted + 1, delivered' = shouldFail ? delivered : delivered + 1, failed' = shouldFail ? failed + 1 : failed, settled' = settled + 1, observed' = observed + 1
    */
      interface Runtime { attempted: number; delivered: number; failed: number; settled: number; observed: number; shouldFail: boolean }
      /* uneffect: refinement delivery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement delivery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement delivery@1 action deliver */
      export function deliver(runtime: Runtime) {
        try {
          runtime.attempted++
          if (runtime.shouldFail) throw "delivery failed"
          runtime.delivered++
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
        runtime.observed++
      }
    `;
    expect(validateRefinementActionBodies("conditional-throw.ts", source, "delivery", parseSpec("conditional-throw.ts", source).temporal)).toEqual([]);

    const effectfulNestedThrow = source.replace('throw "delivery failed"', "throw makeError(runtime)");
    expect(validateRefinementActionBodies("effectful-nested-throw.ts", effectfulNestedThrow, "delivery", parseSpec("effectful-nested-throw.ts", effectfulNestedThrow).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "deliver" }),
    ]);
  });

  it("binds a conditional scalar throw payload in catch control flow", () => {
    const source = `/* uneffect:
      state attempted: int
      state failed: int
      state settled: int
      state code: int
      state shouldFail: bool
      init attempted = 0
      init failed = 0
      init settled = 0
      init code = 0
      init shouldFail = false
      action reject: attempted' = attempted + 1, failed' = shouldFail ? code > 0 ? failed + 1 : failed : failed, settled' = settled + 1
    */
      interface Runtime { attempted: number; failed: number; settled: number; code: number; shouldFail: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          runtime.attempted++
          if (runtime.shouldFail) throw runtime.code
        } catch (error) {
          if (error > 0) runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    expect(validateRefinementActionBodies("caught-payload.ts", source, "accounting", parseSpec("caught-payload.ts", source).temporal)).toEqual([]);

    const untrackedPayload = source.replace("throw runtime.code", 'throw "failed"');
    expect(validateRefinementActionBodies("untracked-caught-payload.ts", untrackedPayload, "accounting", parseSpec("untracked-caught-payload.ts", untrackedPayload).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
    );
  });

  it("binds scalar throw payloads selected by switch cases", () => {
    const source = `/* uneffect:
      state failed: int
      state code: int
      state fallbackCode: int
      state mode: int
      init failed = 0
      init code = 0
      init fallbackCode = 1
      init mode = 0
      action reject: failed' = (mode === 1 || mode === 2) ? (mode === 1 ? code : fallbackCode) > 0 ? failed + 1 : failed : failed
    */
      interface Runtime { failed: number; code: number; fallbackCode: number; mode: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 1: throw runtime.code
            case 2: throw runtime.fallbackCode
          }
        } catch (error) {
          if (error > 0) runtime.failed++
        }
      }
    `;
    expect(validateRefinementActionBodies("switch-caught-payload.ts", source, "accounting", parseSpec("switch-caught-payload.ts", source).temporal)).toEqual([]);

    const ambiguousPayload = source.replace("case 2: throw runtime.fallbackCode", 'case 2: throw "failed"');
    expect(validateRefinementActionBodies("ambiguous-switch-payload.ts", ambiguousPayload, "accounting", parseSpec("ambiguous-switch-payload.ts", ambiguousPayload).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
    );
  });

  it("binds numeric literal payloads across switch fallthrough and default", () => {
    const source = `/* uneffect:
      state failed: int
      state mode: int
      init failed = 0
      init mode = 0
      action reject: failed' = (mode === 0 ? 1 : mode === 1 ? 1 : 0) > 0 ? failed + 1 : failed
    */
      interface Runtime { failed: number; mode: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          switch (runtime.mode) {
            case 0:
            case 1: throw 1
            default: throw 0
          }
        } catch (error) {
          if (error > 0) runtime.failed++
        }
      }
    `;
    expect(validateRefinementActionBodies("literal-switch-payload.ts", source, "accounting", parseSpec("literal-switch-payload.ts", source).temporal)).toEqual([]);

    for (const unsupported of ['"failed"', "null"]) {
      const untrackedPayload = source.replace("default: throw 0", `default: throw ${unsupported}`);
      expect(validateRefinementActionBodies("untracked-literal-switch-payload.ts", untrackedPayload, "accounting", parseSpec("untracked-literal-switch-payload.ts", untrackedPayload).temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
      );
    }
  });

  it("binds boolean literal payloads across conditional throws", () => {
    const source = `/* uneffect:
      state failed: int
      state shouldFail: bool
      init failed = 0
      init shouldFail = false
      action reject: failed' = shouldFail ? failed + 1 : failed
    */
      interface Runtime { failed: number; shouldFail: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          if (runtime.shouldFail) throw true
          throw false
        } catch (error) {
          if (error) runtime.failed++
        }
      }
    `;
    expect(validateRefinementActionBodies("boolean-literal-payload.ts", source, "accounting", parseSpec("boolean-literal-payload.ts", source).temporal)).toEqual([]);
  });

  it("projects fields from a direct record throw payload", () => {
    const source = `/* uneffect:
      state failed: int
      state code: int
      state retryable: bool
      init failed = 0
      init code = 0
      init retryable = false
      action reject: failed' = retryable && code > 0 ? failed + 1 : failed
    */
      interface Runtime { failed: number; code: number; retryable: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          throw { code: runtime.code, retryable: runtime.retryable }
        } catch (error) {
          if (error.retryable && error.code > 0) runtime.failed++
        }
      }
    `;
    expect(validateRefinementActionBodies("record-payload.ts", source, "accounting", parseSpec("record-payload.ts", source).temporal)).toEqual([]);

    for (const unsupported of ['message: "failed"', "cause: makeCause()", "code: runtime.code, code: 1"]) {
      const invalidPayload = source.replace("code: runtime.code, retryable: runtime.retryable", unsupported);
      expect(validateRefinementActionBodies("unsupported-record-payload.ts", invalidPayload, "accounting", parseSpec("unsupported-record-payload.ts", invalidPayload).temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "reject" }),
      );
    }
  });

  it("projects common scalar fields across conditional record throw payloads", () => {
    const source = `/* uneffect:
      state failed: int
      state primary: bool
      init failed = 0
      init primary = false
      action reject: failed' = failed + (primary ? 1 : 2)
    */
      interface Runtime { failed: number; primary: boolean }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 action reject */
      export function reject(runtime: Runtime) {
        try {
          if (runtime.primary) throw { code: 1, retryable: true }
          throw { code: 2, retryable: false }
        } catch (error) {
          if (error.retryable) runtime.failed = runtime.failed + error.code
          else runtime.failed = runtime.failed + error.code
        }
      }
    `;
    expect(validateRefinementActionBodies("conditional-record-payload.ts", source, "accounting", parseSpec("conditional-record-payload.ts", source).temporal)).toEqual([]);

    const missingField = source.replace(
      "throw { code: 2, retryable: false }",
      "throw { retryable: false }",
    );
    expect(validateRefinementActionBodies("missing-record-field.ts", missingField, "accounting", parseSpec("missing-record-field.ts", missingField).temporal)).toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "reject" }),
    );
  });

  it("propagates a nested conditional throw to the enclosing catch path", () => {
    const source = `/* uneffect:
      state delivered: int
      state failed: int
      state settled: int
      state outer: bool
      state inner: bool
      init delivered = 0
      init failed = 0
      init settled = 0
      init outer = false
      init inner = false
      action deliver: delivered' = outer ? inner ? delivered : delivered + 1 : delivered, failed' = (outer ? inner : false) ? failed + 1 : failed, settled' = settled + 1
    */
      interface Runtime { delivered: number; failed: number; settled: number; outer: boolean; inner: boolean }
      /* uneffect: refinement delivery@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement delivery@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement delivery@1 action deliver */
      export function deliver(runtime: Runtime) {
        try {
          if (runtime.outer) {
            if (runtime.inner) throw "delivery failed"
            runtime.delivered++
          }
        } catch {
          runtime.failed++
        } finally {
          runtime.settled++
        }
      }
    `;
    expect(validateRefinementActionBodies("nested-throw.ts", source, "delivery", parseSpec("nested-throw.ts", source).temporal)).toEqual([]);
  });

  it("keeps return and throw completions distinct across catch and finally", () => {
    const source = `/* uneffect:
      state returned: int
      state caught: int
      state settled: int
      state chooseReturn: bool
      init returned = 0
      init caught = 0
      init settled = 0
      init chooseReturn = false
      action finish: returned' = chooseReturn ? returned + 1 : returned, caught' = !chooseReturn ? caught + 1 : caught, settled' = settled + 1
    */
      interface Runtime { returned: number; caught: number; settled: number; chooseReturn: boolean }
      /* uneffect: refinement completion@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement completion@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement completion@1 action finish */
      export function finish(runtime: Runtime) {
        try {
          if (runtime.chooseReturn) { runtime.returned++; return }
          throw "failed"
        } catch {
          runtime.caught++
        } finally {
          runtime.settled++
        }
      }
    `;
    expect(validateRefinementActionBodies("heterogeneous-completion.ts", source, "completion", parseSpec("heterogeneous-completion.ts", source).temporal)).toEqual([]);
  });

  it("applies post-try updates only to the caught path of a heterogeneous completion", () => {
    const source = `/* uneffect:
      state returned: int
      state caught: int
      state settled: int
      state observed: int
      state chooseReturn: bool
      init returned = 0
      init caught = 0
      init settled = 0
      init observed = 0
      init chooseReturn = false
      action finish: returned' = chooseReturn ? returned + 1 : returned, caught' = !chooseReturn ? caught + 1 : caught, settled' = settled + 1, observed' = chooseReturn ? observed : observed + 1
    */
      interface Runtime { returned: number; caught: number; settled: number; observed: number; chooseReturn: boolean }
      /* uneffect: refinement completion@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement completion@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement completion@1 action finish */
      export function finish(runtime: Runtime) {
        try {
          if (runtime.chooseReturn) { runtime.returned++; return }
          throw "failed"
        } catch {
          runtime.caught++
        } finally {
          runtime.settled++
        }
        runtime.observed++
      }
    `;
    expect(validateRefinementActionBodies("heterogeneous-continuation.ts", source, "completion", parseSpec("heterogeneous-continuation.ts", source).temporal)).toEqual([]);
  });

  it("runs finally on an early-return path without running statements after try", () => {
    const source = `/* uneffect:
      state started: int
      state worked: int
      state released: int
      state observed: int
      state cancelled: bool
      init started = 0
      init worked = 0
      init released = 0
      init observed = 0
      init cancelled = false
      action execute: started' = started + 1, worked' = cancelled ? worked : worked + 1, released' = released + 1, observed' = cancelled ? observed : observed + 1
    */
      interface Runtime { started: number; worked: number; released: number; observed: number; cancelled: boolean }
      /* uneffect: refinement resource@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement resource@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement resource@1 action execute */
      export function execute(runtime: Runtime) {
        try {
          runtime.started++
          if (runtime.cancelled) return
          runtime.worked++
        } finally {
          runtime.released++
        }
        runtime.observed++
      }
    `;
    expect(validateRefinementActionBodies("finally-return.ts", source, "resource", parseSpec("finally-return.ts", source).temporal)).toEqual([]);

    const valueReturn = source.replace("if (runtime.cancelled) return", "if (runtime.cancelled) return runtime.worked");
    expect(validateRefinementActionBodies("finally-value-return.ts", valueReturn, "resource", parseSpec("finally-value-return.ts", valueReturn).temporal)).toEqual([]);
  });

  it("propagates a nested branch return through the enclosing conditional join", () => {
    const source = `/* uneffect:
      state routed: int
      state observed: int
      state outer: bool
      state inner: bool
      init routed = 0
      init observed = 0
      init outer = false
      init inner = false
      action route: routed' = outer ? inner ? routed : routed + 1 : routed, observed' = outer ? inner ? observed : observed + 1 : observed + 1
    */
      interface Runtime { routed: number; observed: number; outer: boolean; inner: boolean }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        if (runtime.outer) {
          if (runtime.inner) return
          runtime.routed++
        }
        runtime.observed++
      }
    `;
    expect(validateRefinementActionBodies("nested-return.ts", source, "routing", parseSpec("nested-return.ts", source).temporal)).toEqual([]);
  });

  it("lets a direct void return in finally override normal completion", () => {
    const source = `/* uneffect:
      state worked: int
      state released: int
      state observed: int
      init worked = 0
      init released = 0
      init observed = 0
      action execute: worked' = worked + 1, released' = released + 1
    */
      interface Runtime { worked: number; released: number; observed: number }
      /* uneffect: refinement resource@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement resource@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement resource@1 action execute */
      export function execute(runtime: Runtime) {
        try {
          runtime.worked++
        } finally {
          runtime.released++
          return
        }
        runtime.observed++
      }
    `;
    expect(validateRefinementActionBodies("finally-return-override.ts", source, "resource", parseSpec("finally-return-override.ts", source).temporal)).toEqual([]);

    const valueReturn = source.replace("          return\n", "          return runtime.released\n");
    expect(validateRefinementActionBodies("finally-value-override.ts", valueReturn, "resource", parseSpec("finally-value-override.ts", valueReturn).temporal)).toEqual([]);
  });

  it("joins a branch-local void return with the continuing path", () => {
    const source = `/* uneffect:
      state value: int
      state stop: bool
      state attempts: int
      init value = 0
      init stop = false
      init attempts = 0
      action route: value' = stop ? value + 1 : value + 2, attempts' = attempts + 1
    */
      interface Runtime { value: number; stop: boolean; attempts: number }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        runtime.attempts++;
        if (runtime.stop) {
          runtime.value += 1;
          return;
        }
        runtime.value += 2;
      }
    `;
    expect(validateRefinementActionBodies("early-return.ts", source, "routing", parseSpec("early-return.ts", source).temporal)).toEqual([]);

    const returningValue = source.replace("return;", "return runtime.value;");
    expect(validateRefinementActionBodies("value-return.ts", returningValue, "routing", parseSpec("value-return.ts", returningValue).temporal)).toEqual([]);

    const effectfulReturn = source.replace("return;", "return computeValue(runtime);");
    expect(validateRefinementActionBodies("effectful-return.ts", effectfulReturn, "routing", parseSpec("effectful-return.ts", effectfulReturn).temporal)).toEqual([
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    ]);

    const insideFinally = source.replace(
      "if (runtime.stop) {",
      "try { if (runtime.stop) {",
    ).replace(
      "runtime.value += 2;\n      }",
      "runtime.value += 2; } finally { runtime.value += 0 }\n      }",
    );
    expect(validateRefinementActionBodies("finally-return.ts", insideFinally, "routing", parseSpec("finally-return.ts", insideFinally).temporal)).toEqual([
      expect.objectContaining({ code: "action-update-mismatch", modelName: "route", target: "value" }),
    ]);
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

  it("unrolls finite for-of literals through return and finally completion", () => {
    const source = `/* uneffect:
      state value: int
      state cleanup: int
      state stop: int
      init value = 0
      init cleanup = 0
      init stop = 0
      action addUntil: value' = stop === 1 ? value + 1 : value + 1 + 2, cleanup' = stop === 1 ? cleanup + 1 : cleanup + 1 + 1
    */
      interface Runtime { value: number; cleanup: number; stop: number }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action addUntil */
      export function addUntil(runtime: Runtime) {
        for (const amount of [1, 2] as const) {
          try {
            runtime.value += amount
            if (runtime.stop === amount) return
          } finally {
            runtime.cleanup++
          }
        }
      }
    `;
    expect(validateRefinementActionBodies("for-of.ts", source, "counter", parseSpec("for-of.ts", source).temporal)).toEqual([]);

    const dynamic = source.replace("[1, 2] as const", "runtime.values");
    expect(validateRefinementActionBodies("dynamic-for-of.ts", dynamic, "counter", parseSpec("dynamic-for-of.ts", dynamic).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addUntil" }),
    );

    const spread = source.replace("[1, 2] as const", "[1, ...amounts] as const");
    expect(validateRefinementActionBodies("spread-for-of.ts", spread, "counter", parseSpec("spread-for-of.ts", spread).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addUntil" }),
    );
  });

  it("propagates early return while unrolling a classic finite for loop", () => {
    const source = `/* uneffect:
      state value: int
      state stop: bool
      init value = 0
      init stop = false
      action addAtMostTwo: value' = stop ? value + 1 : value + 1 + 1
    */
      interface Runtime { value: number; stop: boolean }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action addAtMostTwo */
      export function addAtMostTwo(runtime: Runtime) {
        for (let index = 0; index < 2; index++) {
          runtime.value++
          if (runtime.stop) return
        }
      }
    `;
    expect(validateRefinementActionBodies("returning-for.ts", source, "counter", parseSpec("returning-for.ts", source).temporal)).toEqual([]);
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
      expect.objectContaining({ code: "action-update-mismatch", modelName: "increment", target: "value" }),
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

  it("tracks immutable receiver aliases and rejects mutable or escaping aliases", () => {
    const source = `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
    */
      interface Runtime { value: number }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action increment */
      export function increment(runtime: Runtime) {
        const state = runtime
        const alias = state
        alias.value++
      }
    `;
    expect(validateRefinementActionBodies("receiver-alias.ts", source, "counter", parseSpec("receiver-alias.ts", source).temporal)).toEqual([]);

    const mutable = source.replace("const state = runtime", "let state = runtime");
    expect(validateRefinementActionBodies("mutable-receiver-alias.ts", mutable, "counter", parseSpec("mutable-receiver-alias.ts", mutable).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "increment" }),
    );
    const escaping = source.replace("const alias = state", "const alias = state\n        consume(alias)");
    expect(validateRefinementActionBodies("escaping-receiver-alias.ts", escaping, "counter", parseSpec("escaping-receiver-alias.ts", escaping).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "increment" }),
    );
    const unsupportedAliases = [
      source.replace("const state = runtime\n        const alias = state", "{ const state = runtime }\n        const alias = state"),
      source.replace("const state = runtime", "const state = runtime.value"),
      source.replace("const state = runtime", "const { value: state } = runtime"),
      source.replace("const state = runtime\n        const alias = state", "const state = alias\n        const alias = runtime"),
    ];
    for (const [index, unsupported] of unsupportedAliases.entries()) {
      expect(validateRefinementActionBodies(`unsupported-receiver-alias-${index}.ts`, unsupported, "counter", parseSpec(`unsupported-receiver-alias-${index}.ts`, unsupported).temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "increment" }),
      );
    }
  });

  it("consumes a labeled-block break after finally and before the outer continuation", () => {
    const source = `/* uneffect:
      state sent: int
      state finalized: int
      state continued: int
      state stop: bool
      init sent = 0
      init finalized = 0
      init continued = 0
      init stop = false
      action route: sent' = stop ? sent : sent + 1, finalized' = finalized + 1, continued' = continued + 1
    */
      interface Runtime { sent: number; finalized: number; continued: number; stop: boolean }
      /* uneffect: refinement routing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement routing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement routing@1 action route */
      export function route(runtime: Runtime) {
        delivery: {
          try {
            if (runtime.stop) break delivery
            runtime.sent++
          } finally {
            runtime.finalized++
          }
        }
        runtime.continued++
      }
    `;
    expect(validateRefinementActionBodies("labeled-break.ts", source, "routing", parseSpec("labeled-break.ts", source).temporal)).toEqual([]);

    const unconditional = source
      .replace("sent' = stop ? sent : sent + 1", "sent' = sent")
      .replace("if (runtime.stop) break delivery\n            runtime.sent++", "break delivery\n            runtime.sent += 100");
    expect(validateRefinementActionBodies("unconditional-labeled-break.ts", unconditional, "routing", parseSpec("unconditional-labeled-break.ts", unconditional).temporal)).toEqual([]);

    for (const invalid of [
      source.replace("break delivery", "continue delivery"),
      source.replace("break delivery", "break outside"),
      source.replace("if (runtime.stop) break delivery", "if (runtime.stop) return"),
    ]) expect(validateRefinementActionBodies("invalid-labeled-break.ts", invalid, "routing", parseSpec("invalid-labeled-break.ts", invalid).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "route" }),
    );
  });

  it("ignores unreachable suffixes after unconditional return and throw completions", () => {
    const source = `/* uneffect:
      state attempted: int
      state caught: int
      state unreachable: int
      init attempted = 0
      init caught = 0
      init unreachable = 0
      action fail: attempted' = attempted + 1, caught' = caught + 1
    */
      interface Runtime { attempted: number; caught: number; unreachable: number }
      /* uneffect: refinement completion@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement completion@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement completion@1 action fail */
      export function fail(runtime: Runtime) {
        try {
          runtime.attempted++
          throw true
          runtime.unreachable += 100
        } catch {
          runtime.caught++
          return
          runtime.unreachable += 10
        }
        runtime.unreachable++
      }
    `;
    expect(validateRefinementActionBodies("unreachable-completion.ts", source, "completion", parseSpec("unreachable-completion.ts", source).temporal)).toEqual([]);
  });

  it("propagates nested lexical-block completion without leaking local aliases", () => {
    const source = `/* uneffect:
      state attempted: int
      state completed: int
      state continued: int
      state stop: bool
      init attempted = 0
      init completed = 0
      init continued = 0
      init stop = false
      action run: attempted' = attempted + 1, completed' = stop ? completed : completed + 1, continued' = stop ? continued : continued + 1
    */
      interface Runtime { attempted: number; completed: number; continued: number; stop: boolean }
      /* uneffect: refinement blocks@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement blocks@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement blocks@1 action run */
      export function run(runtime: Runtime) {
        {
          const state = runtime
          state.attempted++
          if (state.stop) return
          state.completed++
        }
        runtime.continued++
      }
    `;
    expect(validateRefinementActionBodies("nested-block.ts", source, "blocks", parseSpec("nested-block.ts", source).temporal)).toEqual([]);

    const leaked = source.replace("runtime.continued++", "state.continued++");
    expect(validateRefinementActionBodies("leaked-block-alias.ts", leaked, "blocks", parseSpec("leaked-block-alias.ts", leaked).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "run" }),
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

  it("resolves imported direct action helpers only in the Program-backed path", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-refinement-"));
    const helperFile = join(directory, "helper.ts");
    const mainFile = join(directory, "main.ts");
    const helper = `
      function insertOwner(runtime: { owners: Set<number> }, owner: number) { runtime.owners.add(owner) }
      export function addOwner(runtime: { owners: Set<number> }, owner: number) { insertOwner(runtime, owner) }
    `;
    const source = `/* uneffect:
      state owners: Set<int>
      init owners = Set(1)
      action addOwner: owners' = owners.union(Set(2))
    */
      import { addOwner as applyOwner } from "./helper.js"
      const ownerOperation = applyOwner
      interface Runtime { owners: Set<number> }
      /* uneffect: refinement authority@1 create */ export function createAuthority(initial: Runtime) { return initial }
      /* uneffect: refinement authority@1 observe */ export function observeAuthority(runtime: Runtime) { return runtime }
      /* uneffect: refinement authority@1 action addOwner */ export function add(runtime: Runtime) { ownerOperation(runtime, 2) }
    `;
    try {
      writeFileSync(helperFile, helper);
      writeFileSync(mainFile, source);
      const spec = parseSpec(mainFile, source).temporal;
      expect(validateRefinementActionBodies(mainFile, source, "authority", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body", modelName: "addOwner",
      }));
      const program = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(program, mainFile, "authority", spec)).toEqual([]);
      const namespaceSource = source
        .replace('import { addOwner as applyOwner } from "./helper.js"\n      const ownerOperation = applyOwner', 'import * as OwnerOperations from "./helper.js"')
        .replace("ownerOperation(runtime, 2)", "OwnerOperations.addOwner(runtime, 2)");
      writeFileSync(mainFile, namespaceSource);
      const namespaceProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(namespaceProgram, mainFile, "authority", spec)).toEqual([]);
      const namespaceAliasSource = namespaceSource
        .replace("interface Runtime", "const namespacedOperation = OwnerOperations.addOwner\n      interface Runtime")
        .replace("OwnerOperations.addOwner(runtime, 2)", "namespacedOperation(runtime, 2)");
      writeFileSync(mainFile, namespaceAliasSource);
      const namespaceAliasProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(namespaceAliasProgram, mainFile, "authority", spec)).toEqual([]);
      writeFileSync(mainFile, namespaceAliasSource.replace("const namespacedOperation", "let namespacedOperation"));
      const mutableNamespaceAliasProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(mutableNamespaceAliasProgram, mainFile, "authority", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body", modelName: "addOwner",
      }));
      writeFileSync(mainFile, source);
      writeFileSync(mainFile, source.replace("const ownerOperation", "let ownerOperation"));
      const mutableAliasProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(mutableAliasProgram, mainFile, "authority", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body", modelName: "addOwner",
      }));
      writeFileSync(mainFile, source);
      writeFileSync(helperFile, `export function addOwner(runtime: { owners: Set<number> }, owner: number) { addOwner(runtime, owner) }`);
      const recursiveProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(recursiveProgram, mainFile, "authority", spec)).toContainEqual(expect.objectContaining({
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

    const aliased = source.replace('export function deliver(runtime: Runtime) { runtime.record("delivered") }', 'export function deliver(runtime: Runtime) { const state = runtime; state.record("delivered") }');
    expect(validateRefinementActionBodies("aliased-method.ts", aliased, "routing", parseSpec("aliased-method.ts", aliased).temporal)).toEqual([
      expect.objectContaining({ code: "action-update-mismatch", modelName: "conditional", exportName: "conditional" }),
    ]);

    const mutableAlias = aliased.replace("const state = runtime", "let state = runtime");
    expect(validateRefinementActionBodies("mutable-method-alias.ts", mutableAlias, "routing", parseSpec("mutable-method-alias.ts", mutableAlias).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "deliver", exportName: "deliver" }),
    );

    const overridden = aliased.replace(
      "      }\n      /* uneffect: refinement routing@1 create */",
      "      }\n      class DerivedRuntime extends Runtime { record(outcome: \"delivered\") { this.attempted += 2; this[outcome] += 2 } }\n      /* uneffect: refinement routing@1 create */",
    );
    expect(validateRefinementActionBodies("overridden-method.ts", overridden, "routing", parseSpec("overridden-method.ts", overridden).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "deliver", exportName: "deliver" }),
    );
  });

  it("resolves imported runtime class methods only in the Program-backed path", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-runtime-method-"));
    const runtimeFile = join(directory, "runtime.ts");
    const mainFile = join(directory, "main.ts");
    const source = `
      import type { Runtime } from "./runtime.js"
      /* uneffect:
       * state sent: int
       * state attempted: int
       * init sent = 0
       * init attempted = 0
       * action record: sent' = sent + 1, attempted' = attempted + 1
       */
      /* uneffect: refinement telemetry@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement telemetry@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement telemetry@1 action record */
      export function record(runtime: Runtime) {
        const state = runtime
        state.record()
      }
    `;
    try {
      writeFileSync(runtimeFile, `
        /* uneffect: trust dispatch-sealing application owns the complete class graph */
        export class Runtime {
          sent = 0
          attempted = 0
          record() { this.attempted++; this.sent++ }
        }
      `);
      writeFileSync(mainFile, source);
      const program = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const spec = parseSpec(mainFile, source).temporal;
      expect(validateRefinementActionBodiesInProgram(program, mainFile, "telemetry", spec)).toEqual([]);
      writeFileSync(runtimeFile, readFileSync(runtimeFile, "utf8").replace("/* uneffect: trust dispatch-sealing application owns the complete class graph */", ""));
      const unsealedProgram = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(unsealedProgram, mainFile, "telemetry", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );
      writeFileSync(runtimeFile, `
        /* uneffect: trust dispatch-sealing application owns the complete class graph */
        export class Runtime {
          sent = 0
          attempted = 0
          record() { this.attempted++; this.sent++ }
        }
      `);
      expect(validateRefinementActionBodies(mainFile, source, "telemetry", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );
      const computed = source.replace("state.record()", 'state["record"]()');
      writeFileSync(mainFile, computed);
      const computedProgram = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(computedProgram, mainFile, "telemetry", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );

      const union = source.replace("export function record(runtime: Runtime)", "export function record(runtime: Runtime | Runtime)");
      writeFileSync(mainFile, union);
      const unionProgram = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(unionProgram, mainFile, "telemetry", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );

      writeFileSync(runtimeFile, `
        export class Runtime {
          sent = 0
          attempted = 0
          record() { this.attempted++; this.sent++ }
        }
        export class DerivedRuntime extends Runtime {
          record() { this.attempted += 2; this.sent += 2 }
        }
      `);
      writeFileSync(mainFile, source);
      const subclassProgram = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(subclassProgram, mainFile, "telemetry", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );

      writeFileSync(runtimeFile, `
        export interface Runtime {
          sent: number
          attempted: number
          record(): void
        }
      `);
      writeFileSync(mainFile, source);
      const structuralProgram = ts.createProgram([mainFile, runtimeFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(structuralProgram, mainFile, "telemetry", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("proves native Set membership and size invariant predicates", () => {
    const source = `/* uneffect:
      state owners: Set<int>
      init owners = Set(1)
      temporal ownerPresent: owners.contains(1)
      temporal boundedOwners: owners.size() <= 2
    */
      interface Runtime { owners: Set<number> }
      /* uneffect: refinement lease@1 create */ export function createLease(initial: Runtime) { return initial }
      /* uneffect: refinement lease@1 observe */ export function observeLease(runtime: Runtime) { return runtime }
      /* uneffect: refinement lease@1 invariant ownerPresent */
      export function ownerPresent(runtime: Runtime) { return runtime.owners.has(1) }
      /* uneffect: refinement lease@1 invariant boundedOwners */
      export function boundedOwners(runtime: Runtime) { return runtime.owners.size <= 2 }
    `;
    expect(validateRefinementInvariantBodies("lease.ts", source, "lease", parseSpec("lease.ts", source).temporal)).toEqual([]);
    const wrongMember = source.replace("runtime.owners.has(1)", "runtime.owners.has(2)");
    expect(validateRefinementInvariantBodies("lease.ts", wrongMember, "lease", parseSpec("lease.ts", wrongMember).temporal)).toContainEqual(
      expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "ownerPresent" }),
    );
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

  it("resolves imported pure invariant helpers only in the Program-backed path", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-invariant-"));
    const helperFile = join(directory, "predicate.ts");
    const mainFile = join(directory, "main.ts");
    const helper = `
      function nonnegative(value: number) { return value >= 0 }
      export function validEpoch(value: number) { return nonnegative(value) }
    `;
    const source = `/* uneffect:
      state epoch: int
      init epoch = 0
      action tick: epoch' = epoch + 1
      temporal validEpoch: epoch >= 0
    */
      import { validEpoch as checkEpoch } from "./predicate.js"
      const epochPredicate = checkEpoch
      interface Runtime { epoch: number }
      /* uneffect: refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 action tick */ export function tick(runtime: Runtime) { runtime.epoch++ }
      /* uneffect: refinement counter@1 invariant validEpoch */ export function invariant(runtime: Runtime) { return epochPredicate(runtime.epoch) }
    `;
    try {
      writeFileSync(helperFile, helper);
      writeFileSync(mainFile, source);
      const spec = parseSpec(mainFile, source).temporal;
      expect(validateRefinementInvariantBodies(mainFile, source, "counter", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-invariant-body", modelName: "validEpoch",
      }));
      const program = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(program, mainFile, "counter", spec)).toEqual([]);
      writeFileSync(mainFile, source.replace("const epochPredicate", "let epochPredicate"));
      const mutableProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(mutableProgram, mainFile, "counter", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-invariant-body", modelName: "validEpoch",
      }));
      writeFileSync(mainFile, source);
      writeFileSync(helperFile, `export function validEpoch(value: number): boolean { return validEpoch(value) }`);
      const recursiveProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(recursiveProgram, mainFile, "counter", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-invariant-body", modelName: "validEpoch",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves runtime object parameters through imported invariant helper layers", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-object-invariant-"));
    const helperFile = join(directory, "predicate.ts");
    const mainFile = join(directory, "main.ts");
    const helper = `
      interface Runtime { delivered: number; dropped: number; attempted: number }
      function outcomes(runtime: Runtime): number { return runtime.delivered + runtime.dropped }
      export function balanced(runtime: Runtime): boolean { return outcomes(runtime) === runtime.attempted }
    `;
    const source = `/* uneffect:
      state delivered: int
      state dropped: int
      state attempted: int
      init delivered = 0
      init dropped = 0
      init attempted = 0
      temporal balanced: delivered + dropped === attempted
    */
      import { balanced as importedBalanced } from "./predicate.js"
      interface Runtime { delivered: number; dropped: number; attempted: number }
      /* uneffect: refinement accounting@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement accounting@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement accounting@1 invariant balanced */
      export function invariant(runtime: Runtime) { return importedBalanced(runtime) }
    `;
    try {
      writeFileSync(helperFile, helper);
      writeFileSync(mainFile, source);
      const spec = parseSpec(mainFile, source).temporal;
      const program = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(program, mainFile, "accounting", spec)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves direct namespace-import invariant helpers in the Program path", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-namespace-invariant-"));
    const helperFile = join(directory, "predicate.ts");
    const mainFile = join(directory, "main.ts");
    const source = `/* uneffect:
      state epoch: int
      init epoch = 0
      temporal valid: epoch >= 0
    */
      import * as Predicates from "./predicate.js"
      interface Runtime { epoch: number }
      /* uneffect: refinement counter@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement counter@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement counter@1 invariant valid */
      export function invariant(runtime: Runtime) { return Predicates.valid(runtime.epoch) }
    `;
    try {
      writeFileSync(helperFile, `export function valid(epoch: number): boolean { return epoch >= 0 }`);
      writeFileSync(mainFile, source);
      const spec = parseSpec(mainFile, source).temporal;
      const program = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(program, mainFile, "counter", spec)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("proves an explicit scalar abstraction relation across concrete field names", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-scalar-abstraction-"));
    const fileName = join(directory, "main.ts");
    const source = `/* uneffect:
      state owner: int
      init owner = 1
      action transfer: owner' = owner + 1
      temporal validOwner: owner >= 0
      abstraction lease@1 owner = ownerId
    */
      interface ModelState { owner: number }
      interface Runtime { ownerId: number }
      /* uneffect: refinement lease@1 create */
      export function create(initial: ModelState): Runtime { return { ownerId: initial.owner } }
      /* uneffect: refinement lease@1 observe */
      export function observe(runtime: Runtime): ModelState { return { owner: runtime.ownerId } }
      /* uneffect: refinement lease@1 action transfer */
      export function transfer(runtime: Runtime): void { runtime.ownerId++ }
      /* uneffect: refinement lease@1 invariant validOwner */
      export function validOwner(runtime: Runtime): boolean { return runtime.ownerId >= 0 }
    `;
    try {
      writeFileSync(fileName, source);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const spec = parseSpec(fileName, source).temporal;
      expect(validateRefinementStateProjectionInProgram(program, fileName, "lease", spec)).toEqual([]);
      expect(validateRefinementActionBodiesInProgram(program, fileName, "lease", spec)).toEqual([]);
      expect(validateRefinementInvariantBodiesInProgram(program, fileName, "lease", spec)).toEqual([]);
      const redirected = source.replace("owner: runtime.ownerId", "owner: runtime.ownerId + 1");
      writeFileSync(fileName, redirected);
      const redirectedProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(redirectedProgram, fileName, "lease", parseSpec(fileName, redirected).temporal)).toContainEqual(
        expect.objectContaining({ code: "observe-state-mismatch", field: "owner", expected: "owner", actual: "owner + 1" }),
      );
      const wrongAction = source.replace("runtime.ownerId++", "runtime.ownerId += 2");
      writeFileSync(fileName, wrongAction);
      const wrongActionProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongActionProgram, fileName, "lease", parseSpec(fileName, wrongAction).temporal)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "transfer", target: "owner", expected: "owner + 1", actual: "owner + 2" }),
      );
      const wrongType = source.replace("interface Runtime { ownerId: number }", "interface Runtime { ownerId: boolean }");
      writeFileSync(fileName, wrongType);
      const wrongTypeProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(wrongTypeProgram, fileName, "lease", parseSpec(fileName, wrongType).temporal)).toContainEqual(
        expect.objectContaining({ code: "create-type-mismatch", field: "owner" }),
      );
      const staleAbstraction = source.replace("abstraction lease@1", "abstraction lease@2");
      writeFileSync(fileName, staleAbstraction);
      const staleAbstractionProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(() => validateRefinementStateProjectionInProgram(staleAbstractionProgram, fileName, "lease", parseSpec(fileName, staleAbstraction).temporal))
        .toThrow(/version 2, expected 1/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refines a renamed builtin Set through projection, action, and invariant checks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-set-abstraction-"));
    const fileName = join(directory, "main.ts");
    const source = `/* uneffect:
      state owners: Set<int>
      init owners = Set(1)
      action admit: owners' = owners.union(Set(2))
      temporal initialOwnerPresent: owners.contains(1)
      abstraction routing@1 owners = activeUserIds
    */
      interface ModelState { owners: Set<number> }
      interface Runtime { activeUserIds: Set<number> }
      /* uneffect: refinement routing@1 create */
      export function create(initial: ModelState): Runtime { return { activeUserIds: initial.owners } }
      /* uneffect: refinement routing@1 observe */
      export function observe(runtime: Runtime): ModelState { return { owners: runtime.activeUserIds } }
      /* uneffect: refinement routing@1 action admit */
      export function admit(runtime: Runtime): void { runtime.activeUserIds.add(2) }
      /* uneffect: refinement routing@1 invariant initialOwnerPresent */
      export function initialOwnerPresent(runtime: Runtime): boolean { return runtime.activeUserIds.has(1) }
    `;
    try {
      writeFileSync(fileName, source);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const spec = parseSpec(fileName, source).temporal;
      expect(buildRefinementBindingManifest(fileName, source, "routing").abstractions).toEqual({ owners: "activeUserIds" });
      expect(validateRefinementStateProjectionInProgram(program, fileName, "routing", spec)).toEqual([]);
      expect(validateRefinementActionBodiesInProgram(program, fileName, "routing", spec)).toEqual([]);
      expect(validateRefinementInvariantBodiesInProgram(program, fileName, "routing", spec)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refines a temporal field through a nested concrete path", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-nested-abstraction-"));
    const fileName = join(directory, "main.ts");
    const source = `/* uneffect:
      state subscribers: Set<int>
      init subscribers = Set(1)
      action admit: subscribers' = subscribers.union(Set(2))
      temporal primaryPresent: subscribers.contains(1)
      abstraction nested@1 subscribers = routing.activeSubscriberIds
    */
      interface ModelState { subscribers: Set<number> }
      interface Runtime { routing: { activeSubscriberIds: Set<number> } }
      /* uneffect: refinement nested@1 create */
      export function create(initial: ModelState): Runtime { return { routing: { activeSubscriberIds: initial.subscribers } } }
      /* uneffect: refinement nested@1 observe */
      export function observe(runtime: Runtime): ModelState { return { subscribers: runtime.routing.activeSubscriberIds } }
      /* uneffect: refinement nested@1 action admit */
      export function admit(runtime: Runtime): void { runtime.routing.activeSubscriberIds.add(2) }
      /* uneffect: refinement nested@1 invariant primaryPresent */
      export function primaryPresent(runtime: Runtime): boolean { return runtime.routing.activeSubscriberIds.has(1) }
    `;
    try {
      writeFileSync(fileName, source);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const spec = parseSpec(fileName, source).temporal;
      expect(validateRefinementStateProjectionInProgram(program, fileName, "nested", spec)).toEqual([]);
      expect(validateRefinementActionBodiesInProgram(program, fileName, "nested", spec)).toEqual([]);
      expect(validateRefinementInvariantBodiesInProgram(program, fileName, "nested", spec)).toEqual([]);
      const wrongAction = source.replace("activeSubscriberIds.add(2)", "activeSubscriberIds.add(3)");
      expect(validateRefinementActionBodies(fileName, wrongAction, "nested", spec)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "admit", target: "subscribers" }),
      );
      const wrongType = source.replace("activeSubscriberIds: Set<number>", "activeSubscriberIds: Set<boolean>");
      writeFileSync(fileName, wrongType);
      const wrongTypeProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(wrongTypeProgram, fileName, "nested", parseSpec(fileName, wrongType).temporal)).toContainEqual(
        expect.objectContaining({ code: "create-type-mismatch", field: "subscribers" }),
      );
      expect(() => buildRefinementBindingManifest(fileName, source.replace(
        "abstraction nested@1 subscribers = routing.activeSubscriberIds",
        "abstraction nested@1 subscribers = routing.activeSubscriberIds\n      abstraction nested@1 other = routing",
      ), "nested")).toThrow(/overlapping abstraction relation/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refines a Set model through a computed array abstraction", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-array-set-abstraction-"));
    const fileName = join(directory, "main.ts");
    const source = `/* uneffect:
      state subscribers: Set<int>
      init subscribers = Set(1)
      action admit: subscribers' = subscribers.union(Set(2))
      action revokePrimary: subscribers' = subscribers.exclude(Set(1))
      action clearSubscribers: subscribers' = Set()
      temporal primaryPresent: subscribers.contains(1)
      temporal nonEmpty: subscribers.size() > 0
      temporal allPositive: subscribers.forall(id => id > 0)
      abstraction arraySet@1 subscribers = Set(routing.activeSubscriberIds)
    */
      interface ModelState { subscribers: Set<number> }
      interface Runtime { routing: { activeSubscriberIds: number[] } }
      /* uneffect: refinement arraySet@1 create */
      export function create(initial: ModelState): Runtime { return { routing: { activeSubscriberIds: Array.from(initial.subscribers) } } }
      /* uneffect: refinement arraySet@1 observe */
      export function observe(runtime: Runtime): ModelState { return { subscribers: new Set(runtime.routing.activeSubscriberIds) } }
      /* uneffect: refinement arraySet@1 action admit */
      export function admit(runtime: Runtime): void { runtime.routing.activeSubscriberIds.push(2) }
      /* uneffect: refinement arraySet@1 action revokePrimary */
      export function revokePrimary(runtime: Runtime): void { const primaryId = 1; runtime.routing.activeSubscriberIds = runtime.routing.activeSubscriberIds.filter(id => id !== primaryId) }
      /* uneffect: refinement arraySet@1 action clearSubscribers */
      export function clearSubscribers(runtime: Runtime): void { runtime.routing.activeSubscriberIds.length = 0 }
      /* uneffect: refinement arraySet@1 invariant primaryPresent */
      export function primaryPresent(runtime: Runtime): boolean { return runtime.routing.activeSubscriberIds.some(id => { return (id === 1) }) }
      /* uneffect: refinement arraySet@1 invariant nonEmpty */
      export function nonEmpty(runtime: Runtime): boolean { return runtime.routing.activeSubscriberIds.length > 0 }
      /* uneffect: refinement arraySet@1 invariant allPositive */
      export function allPositive(runtime: Runtime): boolean { return runtime.routing.activeSubscriberIds.every(id => { const minimum = 0; return id > minimum }) }
    `;
    try {
      writeFileSync(fileName, source);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const spec = parseSpec(fileName, source).temporal;
      expect(buildRefinementBindingManifest(fileName, source, "arraySet").abstractions).toEqual({ subscribers: "Set(routing.activeSubscriberIds)" });
      expect(validateRefinementStateProjectionInProgram(program, fileName, "arraySet", spec)).toEqual([]);
      expect(validateRefinementActionBodiesInProgram(program, fileName, "arraySet", spec)).toEqual([]);
      expect(validateRefinementInvariantBodiesInProgram(program, fileName, "arraySet", spec)).toEqual([]);
      const blockFilter = source.replace("filter(id => id !== primaryId)", "filter(id => { return (id !== primaryId) })");
      writeFileSync(fileName, blockFilter);
      const blockFilterProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(blockFilterProgram, fileName, "arraySet", spec)).toEqual([]);
      const wrongFilter = source.replace("id !== primaryId", "id > primaryId");
      writeFileSync(fileName, wrongFilter);
      const wrongFilterProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongFilterProgram, fileName, "arraySet", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "revokePrimary" }),
      );
      const mutableFilterValue = source.replace("const primaryId = 1", "let primaryId = 1");
      writeFileSync(fileName, mutableFilterValue);
      const mutableFilterProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(mutableFilterProgram, fileName, "arraySet", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "revokePrimary" }),
      );
      const wrongClear = source.replace("activeSubscriberIds.length = 0", "activeSubscriberIds.length = 1");
      writeFileSync(fileName, wrongClear);
      const wrongClearProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongClearProgram, fileName, "arraySet", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "clearSubscribers" }),
      );
      const wrongAction = source.replace("activeSubscriberIds.push(2)", "activeSubscriberIds.push(3)");
      expect(validateRefinementActionBodies(fileName, wrongAction, "arraySet", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "admit" }),
      );
      writeFileSync(fileName, wrongAction);
      const wrongActionProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongActionProgram, fileName, "arraySet", spec)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "admit", target: "subscribers" }),
      );
      const wrongInvariant = source.replace("id === 1", "id === 2");
      writeFileSync(fileName, wrongInvariant);
      const wrongInvariantProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(wrongInvariantProgram, fileName, "arraySet", spec)).toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "primaryPresent" }),
      );
      const mutableQuantifierLocal = source.replace("const minimum = 0", "let minimum = 0");
      writeFileSync(fileName, mutableQuantifierLocal);
      const mutableQuantifierProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(mutableQuantifierProgram, fileName, "arraySet", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "allPositive" }),
      );
      const wrongType = source.replace("activeSubscriberIds: number[]", "activeSubscriberIds: boolean[]");
      writeFileSync(fileName, wrongType);
      const wrongTypeProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(wrongTypeProgram, fileName, "arraySet", parseSpec(fileName, wrongType).temporal)).toContainEqual(
        expect.objectContaining({ code: "create-type-mismatch", field: "subscribers" }),
      );
      const missingConversion = source.replace("Array.from(initial.subscribers)", "[...initial.subscribers]");
      writeFileSync(fileName, missingConversion);
      const missingConversionProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(missingConversionProgram, fileName, "arraySet", parseSpec(fileName, missingConversion).temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-create-body" }),
      );
      const spliceAction = source.replace("activeSubscriberIds.push(2)", "activeSubscriberIds.splice(0, 0, 2)");
      writeFileSync(fileName, spliceAction);
      const spliceProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(spliceProgram, fileName, "arraySet", parseSpec(fileName, spliceAction).temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "admit" }),
      );
      expect(() => buildRefinementBindingManifest(fileName, source.replace(
        "Set(routing.activeSubscriberIds)", "List(routing.activeSubscriberIds)",
      ), "arraySet")).toThrow(/unsupported abstraction expression/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refines a Map model through a computed entry-array abstraction", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-array-map-abstraction-"));
    const fileName = join(directory, "main.ts");
    const source = `/* uneffect:
      state epochs: Map<int, int>
      init epochs = Map([[1, 0]])
      action addFallback: epochs' = epochs.put(2, 1)
      action removePrimary: epochs' = epochs.remove(1)
      action clearEpochs: epochs' = Map([])
      action upsertPrimary: epochs' = epochs.put(1, 5)
      temporal primaryPresent: epochs.keys().contains(1)
      temporal primaryZero: epochs.keys().contains(1) && epochs.get(1) === 0
      temporal nonEmpty: epochs.size() > 0
      temporal nonNegative: epochs.values().forall(epoch => epoch >= 0)
      abstraction mapEntries@1 epochs = Map(storage.epochEntries)
    */
      interface ModelState { epochs: Map<number, number> }
      interface Runtime { storage: { epochEntries: Array<[number, number]> } }
      /* uneffect: refinement mapEntries@1 create */
      export function create(initial: ModelState): Runtime { return { storage: { epochEntries: Array.from(initial.epochs) } } }
      /* uneffect: refinement mapEntries@1 observe */
      export function observe(runtime: Runtime): ModelState { return { epochs: new Map(runtime.storage.epochEntries) } }
      /* uneffect: refinement mapEntries@1 action addFallback */
      export function addFallback(runtime: Runtime): void { runtime.storage.epochEntries.push([2, 1]) }
      /* uneffect: refinement mapEntries@1 action removePrimary */
      export function removePrimary(runtime: Runtime): void { runtime.storage.epochEntries = runtime.storage.epochEntries.filter(entry => entry[0] !== 1) }
      /* uneffect: refinement mapEntries@1 action clearEpochs */
      export function clearEpochs(runtime: Runtime): void { runtime.storage.epochEntries.length = 0 }
      /* uneffect: refinement mapEntries@1 action upsertPrimary */
      export function upsertPrimary(runtime: Runtime): void {
        runtime.storage.epochEntries = runtime.storage.epochEntries.filter(entry => entry[0] !== 1)
        runtime.storage.epochEntries.push([1, 5])
      }
      /* uneffect: refinement mapEntries@1 invariant primaryPresent */
      export function primaryPresent(runtime: Runtime): boolean { return runtime.storage.epochEntries.some(entry => entry[0] === 1) }
      /* uneffect: refinement mapEntries@1 invariant primaryZero */
      export function primaryZero(runtime: Runtime): boolean {
        return runtime.storage.epochEntries.some(entry => entry[0] === 1)
          && runtime.storage.epochEntries.find(entry => entry[0] === 1)![1] === 0
      }
      /* uneffect: refinement mapEntries@1 invariant nonEmpty */
      export function nonEmpty(runtime: Runtime): boolean { return runtime.storage.epochEntries.length > 0 }
      /* uneffect: refinement mapEntries@1 invariant nonNegative */
      export function nonNegative(runtime: Runtime): boolean { return runtime.storage.epochEntries.every(entry => entry[1] >= 0) }
    `;
    try {
      writeFileSync(fileName, source);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const spec = parseSpec(fileName, source).temporal;
      expect(buildRefinementBindingManifest(fileName, source, "mapEntries").abstractions).toEqual({ epochs: "Map(storage.epochEntries)" });
      expect(validateRefinementStateProjectionInProgram(program, fileName, "mapEntries", spec)).toEqual([]);
      expect(validateRefinementActionBodiesInProgram(program, fileName, "mapEntries", spec)).toEqual([]);
      expect(validateRefinementInvariantBodiesInProgram(program, fileName, "mapEntries", spec)).toEqual([]);
      const wrongAction = source.replace("push([2, 1])", "push([2, 2])");
      writeFileSync(fileName, wrongAction);
      const wrongActionProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongActionProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "addFallback", target: "epochs" }),
      );
      const wrongRemoval = source.replace("entry[0] !== 1", "entry[0] !== 2");
      writeFileSync(fileName, wrongRemoval);
      const wrongRemovalProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongRemovalProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "removePrimary", target: "epochs" }),
      );
      const valueFilter = source.replace("entry[0] !== 1", "entry[1] !== 1");
      writeFileSync(fileName, valueFilter);
      const valueFilterProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(valueFilterProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "removePrimary" }),
      );
      const wrongLookup = source.replace("entry[0] === 1", "entry[0] === 2");
      writeFileSync(fileName, wrongLookup);
      const wrongLookupProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(wrongLookupProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "primaryPresent" }),
      );
      const wrongValueLookup = source.replace("find(entry => entry[0] === 1)![1]", "find(entry => entry[0] === 2)![1]");
      writeFileSync(fileName, wrongValueLookup);
      const wrongValueLookupProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(wrongValueLookupProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "primaryZero" }),
      );
      const unsupportedValueLookup = source.replace("find(entry => entry[0] === 1)![1]", "find(entry => entry[1] === 0)![1]");
      writeFileSync(fileName, unsupportedValueLookup);
      const unsupportedValueLookupProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(unsupportedValueLookupProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-invariant-body", modelName: "primaryZero" }),
      );
      const wrongClear = source.replace("epochEntries.length = 0", "epochEntries.length = 1");
      writeFileSync(fileName, wrongClear);
      const wrongClearProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongClearProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "clearEpochs" }),
      );
      const wrongValueInvariant = source.replace("entry[1] >= 0", "entry[1] >= 1");
      writeFileSync(fileName, wrongValueInvariant);
      const wrongValueInvariantProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementInvariantBodiesInProgram(wrongValueInvariantProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "invariant-expression-mismatch", modelName: "nonNegative" }),
      );
      const wrongUpsert = source.replace("push([1, 5])", "push([1, 6])");
      writeFileSync(fileName, wrongUpsert);
      const wrongUpsertProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(wrongUpsertProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "upsertPrimary", target: "epochs" }),
      );
      const differentKeyUpsert = source.replace(
        "epochEntries.filter(entry => entry[0] !== 1)\n        runtime.storage.epochEntries.push([1, 5])",
        "epochEntries.filter(entry => entry[0] !== 2)\n        runtime.storage.epochEntries.push([1, 5])",
      );
      writeFileSync(fileName, differentKeyUpsert);
      const differentKeyUpsertProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementActionBodiesInProgram(differentKeyUpsertProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "action-update-mismatch", modelName: "upsertPrimary", target: "epochs" }),
      );
      expect(validateRefinementActionBodies(fileName, source, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "addFallback" }),
      );
      const wrongType = source.replace("Array<[number, number]>", "Array<[boolean, number]>");
      writeFileSync(fileName, wrongType);
      const wrongTypeProgram = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(wrongTypeProgram, fileName, "mapEntries", spec)).toContainEqual(
        expect.objectContaining({ code: "create-type-mismatch", field: "epochs" }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves imported create and observe wrappers only in the Program-backed path", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-projection-"));
    const helperFile = join(directory, "projection.ts");
    const mainFile = join(directory, "main.ts");
    const source = `/* uneffect:
      state owner: int
      state epoch: int
      init owner = 0
      init epoch = 0
    */
      import { hydrate } from "./projection.js"
      import * as Projections from "./projection.js"
      const createRuntime = hydrate
      interface State { owner: number; epoch: number }
      /* uneffect: refinement lease@1 create */ export function create(initial: State) { return createRuntime(initial) }
      /* uneffect: refinement lease@1 observe */ export function observe(runtime: State) { return Projections.snapshot(runtime) }
    `;
    try {
      writeFileSync(helperFile, `
        interface State { owner: number; epoch: number }
        export function hydrate(initial: State): State { return initial }
        export function snapshot(runtime: State): State { return runtime }
      `);
      writeFileSync(mainFile, source);
      const spec = parseSpec(mainFile, source).temporal;
      expect(validateRefinementStateProjection(mainFile, source, "lease", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-create-body",
      }));
      const program = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(program, mainFile, "lease", spec)).toEqual([]);
      writeFileSync(mainFile, source.replace("interface State { owner: number; epoch: number }", "interface State { owner: number; epoch: boolean }"));
      const wrongShapeProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(wrongShapeProgram, mainFile, "lease", spec)).toContainEqual(expect.objectContaining({
        code: "create-type-mismatch", field: "epoch",
      }));
      writeFileSync(mainFile, source.replace("interface State { owner: number; epoch: number }", "type State = any"));
      const anyProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(anyProgram, mainFile, "lease", spec)).toContainEqual(expect.objectContaining({
        code: "create-type-mismatch",
      }));
      writeFileSync(mainFile, source.replace("export function observe(runtime: State)", "export function observe(runtime: State): any"));
      const anyReturnProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(anyReturnProgram, mainFile, "lease", spec)).toContainEqual(expect.objectContaining({
        code: "observe-type-mismatch",
      }));
      writeFileSync(mainFile, source.replace("const createRuntime", "let createRuntime"));
      const mutableProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(mutableProgram, mainFile, "lease", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-create-body",
      }));
      writeFileSync(mainFile, source);
      writeFileSync(helperFile, `
        interface State { owner: number; epoch: number }
        export function hydrate(initial: State): State { return hydrate(initial) }
        export function snapshot(runtime: State): State { return runtime }
      `);
      const recursiveProgram = ts.createProgram([mainFile, helperFile], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(validateRefinementStateProjectionInProgram(recursiveProgram, mainFile, "lease", spec)).toContainEqual(expect.objectContaining({
        code: "unsupported-create-body",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks builtin Set and Map runtime shapes by symbol identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-collection-projection-"));
    const fileName = join(directory, "main.ts");
    const source = `/* uneffect:
      state owners: Set<int>
      state epochs: Map<int, int>
      init owners = Set()
      init epochs = Map([])
    */
      interface Runtime { owners: Set<number>; epochs: Map<number, number> }
      /* uneffect: refinement authority@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement authority@1 observe */ export function observe(runtime: Runtime) { return runtime }
    `;
    const verify = (text: string) => {
      writeFileSync(fileName, text);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      return validateRefinementStateProjectionInProgram(program, fileName, "authority", parseSpec(fileName, text).temporal);
    };
    try {
      expect(verify(source)).toEqual([]);
      expect(verify(source.replace("interface Runtime", "type Owners = Set<number>\n      interface Runtime").replace("owners: Set<number>", "owners: Owners"))).toEqual([]);
      expect(verify(source.replace("Set<number>", "ReadonlySet<number>"))).toContainEqual(expect.objectContaining({
        code: "create-type-mismatch", field: "owners",
      }));
      expect(verify(source.replace("Map<number, number>", "Map<number, boolean>"))).toContainEqual(expect.objectContaining({
        code: "create-type-mismatch", field: "epochs",
      }));
      expect(verify(source.replace("Set<number>", "FakeSet<number>").replace("interface Runtime", "interface FakeSet<T> { add(value: T): this }\n      interface Runtime"))).toContainEqual(expect.objectContaining({
        code: "create-type-mismatch", field: "owners",
      }));
      expect(verify(source.replace("Set<number>", "OwnerSet").replace("interface Runtime", "class OwnerSet extends Set<number> {}\n      interface Runtime"))).toContainEqual(expect.objectContaining({
        code: "create-type-mismatch", field: "owners",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("only lowers literal while forms whose iteration count is statically exact", () => {
    const model = `/* uneffect:
      state value: int
      state enabled: bool
      init value = 0
      init enabled = false
      action run: value' = value + 1
    */`;
    const exact = `${model}
      interface Runtime { value: number; enabled: boolean }
      /* uneffect: refinement loop@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement loop@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement loop@1 action run */
      export function run(runtime: Runtime) {
        while (false) runtime.value += 100
        do { runtime.value++ } while (false)
      }
    `;
    expect(validateRefinementActionBodies("exact-loop.ts", exact, "loop", parseSpec("exact-loop.ts", exact).temporal)).toEqual([]);

    const dynamic = exact.replace("while (false) runtime.value += 100", "while (runtime.enabled) runtime.value += 100");
    expect(validateRefinementActionBodies("dynamic-loop.ts", dynamic, "loop", parseSpec("dynamic-loop.ts", dynamic).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "run" }),
    );

    const repeated = exact.replace("} while (false)", "} while (runtime.enabled)");
    expect(validateRefinementActionBodies("repeated-loop.ts", repeated, "loop", parseSpec("repeated-loop.ts", repeated).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "run" }),
    );
  });

  it("summarizes only terminating constant-delta state countdown loops", async () => {
    const source = `/* uneffect:
      state pending: int
      state processed: int
      state audited: int
      init pending = 0
      init processed = 0
      init audited = 0
      action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? pending : 0), audited' = audited + 1
    */
      interface Runtime { pending: number; processed: number; audited: number }
      /* uneffect: refinement countdown@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement countdown@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement countdown@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          runtime.processed++
        }
        runtime.audited++
      }
    `;
    const temporal = parseSpec("countdown.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3("countdown.ts", source, "countdown", temporal)).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["countdown-growing.ts", source.replace("pending--", "pending++")],
      ["countdown-coupled.ts", source.replace("processed++", "processed += runtime.pending")],
      ["countdown-zero-step.ts", source.replace("pending--", "pending -= 0")],
      ["countdown-negative-step.ts", source.replace("pending--", "pending -= -2")],
      ["countdown-dynamic-step.ts", source.replace("pending--", "pending -= runtime.audited")],
      ["countdown-unsafe-step.ts", source.replace("pending--", "pending -= 9007199254740992")],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "countdown", temporal)).toContainEqual(
        expect.objectContaining({
          code: fileName === "countdown-coupled.ts" ? "action-update-mismatch" : "unsupported-action-body",
          modelName: "drain",
        }),
      );
    }

    const prefixed = source
      .replace("audited' = audited + 1", "audited' = audited + 2")
      .replace("        while", "        runtime.audited++\n        while");
    const prefixedTemporal = parseSpec("countdown-prefix.ts", prefixed).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "countdown-prefix.ts", prefixed, "countdown", prefixedTemporal,
    )).resolves.toEqual([]);

    const opaquePrefix = source.replace("        while", "        runtime.pending = Math.random()\n        while");
    expect(validateRefinementActionBodies("countdown-opaque-prefix.ts", opaquePrefix, "countdown", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
    );

    const negativeFloor = source
      .replace("pending' = pending > 0 ? 0 : pending", "pending' = pending > -2 ? -2 : pending")
      .replace("processed' = processed + (pending > 0 ? pending : 0)", "processed' = processed + (pending > -2 ? pending + 2 : 0)")
      .replace("runtime.pending > 0", "runtime.pending > -2");
    await expect(validateRefinementActionBodiesWithZ3(
      "countdown-negative-floor.ts", negativeFloor, "countdown", parseSpec("countdown-negative-floor.ts", negativeFloor).temporal,
    )).resolves.toEqual([]);

    const exclusiveFloor = source
      .replace("pending' = pending > 0 ? 0 : pending", "pending' = pending > 3 ? 3 : pending")
      .replace("processed' = processed + (pending > 0 ? pending : 0)", "processed' = processed + (pending > 3 ? pending - 3 : 0)")
      .replace("runtime.pending > 0", "runtime.pending > 3");
    await expect(validateRefinementActionBodiesWithZ3(
      "countdown-exclusive-floor.ts", exclusiveFloor, "countdown", parseSpec("countdown-exclusive-floor.ts", exclusiveFloor).temporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["countdown-dynamic-floor.ts", source.replace("runtime.pending > 0", "runtime.pending > runtime.processed")],
      ["countdown-unsafe-floor.ts", source.replace("runtime.pending > 0", "runtime.pending >= -9007199254740991")],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "countdown", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
      );
    }
  });

  it("summarizes loop-carried affine deltas over the ranking counter", async () => {
    const source = `/* uneffect:
      state pending: int
      state weighted: int
      init pending = 0
      init weighted = 0
      action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? pending * (pending - 1) / 2 : 0)
    */
      interface Runtime { pending: number; weighted: number }
      /* uneffect: refinement triangular@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement triangular@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement triangular@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = parseSpec("triangular.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3("triangular.ts", source, "triangular", temporal)).resolves.toEqual([]);

    const scaled = source
      .replace("pending * (pending - 1) / 2", "pending * (pending + 2)")
      .replace("runtime.weighted += runtime.pending", "runtime.weighted += 2 * runtime.pending + 3");
    await expect(validateRefinementActionBodiesWithZ3(
      "triangular-scaled.ts", scaled, "triangular", parseSpec("triangular-scaled.ts", scaled).temporal,
    )).resolves.toEqual([]);

    const wrongOrder = source.replace(
      "runtime.pending--\n          runtime.weighted += runtime.pending",
      "runtime.weighted += runtime.pending\n          runtime.pending--",
    );
    await expect(validateRefinementActionBodiesWithZ3("triangular-order.ts", wrongOrder, "triangular", temporal)).resolves.toContainEqual(
      expect.objectContaining({ code: "action-update-mismatch", modelName: "drain", target: "weighted" }),
    );

    const selfAmplifying = source.replace("runtime.weighted += runtime.pending", "runtime.weighted += runtime.weighted");
    expect(validateRefinementActionBodies("triangular-self.ts", selfAmplifying, "triangular", temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
    );
  });

  it("summarizes affine branch joins only when their condition is loop-invariant", async () => {
    const source = `/* uneffect:
      state pending: int
      state weighted: int
      state priority: bool
      init pending = 0
      init weighted = 0
      init priority = false
      action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? (priority ? pending * (pending - 1) / 2 : pending) : 0)
    */
      interface Runtime { pending: number; weighted: number; priority: boolean }
      /* uneffect: refinement branchDrain@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement branchDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement branchDrain@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          runtime.pending--
          if (runtime.priority) runtime.weighted += runtime.pending
          else runtime.weighted++
        }
      }
    `;
    const temporal = parseSpec("branch-drain.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "branch-drain.ts", source, "branchDrain", temporal,
    )).resolves.toEqual([]);

    const mutatedCondition = source.replace(
      "else runtime.weighted++",
      "else runtime.weighted++\n          runtime.priority = false",
    );
    expect(validateRefinementActionBodies(
      "branch-drain-mutated-condition.ts", mutatedCondition, "branchDrain", temporal,
    )).toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));

    const counterCondition = source.replaceAll("runtime.priority", "runtime.pending > 2");
    expect(validateRefinementActionBodies(
      "branch-drain-counter-condition.ts", counterCondition, "branchDrain", temporal,
    )).toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));
  });

  it("bounds a loop-invariant affine decision tree at eight leaves", () => {
    const fixture = (leafCount: number): string => {
      const flags = Array.from({ length: leafCount - 1 }, (_, index) => `flag${index}`);
      const branchTotal = flags.reduceRight(
        (otherwise, flag) => `${flag} ? pending * (pending - 1) / 2 : (${otherwise})`,
        "0",
      );
      const branchBody = flags.map((flag, index) => `${index === 0 ? "if" : "else if"} (runtime.${flag}) runtime.weighted += runtime.pending`).join("\n          ");
      return `/* uneffect:
        state pending: int
        state weighted: int
        ${flags.map((flag) => `state ${flag}: bool`).join("\n        ")}
        init pending = 0
        init weighted = 0
        ${flags.map((flag) => `init ${flag} = false`).join("\n        ")}
        action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? (${branchTotal}) : 0)
      */
        interface Runtime { pending: number; weighted: number; ${flags.map((flag) => `${flag}: boolean`).join("; ")} }
        /* uneffect: refinement boundedBranches@1 create */ export function create(initial: Runtime) { return initial }
        /* uneffect: refinement boundedBranches@1 observe */ export function observe(runtime: Runtime) { return runtime }
        /* uneffect: refinement boundedBranches@1 action drain */
        export function drain(runtime: Runtime) {
          while (runtime.pending > 0) {
            runtime.pending--
            ${branchBody}
          }
        }
      `;
    };

    const eightLeaves = fixture(8);
    expect(validateRefinementActionBodies(
      "eight-branch-leaves.ts", eightLeaves, "boundedBranches", parseSpec("eight-branch-leaves.ts", eightLeaves).temporal,
    )).toEqual([]);

    const nineLeaves = fixture(9);
    expect(validateRefinementActionBodies(
      "nine-branch-leaves.ts", nineLeaves, "boundedBranches", parseSpec("nine-branch-leaves.ts", nineLeaves).temporal,
    )).toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));
  });

  it("consumes continue only after every path takes the affine ranking step", async () => {
    const source = `/* uneffect:
      state pending: int
      state weighted: int
      state audited: int
      state priority: bool
      init pending = 0
      init weighted = 0
      init audited = 0
      init priority = false
      action drain: pending' = pending > 0 ? 0 : pending, weighted' = weighted + (pending > 0 ? (!priority ? 0 : pending * (pending - 1) / 2) : 0), audited' = audited + (pending > 0 ? pending : 0)
    */
      interface Runtime { pending: number; weighted: number; audited: number; priority: boolean }
      /* uneffect: refinement continueFinally@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement continueFinally@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement continueFinally@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          try {
            runtime.pending--
            if (!runtime.priority) continue
            runtime.weighted += runtime.pending
          } finally {
            runtime.audited++
          }
        }
      }
    `;
    const temporal = parseSpec("continue-finally.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "continue-finally.ts", source, "continueFinally", temporal,
    )).resolves.toEqual([]);

    const skippedStep = source.replace(
      "runtime.pending--\n            if (!runtime.priority) continue",
      "if (!runtime.priority) continue\n            runtime.pending--",
    );
    expect(validateRefinementActionBodies(
      "continue-finally-skipped-step.ts", skippedStep, "continueFinally", temporal,
    )).toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));

    for (const [fileName, changed, code = "unsupported-action-body"] of [
      ["continue-finally-return.ts", source.replace("if (!runtime.priority) continue", "if (!runtime.priority) return")],
      ["continue-finally-throw.ts", source.replace("if (!runtime.priority) continue", "if (!runtime.priority) throw false")],
      ["continue-finally-break.ts", source.replace(
        "if (!runtime.priority) continue", "if (!runtime.priority) break",
      ), "action-update-mismatch"],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "continueFinally", temporal)).toContainEqual(
        expect.objectContaining({ code, modelName: "drain" }),
      );
    }
  });

  it("splits a zero-update early break from the repeating affine path", async () => {
    const source = `/* uneffect:
      state pending: int
      state weighted: int
      state paused: bool
      state requestedPause: bool
      init pending = 0
      init weighted = 0
      init paused = false
      init requestedPause = false
      action drain: pending' = pending > 0 ? (requestedPause ? pending : 0) : pending, weighted' = weighted + (pending > 0 ? (requestedPause ? 0 : pending * (pending - 1) / 2) : 0), paused' = requestedPause
    */
      interface Runtime { pending: number; weighted: number; paused: boolean; requestedPause: boolean }
      /* uneffect: refinement earlyBreak@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement earlyBreak@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement earlyBreak@1 action drain */
      export function drain(runtime: Runtime) {
        runtime.paused = runtime.requestedPause
        while (runtime.pending > 0) {
          if (runtime.paused) break
          runtime.pending--
          runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = parseSpec("early-break.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "early-break.ts", source, "earlyBreak", temporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed, code = "unsupported-action-body"] of [
      ["early-break-after-update.ts", source.replace(
        "if (runtime.paused) break\n          runtime.pending--",
        "runtime.pending--\n          if (runtime.paused) break",
      ), "action-update-mismatch"],
      ["early-break-mutated-condition.ts", source.replace(
        "runtime.weighted += runtime.pending",
        "runtime.weighted += runtime.pending\n          runtime.paused = true",
      )],
      ["early-break-counter-condition.ts", source.replace(
        "if (runtime.paused) break",
        "if (runtime.pending === 2) break",
      )],
      ["early-break-finally-update.ts", source.replace(
        "if (runtime.paused) break",
        "try { if (runtime.paused) break } finally { runtime.weighted++ }",
      ), "action-update-mismatch"],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "earlyBreak", temporal)).toContainEqual(
        expect.objectContaining({ code, modelName: "drain" }),
      );
    }
  });

  it("composes one affine state update on an invariant early-break path", async () => {
    const source = `/* uneffect:
      state pending: int
      state weighted: int
      state deferred: int
      state paused: bool
      init pending = 0
      init weighted = 0
      init deferred = 0
      init paused = false
      action drain: pending' = pending > 0 ? (paused ? pending : 0) : pending, weighted' = weighted + (pending > 0 ? (paused ? 0 : pending * (pending - 1) / 2) : 0), deferred' = deferred + (pending > 0 ? (paused ? pending : 0) : 0)
    */
      interface Runtime { pending: number; weighted: number; deferred: number; paused: boolean }
      /* uneffect: refinement stateChangingBreak@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement stateChangingBreak@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement stateChangingBreak@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.paused) {
            runtime.deferred += runtime.pending
            break
          }
          runtime.pending--
          runtime.weighted += runtime.pending
        }
      }
    `;
    const temporal = parseSpec("state-changing-break.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "state-changing-break.ts", source, "stateChangingBreak", temporal,
    )).resolves.toEqual([]);

    const finallySource = source
      .replace(
        "deferred' = deferred + (pending > 0 ? (paused ? pending : 0) : 0)",
        "deferred' = deferred + (pending > 0 ? (paused ? pending : pending * (pending - 1) / 2) : 0)",
      )
      .replace(
        `if (runtime.paused) {
            runtime.deferred += runtime.pending
            break
          }
          runtime.pending--
          runtime.weighted += runtime.pending`,
        `try {
            if (runtime.paused) break
            runtime.pending--
            runtime.weighted += runtime.pending
          } finally {
            runtime.deferred += runtime.pending
          }`,
      );
    const finallyTemporal = parseSpec("state-changing-break-finally.ts", finallySource).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "state-changing-break-finally.ts", finallySource, "stateChangingBreak", finallyTemporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed, code = "unsupported-action-body"] of [
      ["state-changing-break-counter.ts", source.replace(
        "runtime.deferred += runtime.pending\n            break",
        "runtime.deferred += runtime.pending\n            runtime.pending--\n            break",
      ), "action-update-mismatch"],
      ["state-changing-break-two-updates.ts", source.replace(
        "runtime.deferred += runtime.pending\n            break",
        "runtime.deferred += runtime.pending\n            runtime.weighted++\n            break",
      ), "action-update-mismatch"],
      ["state-changing-break-coupled.ts", source.replace(
        "runtime.deferred += runtime.pending",
        "runtime.deferred += runtime.weighted",
      )],
      ["state-changing-break-nonlinear.ts", source.replace(
        "runtime.deferred += runtime.pending",
        "runtime.deferred *= runtime.pending",
      )],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "stateChangingBreak", temporal)).toContainEqual(
        expect.objectContaining({ code, modelName: "drain" }),
      );
    }
  });

  it("bounds independent affine early-break updates at eight state fields", async () => {
    const fixture = (count: number): string => {
      const names = Array.from({ length: count }, (_, index) => `metric${index}`);
      const states = names.map((name) => `state ${name}: int`).join("\n      ");
      const inits = names.map((name) => `init ${name} = 0`).join("\n      ");
      const actionUpdates = names.map((name, index) => (
        `${name}' = ${name} + (pending > 0 ? (paused ? ${index + 1} * pending : 0) : 0)`
      )).join(", ");
      const fields = names.map((name) => `${name}: number`).join("; ");
      const updates = names.map((name, index) => (
        `runtime.${name} += ${index + 1} * runtime.pending`
      )).join("\n            ");
      return `/* uneffect:
      state pending: int
      state paused: bool
      ${states}
      init pending = 0
      init paused = false
      ${inits}
      action drain: pending' = pending > 0 ? (paused ? pending : 0) : pending, ${actionUpdates}
    */
      interface Runtime { pending: number; paused: boolean; ${fields} }
      /* uneffect: refinement breakBudget@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement breakBudget@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement breakBudget@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.paused) {
            ${updates}
            break
          }
          runtime.pending--
        }
      }
    `;
    };

    const eightUpdates = fixture(8);
    await expect(validateRefinementActionBodiesWithZ3(
      "eight-break-updates.ts", eightUpdates, "breakBudget", parseSpec("eight-break-updates.ts", eightUpdates).temporal,
    )).resolves.toEqual([]);

    const nineUpdates = fixture(9);
    expect(validateRefinementActionBodies(
      "nine-break-updates.ts", nineUpdates, "breakBudget", parseSpec("nine-break-updates.ts", nineUpdates).temporal,
    )).toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));
  });

  it("joins a caught scalar failure through ranking finally into an affine break", async () => {
    const source = `/* uneffect:
      state pending: int
      state processed: int
      state failed: int
      state audited: int
      state fatal: bool
      init pending = 0
      init processed = 0
      init failed = 0
      init audited = 0
      init fatal = false
      action drain: pending' = pending > 0 ? (fatal ? pending - 1 : 0) : pending, processed' = processed + (pending > 0 ? (fatal ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (fatal ? pending : 0) : 0), audited' = audited + (pending > 0 ? (fatal ? 1 : pending) : 0)
    */
      interface Runtime { pending: number; processed: number; failed: number; audited: number; fatal: boolean }
      /* uneffect: refinement caughtRankingBreak@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement caughtRankingBreak@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement caughtRankingBreak@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          try {
            if (runtime.fatal) throw runtime.pending
            runtime.processed += runtime.pending
          } catch (amount) {
            runtime.failed += amount
            break
          } finally {
            runtime.pending--
            runtime.audited++
          }
        }
      }
    `;
    const temporal = parseSpec("caught-ranking-break.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "caught-ranking-break.ts", source, "caughtRankingBreak", temporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["caught-ranking-break-different-step.ts", source.replace(
        "runtime.pending--\n            runtime.audited++",
        "runtime.pending -= runtime.fatal ? 2 : 1\n            runtime.audited++",
      )],
      ["caught-ranking-break-coupled.ts", source.replace(
        "runtime.failed += amount",
        "runtime.failed += runtime.processed",
      )],
      ["caught-ranking-break-rethrow.ts", source.replace(
        "runtime.failed += amount\n            break",
        "runtime.failed += amount\n            throw amount",
      )],
      ["caught-ranking-break-mutated-condition.ts", source.replace(
        "runtime.audited++",
        "runtime.audited++\n            runtime.fatal = false",
      )],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "caughtRankingBreak", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
      );
    }
  });

  it("records a budgeted fixed point for a ranking loop throw/normal join", () => {
    const source = `/* uneffect:
      state pending: int
      state delivered: int
      state failed: int
      state audited: int
      state reject: bool
      init pending = 0
      init delivered = 0
      init failed = 0
      init audited = 0
      init reject = false
      action drain: pending' = pending > 0 ? 0 : pending, delivered' = delivered + (pending > 0 ? (reject ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (reject ? pending * (pending + 1) / 2 : 0) : 0), audited' = audited + (pending > 0 ? pending : 0)
    */
      interface Runtime { pending: number; delivered: number; failed: number; audited: number; reject: boolean }
      /* uneffect: refinement fixedPointJoin@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement fixedPointJoin@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement fixedPointJoin@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          try {
            if (runtime.reject) throw runtime.pending
            runtime.delivered += runtime.pending
          } catch (amount) {
            runtime.failed += amount
          } finally {
            runtime.pending--
            runtime.audited++
          }
        }
      }
    `;
    const spec = parseSpec("fixed-point-join.ts", source).temporal;
    const analysis = analyzeRefinementActionBodies(
      "fixed-point-join.ts", source, "fixedPointJoin", spec,
      { proofBudget: { cfgFixedPointIterations: 16 } },
    );
    expect(analysis).toMatchObject({
      schema: "uneffect-refinement-action-analysis/v1",
      schemaVersion: 1,
      sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      typescriptVersion: ts.version,
      diagnostics: [],
      obligations: [{
        kind: "ranking-loop-fixed-point",
        modelName: "drain",
        status: "verified",
        loopSpan: { start: expect.any(Number), end: expect.any(Number) },
        trySpan: { start: expect.any(Number), end: expect.any(Number) },
        budget: { name: "cfg-fixed-point-iterations", limit: 16 },
        fixedPoint: {
          converged: true,
          valueLattice: {
            throwPayloads: ["runtime.pending"],
            normalSnapshots: ["catch-normal", "try-normal"],
          },
        },
        completionJoin: {
          predecessors: ["normal", "throw"],
          retainedThrowPayload: true,
          retainedNormalSnapshot: true,
        },
      }],
    });
    expect(analysis.obligations[0]?.fixedPoint.iterations).toBeLessThanOrEqual(16);
    expect(JSON.parse(readFileSync("schemas/uneffect-refinement-action-analysis-v1.schema.json", "utf8"))).toMatchObject({
      properties: {
        schema: { const: "uneffect-refinement-action-analysis/v1" },
        schemaVersion: { const: 1 },
      },
      $defs: {
        rankingLoop: {
          properties: {
            budget: { properties: { name: { const: "cfg-fixed-point-iterations" } } },
          },
        },
      },
    });

    const exhausted = analyzeRefinementActionBodies(
      "fixed-point-budget.ts", source, "fixedPointJoin", spec,
      { proofBudget: { cfgFixedPointIterations: 1 } },
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "ranking-loop-fixed-point",
      status: "unknown",
      reason: "proof-budget-exhausted",
    }));
    expect(exhausted.diagnostics).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body",
      modelName: "drain",
    }));

    const unaligned = source.replace("runtime.failed += amount", "runtime.failed += runtime.delivered");
    const unalignedAnalysis = analyzeRefinementActionBodies(
      "fixed-point-unaligned.ts", unaligned, "fixedPointJoin", spec,
      { proofBudget: { cfgFixedPointIterations: 16 } },
    );
    expect(unalignedAnalysis.obligations).toContainEqual(expect.objectContaining({
      kind: "ranking-loop-fixed-point",
      status: "unknown",
      reason: "unsupported-recurrence",
    }));
    expect(unalignedAnalysis.diagnostics).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body",
      modelName: "drain",
    }));
    expect(() => analyzeRefinementActionBodies(
      "fixed-point-invalid-budget.ts", source, "fixedPointJoin", spec,
      { proofBudget: { cfgFixedPointIterations: 0 } },
    )).toThrow(/cfgFixedPointIterations must be a positive safe integer/);
  });

  it("joins caught break and continue completions after one common ranking finally", async () => {
    const source = `/* uneffect:
      state pending: int
      state delivered: int
      state failed: int
      state retried: int
      state attempts: int
      state fatal: bool
      state stopOnFailure: bool
      init pending = 0
      init delivered = 0
      init failed = 0
      init retried = 0
      init attempts = 0
      init fatal = false
      init stopOnFailure = false
      action drain: pending' = pending > 0 ? (fatal && stopOnFailure ? pending - 1 : 0) : pending, delivered' = delivered + (pending > 0 ? (fatal ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (fatal ? (stopOnFailure ? pending : pending * (pending + 1) / 2) : 0) : 0), retried' = retried + (pending > 0 ? (fatal && !stopOnFailure ? pending * (pending + 1) / 2 : 0) : 0), attempts' = attempts + (pending > 0 ? (fatal && stopOnFailure ? 1 : pending) : 0)
    */
      interface Runtime { pending: number; delivered: number; failed: number; retried: number; attempts: number; fatal: boolean; stopOnFailure: boolean }
      /* uneffect: refinement caughtPolicyJoin@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement caughtPolicyJoin@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement caughtPolicyJoin@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          try {
            if (runtime.fatal) throw runtime.pending
            runtime.delivered += runtime.pending
          } catch (amount) {
            runtime.failed += amount
            if (runtime.stopOnFailure) break
            runtime.retried += amount
            continue
          } finally {
            runtime.pending--
            runtime.attempts++
          }
        }
      }
    `;
    const temporal = parseSpec("caught-policy-join.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "caught-policy-join.ts", source, "caughtPolicyJoin", temporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["caught-policy-skipped-continue-step.ts", source.replace(
        "runtime.pending--\n            runtime.attempts++",
        "if (runtime.stopOnFailure) runtime.pending--\n            runtime.attempts++",
      )],
      ["caught-policy-dynamic-break.ts", source.replace(
        "if (runtime.stopOnFailure) break",
        "if (runtime.pending === 1) break",
      )],
      ["caught-policy-mutated-policy.ts", source.replace(
        "runtime.attempts++",
        "runtime.attempts++\n            runtime.stopOnFailure = false",
      )],
      ["caught-policy-rethrow.ts", source.replace(
        "runtime.retried += amount\n            continue",
        "runtime.retried += amount\n            throw amount",
      )],
      ["caught-policy-coupled.ts", source.replace(
        "runtime.failed += amount",
        "runtime.failed += runtime.delivered",
      )],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "caughtPolicyJoin", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
      );
    }
  });

  it("bounds path-wise affine updates for a disjunctive invariant break", async () => {
    const fixture = (count: number): string => {
      const flags = Array.from({ length: count }, (_, index) => `stop${index}`);
      const stopCondition = flags.join(" || ");
      const stoppedDelta = flags.reduceRight(
        (otherwise, flag, index) => `${flag} ? ${index + 1} * pending : (${otherwise})`,
        "0",
      );
      const flagStates = flags.map((flag) => `state ${flag}: bool`).join("\n      ");
      const flagInits = flags.map((flag) => `init ${flag} = false`).join("\n      ");
      const flagFields = flags.map((flag) => `${flag}: boolean`).join("; ");
      const branches = flags.map((flag, index) => `
          if (runtime.${flag}) {
            runtime.stoppedWeight += ${index + 1} * runtime.pending
            break
          }`).join("");
      return `/* uneffect:
      state pending: int
      state processed: int
      state stoppedWeight: int
      ${flagStates}
      init pending = 0
      init processed = 0
      init stoppedWeight = 0
      ${flagInits}
      action drain: pending' = pending > 0 ? (${stopCondition} ? pending : 0) : pending, processed' = processed + (pending > 0 ? (${stopCondition} ? 0 : pending * (pending - 1) / 2) : 0), stoppedWeight' = stoppedWeight + (pending > 0 ? (${stoppedDelta}) : 0)
    */
      interface Runtime { pending: number; processed: number; stoppedWeight: number; ${flagFields} }
      /* uneffect: refinement disjunctiveBudget@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement disjunctiveBudget@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement disjunctiveBudget@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {${branches}
          runtime.pending--
          runtime.processed += runtime.pending
        }
      }
    `;
    };

    const twoPaths = fixture(2);
    const temporal = parseSpec("two-disjunctive-breaks.ts", twoPaths).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "two-disjunctive-breaks.ts", twoPaths, "disjunctiveBudget", temporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["disjunctive-break-coupled.ts", twoPaths.replace(
        "runtime.stoppedWeight += 1 * runtime.pending",
        "runtime.stoppedWeight += runtime.processed",
      )],
      ["disjunctive-break-nonlinear.ts", twoPaths.replace(
        "runtime.stoppedWeight += 1 * runtime.pending",
        "runtime.stoppedWeight *= runtime.pending",
      )],
      ["disjunctive-break-different-counter.ts", twoPaths.replace(
        "runtime.stoppedWeight += 1 * runtime.pending\n            break",
        "runtime.stoppedWeight += 1 * runtime.pending\n            runtime.pending--\n            break",
      )],
      ["disjunctive-break-mutated-policy.ts", twoPaths.replace(
        "runtime.stoppedWeight += 1 * runtime.pending\n            break",
        "runtime.stoppedWeight += 1 * runtime.pending\n            runtime.stop0 = false\n            break",
      )],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "disjunctiveBudget", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }),
      );
    }

    const eightPaths = fixture(8);
    await expect(validateRefinementActionBodiesWithZ3(
      "eight-disjunctive-breaks.ts", eightPaths, "disjunctiveBudget",
      parseSpec("eight-disjunctive-breaks.ts", eightPaths).temporal,
    )).resolves.toEqual([]);

    const ninePaths = fixture(9);
    expect(validateRefinementActionBodies(
      "nine-disjunctive-breaks.ts", ninePaths, "disjunctiveBudget",
      parseSpec("nine-disjunctive-breaks.ts", ninePaths).temporal,
    )).toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));
  });

  it("specializes only entailed facts in a nested Boolean stop tree", async () => {
    const source = `/* uneffect:
      state pending: int
      state processed: int
      state stoppedWeight: int
      state urgent: bool
      state sampled: bool
      state circuitOpen: bool
      init pending = 0
      init processed = 0
      init stoppedWeight = 0
      init urgent = false
      init sampled = false
      init circuitOpen = false
      action drain: pending' = pending > 0 ? ((urgent && sampled) || circuitOpen ? pending : 0) : pending, processed' = processed + (pending > 0 ? ((urgent && sampled) || circuitOpen ? 0 : pending * (pending - 1) / 2) : 0), stoppedWeight' = stoppedWeight + (pending > 0 ? (urgent ? (sampled ? pending : (circuitOpen ? 2 * pending : 0)) : (circuitOpen ? 2 * pending : 0)) : 0)
    */
      interface Runtime { pending: number; processed: number; stoppedWeight: number; urgent: boolean; sampled: boolean; circuitOpen: boolean }
      /* uneffect: refinement nestedStop@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement nestedStop@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement nestedStop@1 action drain */
      export function drain(runtime: Runtime) {
        while (runtime.pending > 0) {
          if (runtime.urgent) {
            if (runtime.sampled) {
              runtime.stoppedWeight += runtime.pending
              break
            }
          }
          if (runtime.circuitOpen) {
            runtime.stoppedWeight += 2 * runtime.pending
            break
          }
          runtime.pending--
          runtime.processed += runtime.pending
        }
      }
    `;
    const temporal = parseSpec("nested-stop.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "nested-stop.ts", source, "nestedStop", temporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["nested-stop-dynamic-policy.ts", source.replace(
        "while (runtime.pending > 0) {",
        "while (runtime.pending > 0) {\n          runtime.urgent = !runtime.urgent",
      )],
      ["nested-stop-different-ranking.ts", source.replace(
        "runtime.stoppedWeight += runtime.pending\n              break",
        "runtime.stoppedWeight += runtime.pending\n              runtime.pending -= 2\n              break",
      )],
      ["nested-stop-unaligned-update.ts", source.replace(
        "runtime.stoppedWeight += runtime.pending\n              break",
        "runtime.stoppedWeight += 3 * runtime.pending\n              break",
      )],
    ] as const) {
      const diagnostics = await validateRefinementActionBodiesWithZ3(
        fileName, changed, "nestedStop", temporal,
      );
      expect(diagnostics).not.toEqual([]);
    }

    const nestedUpdateFixture = (count: number): string => {
      const flags = Array.from({ length: count - 1 }, (_, index) => `route${index}`);
      const fields = flags.map((flag) => `${flag}: boolean`).join("; ");
      const states = flags.map((flag) => `state ${flag}: bool\n      init ${flag} = false`).join("\n      ");
      const branches = [
        ...flags.map((flag, index) => `${index === 0 ? "if" : "else if"} (runtime.${flag}) runtime.stoppedWeight += ${index + 1} * runtime.pending`),
        `else runtime.stoppedWeight += ${count} * runtime.pending`,
      ].join("\n              ");
      return source
        .replace("state circuitOpen: bool", `state circuitOpen: bool\n      ${states}`)
        .replace("circuitOpen: boolean }", `circuitOpen: boolean; ${fields} }`)
        .replace("runtime.stoppedWeight += runtime.pending", `{\n              ${branches}\n              }`);
    };
    const withinBudget = nestedUpdateFixture(3);
    expect(validateRefinementActionBodies(
      "nested-stop-within-budget.ts", withinBudget, "nestedStop",
      parseSpec("nested-stop-within-budget.ts", withinBudget).temporal,
    )).not.toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));
    const overBudget = nestedUpdateFixture(9);
    expect(validateRefinementActionBodies(
      "nested-stop-over-budget.ts", overBudget, "nestedStop",
      parseSpec("nested-stop-over-budget.ts", overBudget).temporal,
    )).toContainEqual(expect.objectContaining({ code: "unsupported-action-body", modelName: "drain" }));
  });

  it("joins initialized mutable scalar locals only across normal if diamonds", async () => {
    const source = `/* uneffect:
      state total: int
      state audited: int
      state urgent: bool
      state sampled: bool
      init total = 0
      init audited = 0
      init urgent = false
      init sampled = false
      action record: total' = total + (sampled ? (urgent ? 5 : 4) : (urgent ? 2 : 1)), audited' = audited + 1
    */
      interface Runtime { total: number; audited: number; urgent: boolean; sampled: boolean }
      /* uneffect: refinement localJoin@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement localJoin@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement localJoin@1 action record */
      export function record(runtime: Runtime) {
        let weight = 1
        if (runtime.urgent) weight = 2
        if (runtime.sampled) weight += 3
        runtime.total += weight
        runtime.audited++
      }
    `;
    const temporal = parseSpec("local-join.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "local-join.ts", source, "localJoin", temporal,
    )).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["local-join-const-write.ts", source.replace("let weight = 1", "const weight = 1")],
      ["local-join-uninitialized.ts", source.replace("let weight = 1", "let weight: number")],
      ["local-join-opaque.ts", source.replace("weight = 2", "weight = Number.parseInt('2')")],
      ["local-join-loop.ts", source.replace(
        "if (runtime.urgent) weight = 2",
        "while (runtime.urgent) { weight = 2; break }",
      )],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "localJoin", temporal)).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );
    }

    const bareBlock = source.replace(
      "if (runtime.urgent) weight = 2",
      "{ weight = 2 }",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      "local-join-bare-block.ts", bareBlock, "localJoin", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const ownedLabel = source.replace(
      "if (runtime.urgent) weight = 2",
      "selected: { weight = 2; break selected }",
    );
    await expect(validateRefinementActionBodiesWithZ3(
      "local-join-labeled.ts", ownedLabel, "localJoin", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const abrupt = source
      .replace(
        "action record: total' = total + (sampled ? (urgent ? 5 : 4) : (urgent ? 2 : 1)), audited' = audited + 1",
        "action record: total' = urgent ? total : total + (sampled ? 4 : 1), audited' = urgent ? audited : audited + 1",
      )
      .replace("if (runtime.urgent) weight = 2", "if (runtime.urgent) { weight = 2; return }");
    await expect(validateRefinementActionBodiesWithZ3(
      "local-join-abrupt.ts", abrupt, "localJoin",
      parseSpec("local-join-abrupt.ts", abrupt).temporal,
    )).resolves.toEqual([]);

    const mismatchedModel = source.replace("weight += 3", "weight += 4");
    await expect(validateRefinementActionBodiesWithZ3(
      "local-join-model-mismatch.ts", mismatchedModel, "localJoin", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));
  });

  it("owns mutable-local snapshots on typed throw and catch edges", async () => {
    const source = `/* uneffect:
      state billed: int
      state audited: int
      state failed: bool
      init billed = 0
      init audited = 0
      init failed = false
      action record: billed' = billed + (failed ? 4 : 3), audited' = audited + 1
    */
      interface Runtime { billed: number; audited: number; failed: boolean }
      /* uneffect: refinement caughtLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement caughtLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement caughtLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.failed) {
            units = 2
            throw units
          }
          units = 3
        } catch (amount) {
          runtime.billed += units + amount
          runtime.audited++
          return
        }
        runtime.billed += units
        runtime.audited++
      }
    `;
    const temporal = parseSpec("caught-local.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "caught-local.ts", source, "caughtLocal", temporal,
    )).resolves.toEqual([]);

    const catchWrite = source.replace(
      "runtime.billed += units + amount",
      "units = 5\n          runtime.billed += units + amount",
    );
    expect(validateRefinementActionBodies(
      "caught-local-catch-write.ts", catchWrite, "caughtLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const opaquePayload = source.replace("throw units", "throw new Error('failed')");
    expect(validateRefinementActionBodies(
      "caught-local-opaque-payload.ts", opaquePayload, "caughtLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "unsupported-action-body", modelName: "record",
    }));

    const rethrow = source.replace(
      "runtime.audited++\n          return",
      "runtime.audited++\n          throw amount",
    );
    expect(validateRefinementActionBodies(
      "caught-local-rethrow.ts", rethrow, "caughtLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const finallyWrite = source.replace(
      "          return\n        }\n        runtime.billed",
      "          return\n        } finally {\n          units = 5\n        }\n        runtime.billed",
    );
    expect(validateRefinementActionBodies(
      "caught-local-finally-write.ts", finallyWrite, "caughtLocal", temporal,
    )).toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    const bothThrow = source
      .replace(
        "action record: billed' = billed + (failed ? 4 : 3), audited' = audited + 1",
        "action record: billed' = billed + (failed ? 4 : 6), audited' = audited + 1",
      )
      .replace(
        "          units = 3\n        } catch",
        "          units = 3\n          throw units\n        } catch",
      )
      .replace("        runtime.billed += units\n        runtime.audited++", "");
    await expect(validateRefinementActionBodiesWithZ3(
      "caught-local-both-throw.ts", bothThrow, "caughtLocal",
      parseSpec("caught-local-both-throw.ts", bothThrow).temporal,
    )).resolves.toEqual([]);
  });

  it("owns mutable-local snapshots entering mandatory finally", async () => {
    const source = `/* uneffect:
      state billed: int
      state audited: int
      state stopped: bool
      init billed = 0
      init audited = 0
      init stopped = false
      action record: billed' = stopped ? billed : billed + 3, audited' = audited + (stopped ? 2 : 3)
    */
      interface Runtime { billed: number; audited: number; stopped: boolean }
      /* uneffect: refinement finallyLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement finallyLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement finallyLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          if (runtime.stopped) {
            units = 2
            return
          }
          units = 3
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = parseSpec("finally-local.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "finally-local.ts", source, "finallyLocal", temporal,
    )).resolves.toEqual([]);

    const underAudited = source.replace("runtime.audited += units", "runtime.audited += 1");
    await expect(validateRefinementActionBodiesWithZ3(
      "finally-local-under-audited.ts", underAudited, "finallyLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record", target: "audited",
    }));

    const mutatedFinallyLocal = source.replace(
      "runtime.audited += units",
      "units += 1\n          runtime.audited += units",
    );
    expect(validateRefinementActionBodies(
      "finally-local-mutation.ts", mutatedFinallyLocal, "finallyLocal", temporal,
    )).toContainEqual(expect.objectContaining({ code: "action-update-mismatch", modelName: "record" }));
  });

  it("owns mutable-local snapshots across scalar switch paths", async () => {
    const source = `/* uneffect:
      state billed: int
      state audited: int
      state kind: int
      init billed = 0
      init audited = 0
      init kind = 0
      action record: billed' = kind === 1 ? billed : billed + (kind === 2 ? 8 : (kind === 3 ? 6 : 2)), audited' = audited + (kind === 1 ? 3 : (kind === 2 ? 4 : (kind === 3 ? 6 : 2)))
    */
      interface Runtime { billed: number; audited: number; kind: number }
      /* uneffect: refinement switchLocal@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement switchLocal@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement switchLocal@1 action record */
      export function record(runtime: Runtime) {
        let units = 1
        try {
          switch (runtime.kind) {
            case 0: units = 2; break
            case 1: units = 3; return
            case 2: units = 4; throw units
            case 3: units = 5
            default: units += 1; break
          }
        } catch (amount) {
          runtime.billed += units + amount
          return
        } finally {
          runtime.audited += units
        }
        runtime.billed += units
      }
    `;
    const temporal = parseSpec("switch-local.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3(
      "switch-local.ts", source, "switchLocal", temporal,
    )).resolves.toEqual([]);

    const defaultFree = `/* uneffect:
      state total: int
      state kind: int
      init total = 0
      init kind = 0
      action record: total' = total + (kind === 0 ? 2 : 1)
    */
      interface Runtime { total: number; kind: number }
      /* uneffect: refinement defaultFreeSwitch@1 create */ export function createDefaultFree(initial: Runtime) { return initial }
      /* uneffect: refinement defaultFreeSwitch@1 observe */ export function observeDefaultFree(runtime: Runtime) { return runtime }
      /* uneffect: refinement defaultFreeSwitch@1 action record */
      export function recordDefaultFree(runtime: Runtime) {
        let units = 1
        switch (runtime.kind) {
          case 0: units = 2; break
        }
        runtime.total += units
      }
    `;
    await expect(validateRefinementActionBodiesWithZ3(
      "switch-local-default-free.ts", defaultFree, "defaultFreeSwitch",
      parseSpec("switch-local-default-free.ts", defaultFree).temporal,
    )).resolves.toEqual([]);

    const brokenFallthrough = source.replace("case 3: units = 5", "case 3: units = 4");
    await expect(validateRefinementActionBodiesWithZ3(
      "switch-local-fallthrough.ts", brokenFallthrough, "switchLocal", temporal,
    )).resolves.toContainEqual(expect.objectContaining({
      code: "action-update-mismatch", modelName: "record",
    }));

    for (const [fileName, changed] of [
      ["switch-local-opaque-discriminant.ts", source.replace("switch (runtime.kind)", "switch (Number(runtime.kind))")],
      ["switch-local-dynamic-case.ts", source.replace("case 0:", "case runtime.audited:")],
      ["switch-local-duplicate-case.ts", source.replace("case 1:", "case 0:")],
      ["switch-local-nested-block.ts", source.replace("case 0: units = 2; break", "case 0: { units = 2 }; break")],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "switchLocal", temporal), fileName).toContainEqual(
        expect.objectContaining({ code: "unsupported-action-body", modelName: "record" }),
      );
    }
  });

  it("summarizes only terminating constant-delta state scale-up loops", async () => {
    const source = `/* uneffect:
      state active: int
      state starts: int
      init active = 0
      init starts = 0
      action scale: active' = active <= -2 ? -1 : active, starts' = starts + (active <= -2 ? -1 - active : 0)
    */
      interface Pool { active: number; starts: number }
      /* uneffect: refinement scaleUp@1 create */ export function create(initial: Pool) { return initial }
      /* uneffect: refinement scaleUp@1 observe */ export function observe(pool: Pool) { return pool }
      /* uneffect: refinement scaleUp@1 action scale */
      export function scale(pool: Pool) {
        while (pool.active <= -2) {
          pool.active++
          pool.starts++
        }
      }
    `;
    const temporal = parseSpec("scale-up.ts", source).temporal;
    await expect(validateRefinementActionBodiesWithZ3("scale-up.ts", source, "scaleUp", temporal)).resolves.toEqual([]);

    for (const [fileName, changed] of [
      ["scale-up-wrong-direction.ts", source.replace("pool.active++", "pool.active--")],
      ["scale-up-zero-step.ts", source.replace("pool.active++", "pool.active += 0")],
      ["scale-up-dynamic-bound.ts", source.replaceAll("pool.active <= -2", "pool.active < pool.starts")],
      ["scale-up-unsafe-bound.ts", source.replaceAll("pool.active <= -2", "pool.active <= 9007199254740991")],
      ["scale-up-coupled.ts", source.replace("pool.starts++", "pool.starts += pool.active")],
    ] as const) {
      expect(validateRefinementActionBodies(fileName, changed, "scaleUp", temporal)).toContainEqual(
        expect.objectContaining({
          code: fileName === "scale-up-coupled.ts" ? "action-update-mismatch" : "unsupported-action-body",
          modelName: "scale",
        }),
      );
    }
  });

  it("unrolls only canonical bounded local-counter while loops", () => {
    const model = `/* uneffect:
      state value: int
      state limit: int
      init value = 0
      init limit = 3
      action addThree: value' = value + 0 + 1 + 2
    */`;
    const exact = `${model}
      interface Runtime { value: number; limit: number }
      /* uneffect: refinement boundedWhile@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement boundedWhile@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement boundedWhile@1 action addThree */
      export function addThree(runtime: Runtime) {
        let index = 0
        while (index < 3) {
          runtime.value += index
          index++
        }
      }
    `;
    expect(validateRefinementActionBodies("bounded-while.ts", exact, "boundedWhile", parseSpec("bounded-while.ts", exact).temporal)).toEqual([]);

    const returning = `/* uneffect:
      state value: int
      state stop: bool
      init value = 0
      init stop = false
      action addAtMostTwo: value' = stop ? value + 1 : value + 1 + 1
    */
      interface Runtime { value: number; stop: boolean }
      /* uneffect: refinement returningWhile@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement returningWhile@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement returningWhile@1 action addAtMostTwo */
      export function addAtMostTwo(runtime: Runtime) {
        let index = 0
        while (index < 2) {
          runtime.value++
          if (runtime.stop) return
          index++
        }
      }
    `;
    expect(validateRefinementActionBodies("returning-while.ts", returning, "returningWhile", parseSpec("returning-while.ts", returning).temporal)).toEqual([]);

    const dynamicBound = exact.replace("index < 3", "index < runtime.limit");
    expect(validateRefinementActionBodies("dynamic-while.ts", dynamicBound, "boundedWhile", parseSpec("dynamic-while.ts", dynamicBound).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addThree" }),
    );

    const nonCanonicalIncrement = exact.replace("index++", "index += 2");
    expect(validateRefinementActionBodies("step-while.ts", nonCanonicalIncrement, "boundedWhile", parseSpec("step-while.ts", nonCanonicalIncrement).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addThree" }),
    );

    const oversized = exact.replace("index < 3", "index < 65");
    expect(validateRefinementActionBodies("oversized-while.ts", oversized, "boundedWhile", parseSpec("oversized-while.ts", oversized).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addThree" }),
    );

    const finalCounterUse = exact.replace("        }\n      }", "        }\n        runtime.value += index\n      }");
    expect(validateRefinementActionBodies("escaping-counter.ts", finalCounterUse, "boundedWhile", parseSpec("escaping-counter.ts", finalCounterUse).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "addThree" }),
    );
  });

  it("consumes an unlabeled bounded-loop break while preserving finally and continuation", () => {
    const source = `/* uneffect:
      state value: int
      state cleaned: int
      state after: int
      state stop: int
      init value = 0
      init cleaned = 0
      init after = 0
      init stop = 0
      action run: value' = stop === 0 ? value + 1 : stop === 1 ? value + 1 + 1 : value + 1 + 1 + 1, cleaned' = stop === 0 ? cleaned + 1 : stop === 1 ? cleaned + 1 + 1 : cleaned + 1 + 1 + 1, after' = after + 1
    */
      interface Runtime { value: number; cleaned: number; after: number; stop: number }
      /* uneffect: refinement breaking@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement breaking@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement breaking@1 action run */
      export function run(runtime: Runtime) {
        for (let index = 0; index < 3; index++) {
          try {
            runtime.value++
            if (runtime.stop === index) break
          } finally {
            runtime.cleaned++
          }
        }
        runtime.after++
      }
    `;
    expect(validateRefinementActionBodies("breaking-for.ts", source, "breaking", parseSpec("breaking-for.ts", source).temporal)).toEqual([]);

    const labeled = source.replace("break\n", "break outer\n").replace("        for (", "        outer: for (");
    expect(validateRefinementActionBodies("labeled-breaking-for.ts", labeled, "breaking", parseSpec("labeled-breaking-for.ts", labeled).temporal)).toEqual([]);
  });

  it("consumes continue only where the finite loop guarantees advancement", async () => {
    const source = `/* uneffect:
      state value: int
      state cleaned: int
      state after: int
      state skip: int
      init value = 0
      init cleaned = 0
      init after = 0
      init skip = 0
      action run: value' = skip === 0 ? value + 1 + 1 : skip === 1 ? value + 1 + 1 : skip === 2 ? value + 1 + 1 : value + 1 + 1 + 1, cleaned' = cleaned + 1 + 1 + 1, after' = after + 1
    */
      interface Runtime { value: number; cleaned: number; after: number; skip: number }
      /* uneffect: refinement continuing@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement continuing@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement continuing@1 action run */
      export function run(runtime: Runtime) {
        for (let index = 0; index < 3; index++) {
          try {
            if (runtime.skip === index) continue
            runtime.value++
          } finally {
            runtime.cleaned++
          }
        }
        runtime.after++
      }
    `;
    await expect(validateRefinementActionBodiesWithZ3("continuing-for.ts", source, "continuing", parseSpec("continuing-for.ts", source).temporal)).resolves.toEqual([]);

    const unsafeWhile = source.replace(
      "for (let index = 0; index < 3; index++) {",
      "let index = 0\n        while (index < 3) {",
    ).replace("          } finally {", "          } finally {").replace("            runtime.cleaned++\n          }", "            runtime.cleaned++\n          }\n          index++");
    expect(validateRefinementActionBodies("continuing-while.ts", unsafeWhile, "continuing", parseSpec("continuing-while.ts", unsafeWhile).temporal)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-body", modelName: "run" }),
    );

    const oneShot = `/* uneffect:
      state cleaned: int
      state after: int
      init cleaned = 0
      init after = 0
      action run: cleaned' = cleaned + 1, after' = after + 1
    */
      interface Runtime { cleaned: number; after: number }
      /* uneffect: refinement oneShotContinue@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement oneShotContinue@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement oneShotContinue@1 action run */
      export function run(runtime: Runtime) {
        do {
          try { continue } finally { runtime.cleaned++ }
        } while (false)
        runtime.after++
      }
    `;
    expect(validateRefinementActionBodies("one-shot-continue.ts", oneShot, "oneShotContinue", parseSpec("one-shot-continue.ts", oneShot).temporal)).toEqual([]);

    const labeled = source.replace("continue\n", "continue batch\n").replace("        for (", "        batch: for (");
    await expect(validateRefinementActionBodiesWithZ3("labeled-continuing-for.ts", labeled, "continuing", parseSpec("labeled-continuing-for.ts", labeled).temporal)).resolves.toEqual([]);

    const crossLoop = `/* uneffect:
      state value: int
      init value = 0
      action run: value' = value
    */
      interface Runtime { value: number }
      /* uneffect: refinement crossLoop@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect: refinement crossLoop@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect: refinement crossLoop@1 action run */
      export function run(runtime: Runtime) {
        outer: for (let index = 0; index < 1; index++) {
          for (let inner = 0; inner < 1; inner++) {
            continue outer
          }
          runtime.value++
        }
      }
    `;
    expect(validateRefinementActionBodies("cross-loop-continue.ts", crossLoop, "crossLoop", parseSpec("cross-loop-continue.ts", crossLoop).temporal)).toEqual([]);
  });
});
