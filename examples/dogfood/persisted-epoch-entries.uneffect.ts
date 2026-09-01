import { defineRefinement, mapFromEntriesProjection } from "@mizchi/uneffect/spec";
import {
  addFallbackEpoch,
  clearPersistedEpochs,
  createPersistedEpochs,
  hasPersistedEpochs,
  nonNegativePersistedEpochs,
  observePersistedEpochs,
  primaryEpochPresent,
  removePrimaryEpoch,
  upsertPrimaryEpoch,
} from "./persisted-epoch-entries.js";

export default defineRefinement({
  name: "persistedEpochs",
  version: "1",
  create: createPersistedEpochs,
  observe: observePersistedEpochs,
  abstractions: {
    epochs: mapFromEntriesProjection("storage.epochEntries"),
  },
  actions: {
    addFallback: addFallbackEpoch,
    removePrimary: removePrimaryEpoch,
    clearEpochs: clearPersistedEpochs,
    upsertPrimary: upsertPrimaryEpoch,
  },
  invariants: {
    primaryPresent: primaryEpochPresent,
    hasEpochs: hasPersistedEpochs,
    nonNegativeEpochs: nonNegativePersistedEpochs,
  },
});
