import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";
import { refinementManifest } from "./refinement-manifest.js";

const fixture = (thenPrefix = "", beforeCommon = "") => `
/* uneffect: state total: int */ /* uneffect: state audited: int */ /* uneffect: state route: bool */ /* uneffect: state first: bool */ /* uneffect: state second: bool */ /* uneffect: state common: bool */ /* uneffect: action compose: total' = total + (route ? (first ? 2 : 1) : (second ? 8 : 4)) + (common ? 32 : 16), audited' = audited + (route ? (first ? 20 : 10) : (second ? 80 : 40)) + (common ? 320 : 160)${thenPrefix ? " + (route ? 1 : 0)" : ""}${beforeCommon ? " + 64" : ""} */
interface Runtime {
  total: number; audited: number;
  route: boolean; first: boolean; second: boolean; common: boolean;
}
export function create(initial: Runtime): Runtime { return { ...initial } }
export function observe(runtime: Runtime): Runtime { return { ...runtime } }
export function compose(runtime: Runtime): void {
  try {
    if (runtime.route) {
      ${thenPrefix}
      try {
        if (runtime.first) throw 1;
        runtime.total += 1;
        runtime.audited += 10;
      } catch {
        runtime.total += 2;
        runtime.audited += 20;
      }
    } else {
      try {
        if (runtime.second) throw 2;
        runtime.total += 4;
        runtime.audited += 40;
      } catch {
        runtime.total += 8;
        runtime.audited += 80;
      }
    }
    ${beforeCommon}
    try {
      if (runtime.common) throw 3;
      runtime.total += 16;
      runtime.audited += 160;
    } catch {
      runtime.total += 32;
      runtime.audited += 320;
    }
  } catch {}
}
`;

const specOf = (source: string) => parseSpec("conditional-scalar-product.ts", source).temporal;
const manifest = () => refinementManifest(
  "conditional-scalar-product.ts", "conditionalScalarProduct", { compose: "compose" },
);

describe("conditional scalar-product handler join", () => {
  it("joins both source-keyed predecessors before the common successor", async () => {
    const source = fixture();
    const structural = analyzeRefinementActionBodies(
      "conditional-scalar-product.ts", source, "conditionalScalarProduct", specOf(source), {}, manifest(),
    );
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "independent-proof-required",
      conditionalJoin: {
        kind: "if-handler-predecessors",
        predicate: "route",
        rule: "predicate-correlated-phi",
        predecessors: [
          expect.objectContaining({ branch: "then", regionId: expect.stringMatching(/^nested-handler-join:/) }),
          expect.objectContaining({ branch: "else", regionId: expect.stringMatching(/^nested-handler-join:/) }),
        ],
        successorRegionId: expect.stringMatching(/^nested-handler-join:/),
      },
      fixedPoint: expect.objectContaining({
        converged: true,
        members: [
          expect.objectContaining({ state: "audited", regions: expect.any(Array) }),
          expect.objectContaining({ state: "total", regions: expect.any(Array) }),
        ],
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "conditional-scalar-product.ts", source, "conditionalScalarProduct", specOf(source), { manifest: manifest() },
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

  it("rejects a predecessor entry drift and an inter-join mutation", () => {
    for (const source of [fixture("runtime.audited += 1;"), fixture("", "runtime.audited += 64;")]) {
      const analysis = analyzeRefinementActionBodies(
        "conditional-scalar-product.ts", source, "conditionalScalarProduct", specOf(source), {}, manifest(),
      );
      expect(analysis.obligations).toContainEqual(expect.objectContaining({
        kind: "handler-scalar-environment-join",
        status: "unknown",
        reason: "lattice-conflict",
        fixedPoint: expect.objectContaining({ converged: false }),
      }));
    }
  });

  it("keeps predicate correlation loss and worklist exhaustion as non-proofs", () => {
    const source = fixture();
    const lost = source.replace("if (runtime.route) {", "if (runtime.first) {");
    const lostAnalysis = analyzeRefinementActionBodies(
      "conditional-scalar-product.ts", lost, "conditionalScalarProduct", specOf(lost), {}, manifest(),
    );
    expect(lostAnalysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "predicate-correlation-lost",
    }));

    const exhausted = analyzeRefinementActionBodies(
      "conditional-scalar-product.ts", source, "conditionalScalarProduct", specOf(source),
      { proofBudget: { cfgFixedPointIterations: 1 } },
      manifest(),
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "proof-budget-exhausted",
    }));
  });

  it("keeps one wrong member and solver unavailability as non-proofs", async () => {
    const source = fixture();
    const wrong = source.replace("common ? 320 : 160", "common ? 321 : 160");
    const refuted = await analyzeRefinementActionBodiesWithZ3(
      "conditional-scalar-product.ts", wrong, "conditionalScalarProduct", specOf(wrong), { manifest: manifest() },
    );
    expect(refuted.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "scalar-proof-refuted",
      proof: expect.objectContaining({ status: "refuted" }),
    }));

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "conditional-scalar-product.ts",
      source,
      "conditionalScalarProduct",
      specOf(source),
      {
        z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
        manifest: manifest(),
      },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "scalar-proof-unknown",
    }));
  });
});
