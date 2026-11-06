/**
 * PROTOTYPE: the `viborm/migrations` API with the SurrealQL migration driver. Not
 * a package entry, and not among `every.ts`'s, so no bundle carries it.
 */

import { registerMigrationDriver } from "../drivers";
import { surrealMigrationDriver } from "../drivers/surrealql";

registerMigrationDriver(surrealMigrationDriver);

export * from "../index";
