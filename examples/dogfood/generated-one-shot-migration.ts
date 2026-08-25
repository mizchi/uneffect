/* uneffect:
 * state migrated: int
 * state audited: int
 * init migrated = 0
 * init audited = 0
 * action migrate: migrated' = migrated + 1, audited' = audited + 1
 * temporal nonNegative: migrated >= 0 && audited >= 0
 */

export interface MigrationState {
  migrated: number;
  audited: number;
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

/* uneffect: refinement generatedMigration@1 invariant nonNegative */
export function migrationCountersAreNonNegative(runtime: MigrationState): boolean {
  return runtime.migrated >= 0 && runtime.audited >= 0;
}
