/**
 * `viborm/migrations/postgres`: the `viborm/migrations` API with only the
 * PostgreSQL migration driver registered, so a bundle carries no MySQL or
 * SQLite migration code.
 */

import { registerMigrationDriver } from "../drivers";
import { postgresMigrationDriver } from "../drivers/postgres";

registerMigrationDriver(postgresMigrationDriver);

export * from "../index";
