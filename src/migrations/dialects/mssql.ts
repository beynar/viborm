/**
 * `viborm/migrations/mssql`: the `viborm/migrations` API with only the SQL
 * Server migration driver registered, which introspects and writes no DDL.
 */

import { registerMigrationDriver } from "../drivers";
import { mssqlMigrationDriver } from "../drivers/mssql";

registerMigrationDriver(mssqlMigrationDriver);

export * from "../index";
