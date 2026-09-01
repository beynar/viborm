/**
 * mysql2 Driver Tests - scalars and filters
 *
 * Scalar transport and filter contracts: roundtrips, fixed decimals, Prisma
 * parity, LIKE escaping, blob and JSON/list filters, and field references.
 *
 * One program per file has to fit the 1280 MB TypeScript shard heap, and the
 * type inference a behavior module's schemas force is what that heap holds, so
 * this suite is split by schema across `mysql2*.test.ts`. Every piece keeps the
 * `MySQL2 Driver` describe and its drop-everything `beforeEach`, so test names
 * and per-test lifecycle are unchanged.
 *
 * NOTE: These tests require a running MySQL database (e.g. docker).
 * Set MYSQL_TEST_CONNECTION_STRING to enable, e.g.:
 *   docker run -d --name viborm-mysql -p 3307:3306 \
 *     -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=viborm mysql:8
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  // The shared behavior suites assume a fresh database (the local drivers are
  // in-memory). MySQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  beforeEach(dropEveryLiveTable);

  listJsonFilterContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  jsonNullSentinelContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  // MySQL's default collation is case- and accent-INSENSITIVE, so it is the
  // only leg where the collation wrappers on a referenced operand can be
  // observed to matter at all.
  fieldReferenceContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  scalarRoundtripContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  decimalExactnessContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    // SQLite-legal intersection: `precision + scale <= 18` (plan 3.1).
    descriptor: { precision: 16, scale: 2 },
  });

  fullScalarRoundtripContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  prismaParityContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  optionalRelationParityContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  likeEscapeContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  blobFilterContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
  });
});
