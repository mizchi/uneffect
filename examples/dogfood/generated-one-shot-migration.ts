/* uneffect:refinement_from "./generated-one-shot-migration.uneffect.ts#default" */
/* uneffect:state migrated: int */ /* uneffect:state audited: int */ /* uneffect:state reported: int */ /* uneffect:state stopAfter: int */ /* uneffect:init migrated = 0 */ /* uneffect:init audited = 0 */ /* uneffect:init reported = 0 */ /* uneffect:init stopAfter = 0 */ /* uneffect:action migrate: migrated' = migrated + 1, audited' = audited + 1 */ /* uneffect:action migrateBatch: migrated' = migrated + 1 + 2 + 3, audited' = audited + 1 + 1 + 1 */ /* uneffect:action migrateUntil: migrated' = stopAfter === 1 ? migrated + 1 : stopAfter === 2 ? migrated + 1 + 2 : migrated + 1 + 2 + 3, audited' = stopAfter === 1 ? audited + 1 : stopAfter === 2 ? audited + 1 + 1 : audited + 1 + 1 + 1, reported' = reported + 1 */ /* uneffect:action migrateSelected: migrated' = stopAfter === 1 ? migrated + 2 + 3 : stopAfter === 2 ? migrated + 1 + 3 : stopAfter === 3 ? migrated + 1 + 2 : migrated + 1 + 2 + 3, audited' = audited + 1 + 1 + 1, reported' = reported + 1 */ /* uneffect:always nonNegative: migrated >= 0 && audited >= 0 && reported >= 0 */

export interface MigrationState {
  migrated: number;
  audited: number;
  reported: number;
  stopAfter: number;
}

export function createMigration(initial: MigrationState): MigrationState {
  return initial;
}

export function observeMigration(runtime: MigrationState): MigrationState {
  return runtime;
}

export function migrateGeneratedRecord(runtime: MigrationState): void {
  // Some generated transforms preserve a disabled compatibility branch and
  // wrap the one-shot migration body in a do/while(false) control shell.
  while (false) runtime.migrated += 1_000;
  do {
    runtime.migrated++;
    runtime.audited++;
  } while (false);
}

export function migrateGeneratedBatch(runtime: MigrationState): void {
  let migrationId = 1;
  while (migrationId < 4) {
    runtime.migrated += migrationId;
    runtime.audited++;
    migrationId++;
  }
}

export function migrateUntilReported(runtime: MigrationState): void {
  untilReported: for (let migrationId = 1; migrationId < 4; migrationId++) {
    try {
      runtime.migrated += migrationId;
      if (runtime.stopAfter === migrationId) break untilReported;
    } finally {
      runtime.audited++;
    }
  }
  runtime.reported++;
}

export function migrateSelectedRecords(runtime: MigrationState): void {
  selectedRecords: for (let migrationId = 1; migrationId < 4; migrationId++) {
    try {
      if (runtime.stopAfter === migrationId) continue selectedRecords;
      runtime.migrated += migrationId;
    } finally {
      runtime.audited++;
    }
  }
  runtime.reported++; // selected migration report
}

export function migrationCountersAreNonNegative(runtime: MigrationState): boolean {
  return runtime.migrated >= 0 && runtime.audited >= 0 && runtime.reported >= 0;
}
