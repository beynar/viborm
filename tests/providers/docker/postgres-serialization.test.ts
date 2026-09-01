/**
 * postgres.js Driver Tests — parameter serialization
 *
 * The behavior contracts whose value depends on the real postgres.js wire
 * protocol: how scalars, lists, JSON, bytea and decimals are bound and read
 * back, and in what ORDER parameters are emitted.
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 *
 * One of three `postgres*.test.ts` pieces — see `postgres.test.ts` for why the
 * suite is split by schema. The `describeIf("postgres.js Driver")` wrapper and
 * the per-test drop-everything cleanup are identical in every piece.
 */

import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { clientRawContract } from "@tests/contracts/drivers/behaviors/client-raw-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import {
  createPostgresDriver,
  describeIf,
  dropEveryTable,
} from "@tests/providers/docker/postgres-fixtures";

describeIf("postgres.js Driver", () => {
  // The tests below assume a fresh database. PostgreSQL persists between
  // tests, so drop everything first: pushing an empty schema diffs to
  // dropTable for every existing table. (Same pattern as mysql2.test.ts.)
  beforeEach(dropEveryTable);

  // Real postgres.js param serialization for native array columns
  listJsonFilterContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  fieldReferenceContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  scalarRoundtripContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  decimalExactnessContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
    // SQLite-legal intersection: `precision + scale <= 18` (plan 3.1).
    descriptor: { precision: 16, scale: 2 },
  });

  // Real postgres.js param serialization for a LIST of bytea bind params
  blobFilterContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  fullScalarRoundtripContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  // Raw-string $queryRaw params and sql`` rendering go through the real
  // postgres.js wire protocol here ($n placeholders), unlike the PGlite run.
  clientRawContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  // Bulk-write `limit` IS wired here for the reason given in pg.test.ts: its
  // PostgreSQL form binds a `LIMIT` inside a subquery inside an UPDATE's WHERE,
  // which is a parameter ORDERING this file's charter covers.
  bulkWriteLimitContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  // The rationale below covers the whole postgres.js provider suite, now split
  // across `postgres*.test.ts`:
  // The remaining behavior suites are not wired here: they are adapter-level
  // and already run on PGlite, which shares the postgres adapter; this file
  // covers what depends on the real driver (param serialization, pooling,
  // transactions).
});
