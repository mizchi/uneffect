/* uneffect:
 * state migrated: int
 * state audited: int
 * state reported: int
 * state stopAfter: int
 * init migrated = 0
 * init audited = 0
 * init reported = 0
 * init stopAfter = 0
 * action migrate: migrated' = migrated + 1, audited' = audited + 1
 * action migrateBatch: migrated' = migrated + 1 + 2 + 3, audited' = audited + 1 + 1 + 1
 * action migrateUntil: migrated' = stopAfter === 1 ? migrated + 1 : stopAfter === 2 ? migrated + 1 + 2 : migrated + 1 + 2 + 3, audited' = stopAfter === 1 ? audited + 1 : stopAfter === 2 ? audited + 1 + 1 : audited + 1 + 1 + 1, reported' = reported + 1
 * action migrateSelected: migrated' = stopAfter === 1 ? migrated + 2 + 3 : stopAfter === 2 ? migrated + 1 + 3 : stopAfter === 3 ? migrated + 1 + 2 : migrated + 1 + 2 + 3, audited' = audited + 1 + 1 + 1, reported' = reported + 1
 * temporal nonNegative: migrated >= 0 && audited >= 0 && reported >= 0
 */

export interface MigrationState {
  migrated: number;
  audited: number;
  reported: number;
  stopAfter: number;
}

/* uneffect: refinement generatedMigration@1 create */
export function createMigration(initial: MigrationState): MigrationState {
  return initial;
}

/* uneffect: refinement generatedMigration@1 observe */
export function observeMigration(runtime: MigrationState): MigrationState {
  return runtime;
}

/* uneffect: refinement generatedMigration@1 action migrate */
export function migrateGeneratedRecord(runtime: MigrationState): void {
  // Some generated transforms preserve a disabled compatibility branch and
  // wrap the one-shot migration body in a do/while(false) control shell.
  while (false) runtime.migrated += 1_000;
  do {
    runtime.migrated++;
    runtime.audited++;
  } while (false);
}

/* uneffect: refinement generatedMigration@1 action migrateBatch */
export function migrateGeneratedBatch(runtime: MigrationState): void {
  let migrationId = 1;
  while (migrationId < 4) {
    runtime.migrated += migrationId;
    runtime.audited++;
    migrationId++;
  }
}

/* uneffect: refinement generatedMigration@1 action migrateUntil */
export function migrateUntilReported(runtime: MigrationState): void {
  for (let migrationId = 1; migrationId < 4; migrationId++) {
    try {
      runtime.migrated += migrationId;
      if (runtime.stopAfter === migrationId) break;
    } finally {
      runtime.audited++;
    }
  }
  runtime.reported++;
}

/* uneffect: refinement generatedMigration@1 action migrateSelected */
export function migrateSelectedRecords(runtime: MigrationState): void {
  for (let migrationId = 1; migrationId < 4; migrationId++) {
    try {
      if (runtime.stopAfter === migrationId) continue;
      runtime.migrated += migrationId;
    } finally {
      runtime.audited++;
    }
  }
  runtime.reported++; // selected migration report
}

/* uneffect: refinement generatedMigration@1 invariant nonNegative */
export function migrationCountersAreNonNegative(runtime: MigrationState): boolean {
  return runtime.migrated >= 0 && runtime.audited >= 0 && runtime.reported >= 0;
}
