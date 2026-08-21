import { describe, expect, expectTypeOf, it } from "vitest";
import { Effect } from "effect";
import { incrementAndReport } from "../examples/effect-ts.js";

describe("Effect TS comparison", () => {
  it("type-checks and executes an Effect program", async () => {
    expectTypeOf(incrementAndReport(0)).toEqualTypeOf<Effect.Effect<number>>();
    expect(await Effect.runPromise(incrementAndReport(1))).toBe(2);
  });
});
