/**
 * SQLite3 write-engine conformance over the upsert and update schemas: nested upserts, the update family, located parent refs, inverse to-one creates, the depth seam, and produced identity.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { runCreateNestedUpsertBehavior } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import { runDepthSeamBehavior } from "@tests/contracts/engine/write/depth-seam-behavior";
import { runInverseToOneCreateBehavior } from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { runProducedIdentityBehavior } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { runUpdateFamilyBehavior } from "@tests/contracts/engine/write/update-family-behavior";
import { runUpdateNestedUpsertBehavior } from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { createBatchOnlySQLite3Driver } from "./sqlite3-fixtures";

describe("SQLite3 Driver", () => {
  runCreateNestedUpsertBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runCreateNestedUpsertBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runUpdateNestedUpsertBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runUpdateNestedUpsertBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runUpdateFamilyBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runUpdateFamilyBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runLocatedParentRefBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runLocatedParentRefBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runInverseToOneCreateBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runInverseToOneCreateBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runDepthSeamBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runDepthSeamBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
  runProducedIdentityBehavior({
    name: "SQLite3 transaction",
    createDriver: createInMemorySQLite3Driver,
  });
  runProducedIdentityBehavior({
    name: "SQLite3 atomic batch",
    createDriver: createBatchOnlySQLite3Driver,
  });
});
