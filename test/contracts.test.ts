import { describe, expect, it } from "vitest";
import { verifyContractObligations, verifyContracts } from "../src/contracts.js";

describe("Hoare contract checker", () => {
  it("proves a valid postcondition", async () => {
    const source = `
      /* uneffect:contract requires x >= 0 */
      /* uneffect:contract ensures result > x */
      function inc(x: number) { return x + 1 }
    `;
    expect(await verifyContracts("ok.ts", source)).toEqual([]);
  });

  it("finds a counterexample", async () => {
    const source = `
      /* uneffect:contract requires x >= 0 */
      /* uneffect:contract ensures result > x */
      function same(x: number) { return x }
    `;
    const [failure] = await verifyContracts("bad.ts", source);
    expect(failure).toMatchObject({ functionName: "same", clause: "ensures" });
    expect(failure?.model).toContain("x");
    expect(failure?.obligationId).toMatch(/^inv_/);
    expect(failure?.artifact).toMatchObject({
      status: "counterexample",
      evidence: "unknown",
      obligationId: failure?.obligationId,
      source: { fileName: "bad.ts" },
    });
  });

  it("checks loop invariant initialization and preservation", async () => {
    const source = `
      /* uneffect:contract requires n >= 0 */
      /* uneffect:contract ensures result == n */
      function count(n: number) {
        let i = 0
        /* uneffect:contract invariant i >= 0 && i <= n */
        while (i < n) { i = i + 1 }
        return i
      }
    `;
    expect(await verifyContracts("loop.ts", source)).toEqual([]);
  });

  it("treats unsupported syntax as a non-proof", async () => {
    const [failure] = await verifyContracts("unsupported.ts", `
      /* uneffect:contract ensures result > 0 */
      function value() { for (;;) break; return 1 }
    `);
    expect(failure).toMatchObject({ functionName: "value", clause: "unsupported" });
    expect(failure?.artifact?.status).toBe("unsupported");
  });

  it("returns machine-readable evidence for successful obligations", async () => {
    const result = await verifyContractObligations("proof.ts", `
      /* uneffect:contract ensures result === x */
      function identity(x: Int): Int { return x }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toEqual([
      expect.objectContaining({ obligationId: expect.stringMatching(/^inv_/), status: "verified", evidence: "verified", source: { fileName: "proof.ts", span: expect.any(Object) } }),
    ]);
  });

  it("does not silently assume that an unmodeled call is pure", async () => {
    const [failure] = await verifyContracts("call.ts", `
      /* uneffect:contract ensures result === x */
      function wrapped(x: Int): Int { touch(); return x }
    `);
    expect(failure).toMatchObject({ clause: "unsupported", message: expect.stringContaining("verified function summary") });
  });

  it("lowers only imported Effect pipe with inline unary expression callbacks", async () => {
    expect(await verifyContracts("effect-pipe.ts", `
      import { pipe as flow } from "effect/Function"
      /* uneffect:contract requires x >= 0 */
      /* uneffect:contract ensures result === x + 2 */
      function addTwo(x: number) { return flow(x, value => value + 1, value => value + 1) }
    `)).toEqual([]);

    const [spoofed] = await verifyContracts("spoofed-pipe.ts", `
      function pipe(value: number, stage: (value: number) => number) { return stage(value) }
      /* uneffect:contract ensures result === x + 1 */
      function addOne(x: number) { return pipe(x, value => value + 1) }
    `);
    expect(spoofed).toMatchObject({ clause: "unsupported", message: expect.stringContaining("unsupported invariant expression") });
  });
});
