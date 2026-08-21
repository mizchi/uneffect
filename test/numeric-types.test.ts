import { describe, expect, expectTypeOf, it } from "vitest";
import type { Float, Int, Nat } from "../src/index.js";
import { FloatSchema, IntSchema, NatSchema, parseFloat, parseInt, parseNat } from "../src/index.js";

describe("numeric helper types", () => {
  it("parses branded numeric values with Valibot", () => {
    expect(parseInt(1)).toBe(1);
    expect(parseNat(0)).toBe(0);
    expect(parseFloat(1.5)).toBe(1.5);
    expect(() => parseInt(1.5)).toThrow();
    expect(() => parseNat(-1)).toThrow();
    expect(() => parseFloat(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("exports schema outputs matching helper types", () => {
    expectTypeOf(parseInt(1)).toEqualTypeOf<Int>();
    expectTypeOf(parseNat(1)).toEqualTypeOf<Nat>();
    expectTypeOf(parseFloat(1)).toEqualTypeOf<Float>();
    expect(IntSchema).toBeDefined();
    expect(NatSchema).toBeDefined();
    expect(FloatSchema).toBeDefined();
  });
});
