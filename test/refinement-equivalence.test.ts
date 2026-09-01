import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec-ir.js";
import { validateRefinementActionBodiesWithZ3, validateRefinementInvariantBodiesWithZ3 } from "../src/refinement-bindings.js";
import { checkTemporalExpressionEquivalenceWithZ3 } from "../src/spec-lint.js";
import { parseTemporalExpression } from "../src/temporal-expressions.js";

const prelude = `/* uneffect: state value: int */ /* uneffect: state armed: bool */ /* uneffect: init value = 0 */ /* uneffect: init armed = false */ /* uneffect: action increment: value' = value + 1 */ /* uneffect: action_when increment: armed && value > 0 */ /* uneffect:always guarded: !armed || value > 0 */
interface Runtime { value: number; armed: boolean }
/* uneffect:refinement refinement counter@1 create */ export function createCounter(initial: Runtime) { return initial }
/* uneffect:refinement refinement counter@1 observe */ export function observeCounter(runtime: Runtime) { return runtime }
`;

describe("Z3-backed refinement expression equivalence", () => {
  it("proves conditional expressions through SMT ite lowering", async () => {
    const spec = parseSpec("conditional.ts", prelude).temporal;
    await expect(checkTemporalExpressionEquivalenceWithZ3(
      spec,
      parseTemporalExpression("armed ? value > 0 : value === 0"),
      parseTemporalExpression("(!armed && value === 0) || (armed && value > 0)"),
    )).resolves.toEqual({ status: "equivalent", backend: "z3" });
  });

  it("proves integer update equivalence and discharges syntax-only action mismatches", async () => {
    const source = `/* uneffect: state value: int */ /* uneffect: state armed: bool */ /* uneffect: init value = 0 */ /* uneffect: init armed = false */ /* uneffect: action increment: value' = armed ? value : value + 1 */
      interface Runtime { value: number; armed: boolean }
      /* uneffect:refinement refinement counter@1 create */ export function create(initial: Runtime) { return initial }
      /* uneffect:refinement refinement counter@1 observe */ export function observe(runtime: Runtime) { return runtime }
      /* uneffect:refinement refinement counter@1 action increment */
      export function increment(runtime: Runtime) { if (runtime.armed) return; runtime.value++ }
    `;
    const spec = parseSpec("integer-equivalence.ts", source).temporal;
    await expect(checkTemporalExpressionEquivalenceWithZ3(
      spec,
      parseTemporalExpression("armed ? value : value + 1"),
      parseTemporalExpression("!armed ? value + 1 : value"),
    )).resolves.toEqual({ status: "equivalent", backend: "z3" });
    expect(await validateRefinementActionBodiesWithZ3("integer-equivalence.ts", source, "counter", spec)).toEqual([]);
  });

  it("accepts logically equivalent invariant and guard syntax", async () => {
    const source = `${prelude}
      /* uneffect:refinement refinement counter@1 action increment */
      export function increment(runtime: Runtime) { if (!(runtime.value > 0 && runtime.armed)) return; runtime.value++ }
      /* uneffect:refinement refinement counter@1 invariant guarded */
      export function guarded(runtime: Runtime) { return !(runtime.armed && runtime.value <= 0) }
    `;
    const spec = parseSpec("counter.ts", source).temporal;
    expect(await validateRefinementActionBodiesWithZ3("counter.ts", source, "counter", spec)).toEqual([]);
    expect(await validateRefinementInvariantBodiesWithZ3("counter.ts", source, "counter", spec)).toEqual([]);
  });

  it("retains real mismatches after finding a counterexample", async () => {
    const source = `${prelude}
      /* uneffect:refinement refinement counter@1 action increment */
      export function increment(runtime: Runtime) { if (!(runtime.armed && runtime.value >= 0)) return; runtime.value++ }
      /* uneffect:refinement refinement counter@1 invariant guarded */
      export function guarded(runtime: Runtime) { return !runtime.armed && runtime.value > 0 }
    `;
    const spec = parseSpec("counter.ts", source).temporal;
    expect(await validateRefinementActionBodiesWithZ3("counter.ts", source, "counter", spec)).toEqual([
      expect.objectContaining({ code: "action-guard-mismatch", equivalence: "different", backend: "z3" }),
    ]);
    expect(await validateRefinementInvariantBodiesWithZ3("counter.ts", source, "counter", spec)).toEqual([
      expect.objectContaining({ code: "invariant-expression-mismatch", equivalence: "different", backend: "z3" }),
    ]);
  });

  it("does not turn unsupported implementation bodies into solver claims", async () => {
    const source = `${prelude}
      /* uneffect:refinement refinement counter@1 action increment */
      export function increment(runtime: Runtime) { runtime.value += helper() }
      /* uneffect:refinement refinement counter@1 invariant guarded */
      export function guarded(runtime: Runtime) { const ok = helperBool(runtime); return ok || runtime.value > 0 }
      declare function helper(): number
      declare function helperBool(runtime: Runtime): boolean
    `;
    const spec = parseSpec("counter.ts", source).temporal;
    expect(await validateRefinementActionBodiesWithZ3("counter.ts", source, "counter", spec)).toContainEqual(
      expect.objectContaining({ code: "missing-action-guard" }),
    );
    expect(await validateRefinementInvariantBodiesWithZ3("counter.ts", source, "counter", spec)).toEqual([
      expect.objectContaining({ code: "unsupported-invariant-body" }),
    ]);
  });
});
