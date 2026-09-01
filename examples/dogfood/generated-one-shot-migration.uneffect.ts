import { defineRefinement } from "@mizchi/uneffect/spec";
import { createMigration, migrateGeneratedBatch, migrateGeneratedRecord, migrateSelectedRecords, migrateUntilReported, migrationCountersAreNonNegative, observeMigration } from "./generated-one-shot-migration.js";

export default defineRefinement({
  name: "generatedMigration",
  version: "1",
  create: createMigration,
  observe: observeMigration,
  abstractions: {},
  actions: {
    "migrate": migrateGeneratedRecord,
    "migrateBatch": migrateGeneratedBatch,
    "migrateUntil": migrateUntilReported,
    "migrateSelected": migrateSelectedRecords,
  },
  invariants: {
    "nonNegative": migrationCountersAreNonNegative,
  },
});
