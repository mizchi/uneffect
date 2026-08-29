import { describe, expect, it } from "vitest";
import { generateObligationSmt, lowerInvariantProgram, proveBooleanImplication } from "../src/invariant-ir.js";

describe("shared invariant obligation IR", () => {
  const source = `
    /* uneffect:contract requires n >= 0 */
    /* uneffect:contract ensures result >= n */
    function choose(n: Nat, flag: boolean): Nat {
      let value = n
      if (flag) value = value + 1
      return value
    }
  `;

  it("lowers branches with stable identifiers and source mappings", () => {
    const first = lowerInvariantProgram("choose.ts", source);
    const second = lowerInvariantProgram("choose.ts", source);
    expect(first).toHaveLength(2);
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(first.every((item) => item.span.start < item.span.end)).toBe(true);
    expect(first[0]?.variables).toEqual(expect.arrayContaining([
      { name: "n", domain: "nat", sort: "Int" },
      { name: "flag", domain: "bool", sort: "Bool" },
    ]));
    expect(generateObligationSmt(first[0]!)).toContain("(declare-const flag Bool)");
    expect(generateObligationSmt(first[0]!)).toContain("(assert (>= n 0))");
  });

  it("creates initialization, preservation, and exit/post obligations for loops", () => {
    const obligations = lowerInvariantProgram("loop.ts", `
      /* uneffect:contract requires n >= 0 */
      /* uneffect:contract ensures result == n */
      function count(n: Int) {
        let i = 0
        /* uneffect:contract invariant i >= 0 && i <= n */
        while (i < n) { i = i + 1 }
        return i
      }
    `);
    expect(obligations.map((item) => item.kind)).toEqual(["loop-init", "loop-preserve", "postcondition"]);
  });

  it("preserves Float as a distinct Real-backed domain", () => {
    const [obligation] = lowerInvariantProgram("float.ts", `
      /* uneffect:contract ensures result == x */
      function identity(x: Float): Float { return x }
    `);
    expect(obligation?.variables[0]).toEqual({ name: "x", domain: "float", sort: "Real" });
  });

  it("proves boolean ownership guards in the shared logic IR", () => {
    expect(proveBooleanImplication(["enabled && active"], "enabled && active")).toBe(true);
    expect(proveBooleanImplication(["enabled", "active"], "enabled && active")).toBe(true);
    expect(proveBooleanImplication(["enabled"], "enabled && active")).toBe(false);
    expect(proveBooleanImplication(["enabled || active"], "enabled")).toBe(false);
  });
});
