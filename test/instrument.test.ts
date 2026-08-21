import { describe, expect, it } from "vitest";
import { instrumentOwnershipAssertions, instrumentRuntimeAssertions, optimizeOwnershipAssertions } from "../src/instrument.js";
import { verifyOwnershipObligationWithZ3 } from "../src/evidence.js";

describe("runtime assertion instrumenter", () => {
  it("injects a named numeric assertion into a function", () => {
    const source = `
      import type { Nat } from "uneffect";
      /* uneffect: assert value: Nat */
      function double(value: Nat) { return value * 2 }
    `;
    const result = instrumentRuntimeAssertions("input.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(`import * as __uneffect_v from "valibot";`);
    expect(result.code).toContain(`__uneffect_v.parse(__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.safeInteger(), __uneffect_v.minValue(0)), value);`);
  });

  it("embeds an explicit Valibot schema expression", () => {
    const source = `
      /* uneffect: assert name: v.pipe(v.string(), v.nonEmpty()) */
      function greet(name: string) { return name }
    `;
    const result = instrumentRuntimeAssertions("input.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(`__uneffect_v.parse(__uneffect_v.pipe(__uneffect_v.string(), __uneffect_v.nonEmpty()), name);`);
  });

  it("rejects assertions for unknown parameters", () => {
    const result = instrumentRuntimeAssertions("input.ts", `
      /* uneffect: assert missing: Nat */
      function f(value: number) { return value }
    `);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "unknown-parameter", parameter: "missing" }));
  });

  it("inserts unresolved ownership checks and elides them only with matching verifier evidence", () => {
    const names = Array.from({ length: 13 }, (_, index) => `b${index}`);
    const guard = names.join(" && "), parameters = names.map((name) => `${name}: boolean`).join(", ");
    const arguments_ = names.join(", ");
    const source = `
      declare function task(): Promise<void>
      /* uneffect: consumes_rejection_when 13: ${guard} */
      declare function consume(${parameters}, value: Promise<void>): void
      /* uneffect: requires ${guard} */
      async function run(${parameters}) {
        const pending = task()
        consume(${arguments_}, pending)
      }
    `;
    const instrumented = instrumentOwnershipAssertions("ownership.ts", source);
    expect(instrumented.diagnostics).toEqual([]);
    expect(instrumented.assertions).toHaveLength(1);
    expect(instrumented.assertions[0]?.obligation).toMatchObject({ owner: "run", status: "unresolved" });
    expect(instrumented.code).toContain("uneffectAssertOwnership(");
    expect(optimizeOwnershipAssertions(instrumented, []).code).toBe(instrumented.code);
    const artifact = verifyOwnershipObligationWithZ3(instrumented.assertions[0]!.obligation);
    expect(artifact.result).toBe("verified");
    const optimized = optimizeOwnershipAssertions(instrumented, [artifact]);
    expect(optimized.code).not.toContain(instrumented.assertions[0]!.assertion);
    expect(optimized.code).not.toContain("function uneffectAssertOwnership");
    expect(optimized.code).toContain("consume(");
  });
});
