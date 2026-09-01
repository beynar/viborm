/**
 * pg Driver Tests - read surface
 *
 * Relation aggregates, nested ordering and projection over the real driver,
 * plus the bulk-write `limit` whose PostgreSQL form pins parameter ordering.
 *
 * One program per file has to fit the 1280 MB TypeScript shard heap, and the
 * type inference a behavior module's schemas force is what that heap holds, so
 * this suite is split by schema across `pg*.test.ts`. Every piece keeps the
 * `pg Driver` describe and its drop-everything `beforeEach`, so test names and
 * per-test lifecycle are unchanged.
 *
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 */

import { PgDriver } from "@drivers/pg";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  // The shared behavior suites and client-integration tests assume a fresh
  // database. PostgreSQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  // (Same pattern as mysql2.test.ts.)
  beforeEach(dropEveryLiveTable);

  // Relation _count / relation orderBy / every-none read filters over the
  // real driver (correlated-subquery results cross real result parsing).
  relationReadAggregateContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  nestedOrderByContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  omitContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Bulk-write `limit` IS wired here, unlike the adapter-level suites the
  // closing note in `pg.test.ts` lists: its PostgreSQL form nests a bound
  // `LIMIT` inside a subquery inside an UPDATE's WHERE, after the SET's own
  // bound values — a parameter ORDERING this file's charter (param
  // serialization on the real driver) covers and PGlite's in-process binding
  // does not fully stand in for.
  bulkWriteLimitContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
