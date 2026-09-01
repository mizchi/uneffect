import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";
import { refinementManifest } from "./refinement-manifest.js";

const fixture = `/* uneffect: state pending: int */ /* uneffect: state processed: int */ /* uneffect: init pending = 0 */ /* uneffect: init processed = 0 */ /* uneffect: action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? pending : 0) */
interface Runtime { pending: number; processed: number }
export function create(initial: Runtime) { return initial }
export function observe(runtime: Runtime) { return runtime }
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    runtime.processed++
    runtime.pending--
  }
}
`;

describe("CFG-inferred affine scalar-product recurrence", () => {
  it("keeps structural convergence provisional until every recurrence member and ranking check passes Z3", async () => {
    const spec = parseSpec("cfg-drain.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies("cfg-drain.ts", fixture, "cfgDrain", spec, {},
      refinementManifest("cfg-drain.ts", "cfgDrain", { drain: "drain" }));
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      loopSpan: { start: expect.any(Number), end: expect.any(Number) },
      backEdge: {
        from: expect.stringMatching(/^statement:/),
        to: expect.stringMatching(/^while-header:/),
        rule: "source-bound-affine-transformer",
      },
      budget: { name: "cfg-recurrence-iterations", limit: 64 },
      fixedPoint: expect.objectContaining({
        converged: true,
        recurrence: expect.objectContaining({
          counter: "pending",
          iteration: { pending: "pending - 1", processed: "processed + 1" },
          summary: { pending: "pending > 0 ? 0 : pending", processed: "processed + (pending > 0 ? pending : 0)" },
          stable: true,
        }),
        members: [
          { state: "pending", role: "ranking" },
          { state: "processed", role: "scalar" },
        ],
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "cfg-drain.ts", fixture, "cfgDrain", spec,
      { manifest: refinementManifest("cfg-drain.ts", "cfgDrain", { drain: "drain" }) },
    );
    expect(checked.diagnostics).toEqual([]);
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      recurrenceProof: expect.objectContaining({
        status: "verified",
        checks: expect.arrayContaining([
          { kind: "base", state: "pending", status: "verified" },
          { kind: "step", state: "processed", status: "verified" },
          { kind: "ranking", state: "pending", status: "verified" },
        ]),
      }),
    }));
  });

  it("fails closed for coupled, self-amplifying, path-dependent, budget, and solver controls", async () => {
    const spec = parseSpec("cfg-drain.ts", fixture).temporal;
    for (const [name, source] of [
      ["coupled", fixture.replace("runtime.pending--", "runtime.pending -= runtime.processed")],
      ["self-amplifying", fixture.replace("runtime.processed++", "runtime.processed += runtime.processed")],
      ["path-dependent", fixture.replace("runtime.processed++", "if (runtime.pending > 1) runtime.processed++")],
    ] as const) {
      const fileName = `${name}.ts`;
      const analysis = analyzeRefinementActionBodies(fileName, source, "cfgDrain", spec, {},
        refinementManifest(fileName, "cfgDrain", { drain: "drain" }));
      expect(analysis.obligations).toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "unknown",
        reason: expect.not.stringMatching(/^independent-proof-required$/),
      }));
      expect(analysis.diagnostics.some((diagnostic) => diagnostic.modelName === "drain"
        && (diagnostic.code === "unsupported-action-body"
          || diagnostic.code === "action-update-mismatch"))).toBe(true);
    }

    const exhausted = analyzeRefinementActionBodies(
      "budget.ts", fixture, "cfgDrain", spec,
      { proofBudget: { cfgFixedPointIterations: 1 } },
      refinementManifest("budget.ts", "cfgDrain", { drain: "drain" }),
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "proof-budget-exhausted",
    }));

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "solver.ts", fixture, "cfgDrain", spec,
      {
        z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
        manifest: refinementManifest("solver.ts", "cfgDrain", { drain: "drain" }),
      },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "recurrence-proof-unknown",
    }));
  });
});
