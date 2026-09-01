/**
 * postgres.js Driver Tests — nested writes and relation reads
 *
 * The behavior contracts that exercise pooled connections: nested writes whose
 * transactions span checkouts, and relation reads whose correlated-subquery
 * results cross real result parsing.
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 *
 * One of three `postgres*.test.ts` pieces — see `postgres.test.ts` for why the
 * suite is split by schema. The `describeIf("postgres.js Driver")` wrapper and
 * the per-test drop-everything cleanup are identical in every piece.
 */

import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
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

  // Nested writes over real pooled connections (transactions span checkouts)
  nestedWriteContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  nestedWriteAdvancedContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  // Relation _count / relation orderBy / every-none read filters over the
  // real driver (correlated-subquery results cross real result parsing).
  relationReadAggregateContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });
  nestedOrderByContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });

  omitContract.register({
    driverName: "postgres.js",
    createDriver: createPostgresDriver,
  });
});
