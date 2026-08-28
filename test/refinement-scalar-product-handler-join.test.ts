import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = (between = "") => `
/* uneffect:
  state total: int
  state audited: int
  state first: bool
  state second: bool
  action compose: total' = total + (first ? 2 : 1) + (second ? 8 : 4), audited' = audited + (first ? 20 : 10) + (second ? 80 : 40)${between ? " + 16" : ""}
*/
interface Runtime { total: number; audited: number; first: boolean; second: boolean }
/* uneffect: refinement scalarProductJoin@1 create */
export function create(initial: Runtime): Runtime { return { ...initial } }
/* uneffect: refinement scalarProductJoin@1 observe */
export function observe(runtime: Runtime): Runtime { return { ...runtime } }
/* uneffect: refinement scalarProductJoin@1 action compose */
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
    ${between}
    try {
      if (runtime.second) throw 2;
      runtime.total += 4;
      runtime.audited += 40;
    } catch {
      runtime.total += 8;
      runtime.audited += 80;
    }
  } catch {}
}
`;

const specOf = (source: string) => parseSpec("scalar-product-handler-join.ts", source).temporal;

describe("product scalar environments across sibling handler regions", () => {
  it("proves both independently updated members and retains per-member Z3 evidence", async () => {
    const source = fixture();
    const structural = analyzeRefinementActionBodies(
      "scalar-product-handler-join.ts", source, "scalarProductJoin", specOf(source),
    );
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "independent-proof-required",
      fixedPoint: expect.objectContaining({
        converged: true,
        members: [
          expect.objectContaining({ state: "audited", regions: [expect.anything(), expect.anything()] }),
          expect.objectContaining({ state: "total", regions: [expect.anything(), expect.anything()] }),
        ],
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "scalar-product-handler-join.ts", source, "scalarProductJoin", specOf(source),
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

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "scalar-product-handler-join.ts",
      source,
      "scalarProductJoin",
      specOf(source),
      { z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" } },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "scalar-proof-unknown",
      proof: expect.objectContaining({
        backend: "z3",
        status: "unknown",
        checks: [
          expect.objectContaining({ state: "audited", status: "unknown" }),
          expect.objectContaining({ state: "total", status: "unknown" }),
        ],
      }),
    }));
  });

  it("does not verify the product when only one declared member matches", async () => {
    const source = fixture().replace("second ? 80 : 40", "second ? 81 : 40");
    const analysis = await analyzeRefinementActionBodiesWithZ3(
      "scalar-product-handler-join.ts", source, "scalarProductJoin", specOf(source),
    );
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
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

  it("reports a member-level inter-region write as a lattice conflict", () => {
    const source = fixture("runtime.audited += 16;");
    const analysis = analyzeRefinementActionBodies(
      "scalar-product-handler-join.ts", source, "scalarProductJoin", specOf(source),
    );
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "lattice-conflict",
      fixedPoint: expect.objectContaining({ converged: false }),
    }));
  });

  it("keeps a third changed integer outside the bounded product", () => {
    const source = fixture()
      .replace("state audited: int", "state audited: int\n  state retries: int")
      .replace(
        "audited' = audited + (first ? 20 : 10) + (second ? 80 : 40)",
        "audited' = audited + (first ? 20 : 10) + (second ? 80 : 40), retries' = retries + 1",
      )
      .replace(
        "interface Runtime { total: number; audited: number;",
        "interface Runtime { total: number; audited: number; retries: number;",
      )
      .replace("runtime.audited += 10;", "runtime.audited += 10; runtime.retries += 1;");
    const analysis = analyzeRefinementActionBodies(
      "scalar-product-handler-join.ts", source, "scalarProductJoin", specOf(source),
    );
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "handler-scalar-environment-join",
      status: "unknown",
      reason: "scalar-cardinality-unsupported",
    }));
  });
});
