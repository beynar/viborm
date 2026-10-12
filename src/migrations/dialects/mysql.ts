/**
 * `viborm/migrations/mysql`: the `viborm/migrations` API with only the MySQL
 * migration driver registered, so a bundle carries no PostgreSQL or SQLite
 * migration code.
 */

import { registerMigrationDriver } from "../drivers";
import { mysqlMigrationDriver } from "../drivers/mysql";

registerMigrationDriver(mysqlMigrationDriver);

export * from "../index";
