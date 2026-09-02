/**
 * SQLite3 nested-write schemas: nested writes, JSON envelopes, compound keys, compound and polymorphic-member junctions, and many-to-many.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteJsonEnvelopeContract } from "@tests/contracts/drivers/behaviors/nested-write-json-envelope-behavior";
import { polymorphicMemberJunctionContract } from "@tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  nestedWriteContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  nestedWriteAdvancedContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  nestedWriteJsonEnvelopeContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  compoundKeyContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  compoundJunctionContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  polymorphicMemberJunctionContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  manyToManyContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
