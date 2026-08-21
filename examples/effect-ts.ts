import { Console, Effect, Ref } from "effect";

export const incrementAndReport = (initial: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initial);
    yield* Ref.update(state, (value) => value + 1);
    const result = yield* Ref.get(state);
    yield* Console.log(`count=${result}`);
    return result;
  });

export const runEffectExample = (initial: number): Promise<number> =>
  Effect.runPromise(incrementAndReport(initial));
