/**
 * pg Driver Tests - polymorphism and DDL
 *
 * Polymorphic relation, collection read and collection write contracts with the
 * junction, FK/mapped index, partial-index churn and forward FK ordering DDL
 * contracts they share a schema shape with.
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
import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { fkIndexContract } from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import {
  mappedIndexContract,
  partialIndexPredicateChurnContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicMemberJunctionContract } from "@tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { PgBatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-pg";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  // The shared behavior suites and client-integration tests assume a fresh
  // database. PostgreSQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  // (Same pattern as mysql2.test.ts.)
  beforeEach(dropEveryLiveTable);

  fkIndexContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  mappedIndexContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  compoundJunctionContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  polymorphicMemberJunctionContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  // Decision 7.4 on the real server rather than the WASM one: the deparse this
  // reconciles is PostgreSQL's, and `pg` reaches it through a POOL, where the
  // canonicalization's session-local scratch would scatter across connections
  // if it were not pinned to one.
  partialIndexPredicateChurnContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  forwardFkOrderingContract.register({
    driverName: "pg (tx)",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  forwardFkOrderingContract.register({
    driverName: "pg (batch)",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  polymorphicRelationContract.register({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  polymorphicCollectionReadContract.register({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  polymorphicCollectionWriteContract.register({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
