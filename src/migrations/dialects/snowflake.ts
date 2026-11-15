/**
 * `viborm/migrations/snowflake`: the `viborm/migrations` API with only the
 * Snowflake migration driver registered. Snowflake is read, never migrated:
 * this entry is what introspection of a warehouse binds to, and every command
 * that would write is refused before it sends anything.
 */

import { registerMigrationDriver } from "../drivers";
import { snowflakeMigrationDriver } from "../drivers/snowflake";

registerMigrationDriver(snowflakeMigrationDriver);

export * from "../index";
