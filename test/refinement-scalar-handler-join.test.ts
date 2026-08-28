import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = (between = "", third = "") => `
/* uneffect:
  state total: int
  state first: bool
  state second: bool
  action compose: total' = total + (first ? 2 : 1) + (second ? 8 : 4)${between ? " + 16" : ""}
*/
interface Runtime { total: number; first: boolean; second: boolean }

/* uneffect: refinement scalarHandlerJoin@1 create */
export function create(initial: Runtime): Runtime { return { ...initial } }

/* uneffect: refinement scalarHandlerJoin@1 observe */
export function observe(runtime: Runtime): Runtime { return { ...runtime } }

/* uneffect: refinement scalarHandlerJoin@1 action compose */
export function compose(runtime: Runtime): void {
  try {
    try {
      if (runtime.first) throw 1;
      runtime.total += 1;
    } catch {
      runtime.total += 2;
    }
    ${between}
    try {
      if (runtime.second) throw 2;
      runtime.total += 4;
    } catch {
      runtime.total += 8;
    }
    ${third}
  } catch {}
}
`;

const analyze = (source: string, limit = 64) => {
  const spec = parseSpec("scalar-handler-join.ts", source).temporal;
  return analyzeRefinementActionBodies(
    "scalar-handler-join.ts",
    source,
    "scalarHandlerJoin",
    spec,
    { proofBudget: { cfgFixedPointIterations: limit } },
  );
};

describe("scalar environments across sibling handler regions", () => {
  it("requires an independent proof after carrying one scalar environment through both regions", async () => {
    const source = fixture();
    const structural = analyze(source);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      modelName: "compose",
      status: "unknown",
      reason: "independent-proof-required",
      regionBudget: { name: "handler-scalar-regions", limit: 2, observed: 2 },
      fixedPoint: expect.objectContaining({
        converged: true,
        members: [
          expect.objectContaining({
            state: "total",
            regions: [
              expect.objectContaining({ id: expect.stringMatching(/^nested-handler-join:/) }),
              expect.objectContaining({ id: expect.stringMatching(/^nested-handler-join:/) }),
            ],
          }),
        ],
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "scalar-handler-join.ts",
      source,
      "scalarHandlerJoin",
      parseSpec("scalar-handler-join.ts", source).temporal,
      { analysis: { proofBudget: { cfgFixedPointIterations: 64 } } },
    );
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      modelName: "compose",
      status: "verified",
      proof: {
        backend: "z3",
        status: "verified",
        checks: [{ state: "total", status: "verified" }],
      },
    }));

    const wrongAction = source.replace("second ? 8 : 4", "second ? 9 : 4");
    const refuted = await analyzeRefinementActionBodiesWithZ3(
      "scalar-handler-join.ts",
      wrongAction,
      "scalarHandlerJoin",
      parseSpec("scalar-handler-join.ts", wrongAction).temporal,
    );
    expect(refuted.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "scalar-proof-refuted",
      proof: {
        backend: "z3",
        status: "refuted",
        checks: [{ state: "total", status: "refuted" }],
      },
    }));

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "scalar-handler-join.ts",
      source,
      "scalarHandlerJoin",
      parseSpec("scalar-handler-join.ts", source).temporal,
      { z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" } },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "scalar-proof-unknown",
      proof: expect.objectContaining({
        backend: "z3",
        status: "unknown",
        checks: [expect.objectContaining({ state: "total", status: "unknown" })],
      }),
    }));
  });

  it("retains an inter-region expression conflict as a non-proof", () => {
    const analysis = analyze(fixture("runtime.total += 16;"));
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      modelName: "compose",
      status: "unknown",
      reason: "lattice-conflict",
      fixedPoint: expect.objectContaining({ converged: false }),
    }));
  });

  it("retains fixed-point budget exhaustion as a non-proof", () => {
    const analysis = analyze(fixture(), 1);
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      modelName: "compose",
      status: "unknown",
      reason: "proof-budget-exhausted",
      budget: { name: "cfg-fixed-point-iterations", limit: 1 },
    }));
  });

  it("retains a third sibling region as an explicit non-proof", () => {
    const analysis = analyze(fixture("", "try { runtime.total += 16 } catch {}"));
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      modelName: "compose",
      status: "unknown",
      reason: "region-budget-exhausted",
      regionBudget: { name: "handler-scalar-regions", limit: 2, observed: 3 },
    }));
  });
});
