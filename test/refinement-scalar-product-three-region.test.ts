import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec-ir.js";
import { analyzeSingleActionRefinementBodies as analyzeRefinementActionBodies, analyzeSingleActionRefinementBodiesWithZ3 as analyzeRefinementActionBodiesWithZ3 } from "./refinement-analysis.js";

const fixture = (between = "", fourth = "") => `
/* uneffect: state total: int */ /* uneffect: state audited: int */ /* uneffect: state first: bool */ /* uneffect: state second: bool */ /* uneffect: state third: bool */ /* uneffect: action compose: total' = total + (first ? 2 : 1) + (second ? 8 : 4) + (third ? 32 : 16), audited' = audited + (first ? 20 : 10) + (second ? 80 : 40) + (third ? 320 : 160)${between ? " + 64" : ""} */
interface Runtime {
  total: number; audited: number;
  first: boolean; second: boolean; third: boolean;
}
export function create(initial: Runtime): Runtime { return { ...initial } }
export function observe(runtime: Runtime): Runtime { return { ...runtime } }
export function compose(runtime: Runtime): void {
  try {
    try {
      if (runtime.first) throw 1;
      runtime.total += 1;
      runtime.audited += 10;
    } catch {
      runtime.total += 2;
      runtime.audited += 20;
    }
    try {
      if (runtime.second) throw 2;
      runtime.total += 4;
      runtime.audited += 40;
    } catch {
      runtime.total += 8;
      runtime.audited += 80;
    }
    ${between}
    try {
      if (runtime.third) throw 3;
      runtime.total += 16;
      runtime.audited += 160;
    } catch {
      runtime.total += 32;
      runtime.audited += 320;
    }
    ${fourth}
  } catch {}
}
`;

const specOf = (source: string) => parseSpec("scalar-product-three-region.ts", source).temporal;

describe("product scalar environments across three sibling handler regions", () => {
  it("requires all three source-keyed handoffs and both independent Z3 checks", async () => {
    const source = fixture();
    const structural = analyzeRefinementActionBodies(
      "scalar-product-three-region.ts", source, "scalarProductThreeRegion", specOf(source),
    );
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-join-fixed-point",
      status: "unknown",
      reason: "action-validation-failed",
      controlRootBudget: { name: "handler-control-roots", limit: 3, observed: 3 },
      fixedPoint: expect.objectContaining({ converged: true }),
    }));
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "independent-proof-required",
      regionBudget: { name: "handler-scalar-regions", limit: 3, observed: 3 },
      fixedPoint: expect.objectContaining({
        converged: true,
        members: [
          expect.objectContaining({ state: "audited", regions: [expect.anything(), expect.anything(), expect.anything()] }),
          expect.objectContaining({ state: "total", regions: [expect.anything(), expect.anything(), expect.anything()] }),
        ],
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "scalar-product-three-region.ts", source, "scalarProductThreeRegion", specOf(source),
    );
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "verified",
      proof: {
        backend: "z3",
        status: "verified",
        checks: [
          { state: "audited", status: "verified" },
          { state: "total", status: "verified" },
        ],
      },
    }));
  });

  it("keeps a fourth region machine-readable and over budget", () => {
    const source = fixture("", "try { runtime.total += 64; runtime.audited += 640 } catch {}");
    const analysis = analyzeRefinementActionBodies(
      "scalar-product-three-region.ts", source, "scalarProductThreeRegion", specOf(source),
    );
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "region-budget-exhausted",
      regionBudget: { name: "handler-scalar-regions", limit: 3, observed: 4 },
    }));
  });

  it("keeps an inter-region member write as a lattice conflict", () => {
    const source = fixture("runtime.audited += 64;");
    const analysis = analyzeRefinementActionBodies(
      "scalar-product-three-region.ts", source, "scalarProductThreeRegion", specOf(source),
    );
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "lattice-conflict",
      fixedPoint: expect.objectContaining({ converged: false }),
    }));
  });

  it("keeps worklist exhaustion and one wrong member as non-proofs", async () => {
    const source = fixture();
    const exhausted = analyzeRefinementActionBodies(
      "scalar-product-three-region.ts", source, "scalarProductThreeRegion", specOf(source),
      { proofBudget: { cfgFixedPointIterations: 1 } },
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "proof-budget-exhausted",
    }));

    const wrong = source.replace("third ? 320 : 160", "third ? 321 : 160");
    const checked = await analyzeRefinementActionBodiesWithZ3(
      "scalar-product-three-region.ts", wrong, "scalarProductThreeRegion", specOf(wrong),
    );
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "scalar-proof-refuted",
      proof: {
        backend: "z3",
        status: "refuted",
        checks: [
          { state: "audited", status: "refuted" },
          { state: "total", status: "verified" },
        ],
      },
    }));
  });
});
