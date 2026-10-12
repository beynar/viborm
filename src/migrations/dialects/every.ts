/**
 * Every dialect's migration driver. Callers register from their own entry
 * statement (`viborm/migrations`, the CLI), so the registration stays with
 * the entry a bundler keeps.
 */

import { registerMigrationDriver } from "../drivers";
import { libsqlMigrationDriver } from "../drivers/libsql";
import { mysqlMigrationDriver } from "../drivers/mysql";
import { postgresMigrationDriver } from "../drivers/postgres";
import { sqlite3MigrationDriver } from "../drivers/sqlite";

export function registerEveryMigrationDriver(): void {
  registerMigrationDriver(postgresMigrationDriver);
  registerMigrationDriver(sqlite3MigrationDriver);
  registerMigrationDriver(libsqlMigrationDriver);
  registerMigrationDriver(mysqlMigrationDriver);
}
