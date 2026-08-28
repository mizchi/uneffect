import { describe, expect, it } from "vitest";
import { analyzeRefinementActionBodies, analyzeRefinementActionBodiesWithZ3 } from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = `/* uneffect:
  state pending: int
  state processed: int
  state sampled: bool
  state audit: bool
  init pending = 0
  init processed = 0
  init sampled = false
  init audit = false
  action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (audit ? (sampled ? 2 * pending : pending) : (sampled ? pending : 0)) : 0)
*/
interface Runtime { pending: number; processed: number; sampled: boolean; audit: boolean }
/* uneffect: refinement twoDiamondDrain@1 create */ export function create(initial: Runtime) { return initial }
/* uneffect: refinement twoDiamondDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
/* uneffect: refinement twoDiamondDrain@1 action drain */
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++
    if (runtime.audit) runtime.processed++
    runtime.pending--
  }
}
`;

describe("two sequential invariant CFG diamonds", () => {
  it("composes both source-ordered phi transformers before one back edge", async () => {
    const spec = parseSpec("two-diamond-drain.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      "two-diamond-drain.ts", fixture, "twoDiamondDrain", spec,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      conditionalJoins: [
        expect.objectContaining({
          order: 0,
          predicate: "sampled",
          rule: "predicate-correlated-affine-phi",
          predecessors: [
            expect.objectContaining({ branch: "then", block: expect.stringMatching(/^statement:/) }),
            expect.objectContaining({ branch: "else", block: expect.stringMatching(/^identity:/) }),
          ],
          join: expect.stringMatching(/^if-join:/),
        }),
        expect.objectContaining({
          order: 1,
          predicate: "audit",
          rule: "predicate-correlated-affine-phi",
          predecessors: [
            expect.objectContaining({ branch: "then", block: expect.stringMatching(/^statement:/) }),
            expect.objectContaining({ branch: "else", block: expect.stringMatching(/^identity:/) }),
          ],
          join: expect.stringMatching(/^if-join:/),
        }),
      ],
    }));

    const verified = await analyzeRefinementActionBodiesWithZ3(
      "two-diamond-drain.ts", fixture, "twoDiamondDrain", spec,
    );
    expect(verified.diagnostics).toEqual([]);
    expect(verified.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      conditionalJoins: [
        expect.objectContaining({ order: 0, predicate: "sampled" }),
        expect.objectContaining({ order: 1, predicate: "audit" }),
      ],
      recurrenceProof: expect.objectContaining({ status: "verified" }),
    }));
  });

  it("keeps reused, mutated, counter-dependent, nested, and third diamonds as non-proofs", () => {
    const spec = parseSpec("two-diamond-drain.ts", fixture).temporal;
    const controls = [
      fixture.replace("if (runtime.audit) runtime.processed++", "if (runtime.sampled) runtime.processed++"),
      fixture.replace("runtime.processed++", "runtime.processed++; runtime.sampled = false"),
      fixture.replace("if (runtime.audit) runtime.processed++", "if (runtime.pending > 0) runtime.processed++"),
      fixture.replace("if (runtime.audit) runtime.processed++", "if (runtime.audit) { if (runtime.sampled) runtime.processed++ }"),
      fixture.replace("runtime.pending--", "if (runtime.sampled) runtime.processed += 0\n    runtime.pending--"),
    ];
    for (const [index, source] of controls.entries()) {
      const analysis = analyzeRefinementActionBodies(
        `two-diamond-broken-${index}.ts`, source, "twoDiamondDrain", spec,
      );
      expect(analysis.obligations).not.toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "verified",
      }));
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body",
        modelName: "drain",
      }));
    }
  });
});
