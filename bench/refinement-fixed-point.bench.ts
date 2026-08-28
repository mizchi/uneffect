import { bench, describe } from "vitest";
import { analyzeRefinementActionBodies } from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

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
const spec = parseSpec("refinement-fixed-point.ts", source).temporal;

describe("refinement CFG fixed point", () => {
  bench("analyze a ranking loop throw/normal join", () => {
    const result = analyzeRefinementActionBodies(
      "refinement-fixed-point.ts", source, "fixedPointJoin", spec,
      { proofBudget: { cfgFixedPointIterations: 16 } },
    );
    if (result.diagnostics.length !== 0 || result.obligations[0]?.status !== "verified") {
      throw new Error("ranking-loop fixed-point benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });
});
