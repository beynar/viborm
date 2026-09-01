/**
 * LibSQL nested-write schemas: nested writes, compound keys, and many-to-many.
 *
 * One file of the LibSQL provider suite, which is split across sibling
 * `libsql-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./libsql-fixtures`, which Vitest does not collect.
 */

import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { describe } from "vitest";

// biome-ignore lint/suspicious/noSkippedTests: V1 effectful push is not supported by libSQL.
describe.skip("LibSQL contracts that need effectful live-schema setup (DRIVER_NOT_SUPPORTED)", () => {
  nestedWriteContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  compoundKeyContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
  manyToManyContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
  });
});
