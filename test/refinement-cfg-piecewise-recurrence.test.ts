import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec-ir.js";
import { analyzeSingleActionRefinementBodies as analyzeRefinementActionBodies, analyzeSingleActionRefinementBodiesWithZ3 as analyzeRefinementActionBodiesWithZ3 } from "./refinement-analysis.js";

const fixture = `/* uneffect: state pending: int */ /* uneffect: state processed: int */ /* uneffect: state sampled: bool */ /* uneffect: init pending = 0 */ /* uneffect: init processed = 0 */ /* uneffect: init sampled = false */ /* uneffect: action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (sampled ? pending : 0) : 0) */
interface Runtime { pending: number; processed: number; sampled: boolean }
export function create(initial: Runtime) { return initial }
export function observe(runtime: Runtime) { return runtime }
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++
    runtime.pending--
  }
}
`;

describe("piecewise affine recurrence through a CFG diamond", () => {
  it("binds predicate-correlated branch predecessors before independent Z3 proof", async () => {
    const spec = parseSpec("cfg-sampled-drain.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      "cfg-sampled-drain.ts", fixture, "cfgSampledDrain", spec,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      controlJoins: [{
        kind: "loop-invariant-cfg-diamond",
        order: 0,
        selector: { kind: "boolean-state", state: "sampled" },
        rule: "predicate-correlated-affine-phi",
        predecessors: [
          { branch: "then", block: expect.stringMatching(/^statement:/) },
          { branch: "else", block: expect.stringMatching(/^identity:/) },
        ],
        join: expect.stringMatching(/^if-join:/),
      }],
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "cfg-sampled-drain.ts", fixture, "cfgSampledDrain", spec,
    );
    expect(checked.diagnostics).toEqual([]);
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      controlJoins: [expect.objectContaining({
        rule: "predicate-correlated-affine-phi",
      })],
      recurrenceProof: expect.objectContaining({ status: "verified" }),
    }));
  });

  it("keeps mutated or ranking-dependent predicates and nested diamonds as non-proofs", () => {
    const spec = parseSpec("cfg-sampled-drain.ts", fixture).temporal;
    for (const [name, source] of [
      ["mutated", fixture.replace("runtime.pending--", "runtime.sampled = false\n    runtime.pending--")],
      ["ranking-dependent", fixture.replace("runtime.sampled", "runtime.pending > 1")],
      ["nested", fixture.replace(
        "if (runtime.sampled) runtime.processed++",
        "if (runtime.sampled) { if (runtime.pending > 1) runtime.processed++ }",
      )],
    ] as const) {
      const analysis = analyzeRefinementActionBodies(`${name}.ts`, source, "cfgSampledDrain", spec);
      expect(analysis.obligations).not.toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "verified",
        controlJoins: [expect.objectContaining({ rule: "predicate-correlated-affine-phi" })],
      }));
      expect(analysis.diagnostics.some((diagnostic) => diagnostic.modelName === "drain")).toBe(true);
    }
  });
});
