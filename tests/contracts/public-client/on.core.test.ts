/**
 * `viborm/on` on in-memory SQLite (`on-behavior.ts`, which PGlite, PostgreSQL
 * and MySQL also run): the interactive driver, one without RETURNING
 * (MySQL's shape) and a batch-only one (D1's shape).
 */

import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  createBatchOnlySQLite3Driver,
  createNonReturningSQLite3Driver,
} from "@tests/providers/local/sqlite3-fixtures";
import { runOnBehavior } from "./on-behavior";

runOnBehavior({ name: "SQLite3", createDriver: createInMemorySQLite3Driver });
runOnBehavior({
  name: "SQLite3 without RETURNING",
  createDriver: createNonReturningSQLite3Driver,
});
runOnBehavior({
  name: "SQLite3 batch-only",
  createDriver: createBatchOnlySQLite3Driver,
});
