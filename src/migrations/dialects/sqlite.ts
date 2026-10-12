/**
 * `viborm/migrations/sqlite`: the `viborm/migrations` API with only the SQLite
 * migration drivers registered (SQLite, Bun SQLite and D1 bind `sqlite3`,
 * libSQL binds `libsql`), so a bundle carries no PostgreSQL or MySQL
 * migration code.
 */

import { registerMigrationDriver } from "../drivers";
import { libsqlMigrationDriver } from "../drivers/libsql";
import { sqlite3MigrationDriver } from "../drivers/sqlite";

registerMigrationDriver(sqlite3MigrationDriver);
registerMigrationDriver(libsqlMigrationDriver);

export * from "../index";
