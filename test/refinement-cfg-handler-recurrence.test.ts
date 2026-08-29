import { describe, expect, it } from "vitest";
import { analyzeRefinementActionBodiesWithZ3 } from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = `/* uneffect:temporal state pending: int */ /* uneffect:temporal state delivered: int */ /* uneffect:temporal state failed: int */ /* uneffect:temporal state reject: bool */ /* uneffect:temporal init pending = 0 */ /* uneffect:temporal init delivered = 0 */ /* uneffect:temporal init failed = 0 */ /* uneffect:temporal init reject = false */ /* uneffect:temporal action drain: pending' = pending > 0 ? 0 : pending, delivered' = delivered + (pending > 0 ? (reject ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (reject ? pending * (pending + 1) / 2 : 0) : 0) */
interface Runtime { pending: number; delivered: number; failed: number; reject: boolean }
/* uneffect:refinement refinement cfgHandlerDrain@1 create */ export function create(initial: Runtime) { return initial }
/* uneffect:refinement refinement cfgHandlerDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
/* uneffect:refinement refinement cfgHandlerDrain@1 action drain */
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    try {
      if (runtime.reject) throw runtime.pending
      runtime.delivered += runtime.pending
    } catch (amount) {
      runtime.failed += amount
    } finally {
      runtime.pending--
    }
  }
}
`;

describe("handler-backed scalar recurrence CFG evidence", () => {
  it("uses one shared recurrence artifact with source-bound completion evidence", async () => {
    const spec = parseSpec("cfg-handler-drain.ts", fixture).temporal;
    const analysis = await analyzeRefinementActionBodiesWithZ3(
      "cfg-handler-drain.ts", fixture, "cfgHandlerDrain", spec,
    );
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.obligations.some((obligation) =>
      (obligation as { kind: string }).kind === "ranking-loop-fixed-point")).toBe(false);
    const recurrenceObligations = analysis.obligations.filter((obligation) =>
      obligation.kind === "scalar-recurrence-fixed-point");
    expect(recurrenceObligations).toHaveLength(1);
    expect(recurrenceObligations[0]).toMatchObject({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      handlerCompletion: {
        rule: "source-bound-handler-predecessors",
        trySpan: { start: expect.any(Number), end: expect.any(Number) },
        predecessors: ["normal", "throw"],
        retainedThrowPayload: true,
        retainedNormalSnapshot: true,
        mandatoryFinally: true,
      },
      recurrenceProof: expect.objectContaining({ status: "verified" }),
    });
  });
});
