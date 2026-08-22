/* uneffect:
  state epochs: Map<int, int>
  init epochs = Map([[1, 0]])
  action addFallback: epochs' = epochs.put(2, 1)
  action removePrimary: epochs' = epochs.remove(1)
  temporal primaryPresent: epochs.keys().contains(1)
  abstraction persistedEpochs@1 epochs = Map(storage.epochEntries)
*/

export interface EpochModelState {
  epochs: Map<number, number>;
}

export interface PersistedEpochRuntime {
  storage: { epochEntries: Array<[number, number]> };
}

/* uneffect: refinement persistedEpochs@1 create */
export function createPersistedEpochs(initial: EpochModelState): PersistedEpochRuntime {
  return { storage: { epochEntries: Array.from(initial.epochs) } };
}

/* uneffect: refinement persistedEpochs@1 observe */
export function observePersistedEpochs(runtime: PersistedEpochRuntime): EpochModelState {
  return { epochs: new Map(runtime.storage.epochEntries) };
}

/* uneffect: refinement persistedEpochs@1 action addFallback */
export function addFallbackEpoch(runtime: PersistedEpochRuntime): void {
  runtime.storage.epochEntries.push([2, 1]);
}

/* uneffect: refinement persistedEpochs@1 action removePrimary */
export function removePrimaryEpoch(runtime: PersistedEpochRuntime): void {
  runtime.storage.epochEntries = runtime.storage.epochEntries.filter((entry) => entry[0] !== 1);
}

/* uneffect: refinement persistedEpochs@1 invariant primaryPresent */
export function primaryEpochPresent(runtime: PersistedEpochRuntime): boolean {
  return runtime.storage.epochEntries.some((entry) => entry[0] === 1);
}
