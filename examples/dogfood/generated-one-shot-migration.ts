/* uneffect:temporal state migrated: int */ /* uneffect:temporal state audited: int */ /* uneffect:temporal state reported: int */ /* uneffect:temporal state stopAfter: int */ /* uneffect:temporal init migrated = 0 */ /* uneffect:temporal init audited = 0 */ /* uneffect:temporal init reported = 0 */ /* uneffect:temporal init stopAfter = 0 */ /* uneffect:temporal action migrate: migrated' = migrated + 1, audited' = audited + 1 */ /* uneffect:temporal action migrateBatch: migrated' = migrated + 1 + 2 + 3, audited' = audited + 1 + 1 + 1 */ /* uneffect:temporal action migrateUntil: migrated' = stopAfter === 1 ? migrated + 1 : stopAfter === 2 ? migrated + 1 + 2 : migrated + 1 + 2 + 3, audited' = stopAfter === 1 ? audited + 1 : stopAfter === 2 ? audited + 1 + 1 : audited + 1 + 1 + 1, reported' = reported + 1 */ /* uneffect:temporal action migrateSelected: migrated' = stopAfter === 1 ? migrated + 2 + 3 : stopAfter === 2 ? migrated + 1 + 3 : stopAfter === 3 ? migrated + 1 + 2 : migrated + 1 + 2 + 3, audited' = audited + 1 + 1 + 1, reported' = reported + 1 */ /* uneffect:temporal invariant nonNegative: migrated >= 0 && audited >= 0 && reported >= 0 */

export interface MigrationState {
  migrated: number;
  audited: number;
  reported: number;
  stopAfter: number;
}

/* uneffect:refinement refinement generatedMigration@1 create */
export function createMigration(initial: MigrationState): MigrationState {
  return initial;
}

/* uneffect:refinement refinement generatedMigration@1 observe */
export function observeMigration(runtime: MigrationState): MigrationState {
  return runtime;
}

/* uneffect:refinement refinement generatedMigration@1 action migrate */
export function migrateGeneratedRecord(runtime: MigrationState): void {
  // Some generated transforms preserve a disabled compatibility branch and
  // wrap the one-shot migration body in a do/while(false) control shell.
  while (false) runtime.migrated += 1_000;
  do {
    runtime.migrated++;
    runtime.audited++;
  } while (false);
}

/* uneffect:refinement refinement generatedMigration@1 action migrateBatch */
export function migrateGeneratedBatch(runtime: MigrationState): void {
  let migrationId = 1;
  while (migrationId < 4) {
    runtime.migrated += migrationId;
    runtime.audited++;
    migrationId++;
  }
}

/* uneffect:refinement refinement generatedMigration@1 action migrateUntil */
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

/* uneffect:refinement refinement generatedMigration@1 action migrateSelected */
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

/* uneffect:refinement refinement generatedMigration@1 invariant nonNegative */
export function migrationCountersAreNonNegative(runtime: MigrationState): boolean {
  return runtime.migrated >= 0 && runtime.audited >= 0 && runtime.reported >= 0;
}
