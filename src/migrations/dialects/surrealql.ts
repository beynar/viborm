/**
 * `viborm/migrations/surrealdb`: the `viborm/migrations` API with only the SurrealQL
 * migration driver registered, so a bundle carries no SQL migration code.
 */

import { registerMigrationDriver } from "../drivers";
import { surrealMigrationDriver } from "../drivers/surrealql";

registerMigrationDriver(surrealMigrationDriver);

export * from "../index";
