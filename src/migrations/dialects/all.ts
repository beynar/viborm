/**
 * `viborm/migrations`: the migrations API with every dialect's migration
 * driver registered. The registration is this entry's own statement, so a
 * bundler keeps it (package.json `sideEffects`).
 */

import { registerEveryMigrationDriver } from "./every";

registerEveryMigrationDriver();

export * from "../index";
