/**
 * mysql2 Driver Tests - parent-held lookups and adoption
 *
 * Engine write behaviors for parent-held to-one lookups, located parent refs,
 * post-transition adoption, inverse to-one creates, and nested mutations.
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
import { MySQL2BatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-mysql2";
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

  // E1 U1/U2 — the to-one lookup fold. MySQL is the leg that decides the
  // self-relation shape: `SET parentId = (SELECT … FROM the mutated table)` is
  // ERROR 1093 here unless the lookup hides behind a derived table (rule 11).
  runParentHeldLookupBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runBeforeRootSubtreeBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runUpsertArmRelationBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runNonPkReferenceBehavior({
    name: "MySQL2",
    createDriver: createMySQL2Driver,
  });

  runLocatedParentRefBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runLocatedParentRefBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
    // MySQL's skipDuplicates has no portable SQL leaf, so the skip is the
    // savepoint-wrapped executor effect — which a single atomic batch cannot carry.
    skipDuplicatesInBatchIsInexpressible: true,
  });

  runPostTransitionAdoptBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runPostTransitionAdoptBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runInverseToOneCreateBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runInverseToOneCreateBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });

  runNestedMutationBehavior({
    name: "MySQL2 transaction",
    createDriver: createMySQL2Driver,
  });

  runNestedMutationBehavior({
    name: "MySQL2 atomic batch",
    createDriver: () =>
      new MySQL2BatchForcedDriver({
        databaseUrl: TEST_CONNECTION_STRING,
      }),
    createStateDriver: createMySQL2Driver,
  });
});
