/**
 * pg Driver Tests - parent-held lookups and adoption
 *
 * Engine write behaviors for parent-held to-one lookups, located parent refs,
 * inverse to-one creates, post-transition adoption, and nested mutations.
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
import { runInverseToOneCreateBehavior } from "@tests/contracts/engine/write/inverse-to-one-create-behavior";
import { runLocatedParentRefBehavior } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { runNestedMutationBehavior } from "@tests/contracts/engine/write/nested-mutation-behavior";
import {
  runBeforeRootSubtreeBehavior,
  runNonPkReferenceBehavior,
  runParentHeldLookupBehavior,
  runUpsertArmRelationBehavior,
} from "@tests/contracts/engine/write/parent-held-lookup-behavior";
import { runPostTransitionAdoptBehavior } from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { PgBatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-pg";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  // The shared behavior suites and client-integration tests assume a fresh
  // database. PostgreSQL persists between tests, so drop everything first:
  // pushing an empty schema diffs to dropTable for every existing table.
  // (Same pattern as mysql2.test.ts.)
  beforeEach(dropEveryLiveTable);

  // E1 — the parent-held to-one absorptions on the REAL PostgreSQL server rather
  // than the WASM one: the lookup subquery and the produced identity both travel
  // through the pool's own RETURNING handling here.
  runParentHeldLookupBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runBeforeRootSubtreeBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runUpsertArmRelationBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runNonPkReferenceBehavior({
    name: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runLocatedParentRefBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runLocatedParentRefBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runInverseToOneCreateBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runInverseToOneCreateBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runPostTransitionAdoptBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runPostTransitionAdoptBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runNestedMutationBehavior({
    name: "pg transaction",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });

  runNestedMutationBehavior({
    name: "pg atomic batch",
    createDriver: () =>
      new PgBatchForcedDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
