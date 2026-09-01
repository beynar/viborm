/**
 * SQLite3 read paths and scalar storage: read-path regressions, relation aggregates, nested orderBy, client raw, scalar round-trips, decimal exactness, LIKE escaping, blob filters, and field references.
 *
 * One file of the SQLite3 provider suite, which is split across sibling
 * `sqlite3-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./sqlite3-fixtures`, which Vitest does not collect.
 */

import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describe("SQLite3 Driver", () => {
  readPathRegressionContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  relationReadAggregateContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  nestedOrderByContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  clientRawContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  scalarRoundtripContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  fullScalarRoundtripContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  decimalExactnessContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
    // SQLite-legal intersection: `precision + scale <= 18` (plan 3.1).
    descriptor: { precision: 16, scale: 2 },
  });
  likeEscapeContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  blobFilterContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
  fieldReferenceContract.register({
    driverName: "SQLite3",
    createDriver: createInMemorySQLite3Driver,
  });
});
