import { describe, expect, expectTypeOf, it } from "vitest";
import type { F32, Float, I32, Int, Nat, U8, U32 } from "../src/index.js";
import { F32_BITS, I32_MAX, I32_MIN, U8_BITS, U8_MAX, U32_BITS, U32_MAX, FloatSchema, IntSchema, NatSchema, f32, i32, parseFloat, parseInt, parseNat, u8, u32 } from "../src/index.js";

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

  it("makes machine-number coercions explicit and typed", () => {
    expect(u8(257)).toBe(1);
    expect(u8(-1)).toBe(255);
    expect(u32(-1)).toBe(0xffff_ffff);
    expect(i32(0xffff_ffff)).toBe(-1);
    expect(f32(1 / 3)).toBe(Math.fround(1 / 3));
    expectTypeOf(u8(1)).toEqualTypeOf<U8>();
    expectTypeOf(u32(1)).toEqualTypeOf<U32>();
    expectTypeOf(i32(1)).toEqualTypeOf<I32>();
    expectTypeOf(f32(1)).toEqualTypeOf<F32>();
  });

  it("exports literal machine-domain constants", () => {
    expect({ U8_BITS, U8_MAX, U32_BITS, U32_MAX, I32_MIN, I32_MAX, F32_BITS }).toEqual({
      U8_BITS: 8, U8_MAX: 0xff, U32_BITS: 32, U32_MAX: 0xffff_ffff,
      I32_MIN: -0x8000_0000, I32_MAX: 0x7fff_ffff, F32_BITS: 32,
    });
    expectTypeOf(U8_MAX).toEqualTypeOf<255>();
    expectTypeOf(U32_BITS).toEqualTypeOf<32>();
  });
});
