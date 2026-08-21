import { describe, expect, expectTypeOf, it } from "vitest";
import { Effect } from "effect";
import { incrementAndReport } from "../examples/effect-ts.js";
import { analyzeEffectRecovery } from "../src/adoption.js";

describe("Effect TS comparison", () => {
  it("type-checks and executes an Effect program", async () => {
    expectTypeOf(incrementAndReport(0)).toEqualTypeOf<Effect.Effect<number>>();
    expect(await Effect.runPromise(incrementAndReport(1))).toBe(2);
  });

  it("assigns tryPromise failure ownership to an actual catchAll callback", () => {
    const recovered = analyzeEffectRecovery("effect-recovery.ts", `
      import { Effect, pipe } from "effect"
      declare const fetcher: () => Promise<string>
      export const load = pipe(
        Effect.tryPromise({ try: fetcher, catch: error => error }),
        Effect.catchAll(() => Effect.succeed("recovered")),
      )
    `);
    expect(recovered).toMatchObject({ tryPromiseCallbacks: 1, catchAllCallbacks: 1, unhandledFailures: 0 });
    expect(recovered.failures).toContainEqual(expect.objectContaining({ status: "recovered", owner: "catchAll" }));

    const floating = analyzeEffectRecovery("effect-floating.ts", `
      import { Effect } from "effect"
      declare const fetcher: () => Promise<string>
      export const load = Effect.tryPromise({ try: fetcher, catch: error => error })
    `);
    expect(floating).toMatchObject({ tryPromiseCallbacks: 1, catchAllCallbacks: 0, unhandledFailures: 1 });
    expect(floating.failures).toContainEqual(expect.objectContaining({ status: "unhandled" }));
  });
});
