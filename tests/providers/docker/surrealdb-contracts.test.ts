/**
 * The shared driver contracts on SurrealDB. Gated on SURREAL_TEST_URL.
 */

import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { bulkWriteLimitContract } from "@tests/contracts/drivers/behaviors/bulk-write-limit-behavior";
import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { countAggregateWindowContract } from "@tests/contracts/drivers/behaviors/count-aggregate-window-behavior";
import { createManyReturnFoldContract } from "@tests/contracts/drivers/behaviors/create-many-return-fold-behavior";
import { cursorPaginationContract } from "@tests/contracts/drivers/behaviors/cursor-pagination-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { distinctSkipWindowContract } from "@tests/contracts/drivers/behaviors/distinct-skip-window-behavior";
import { fieldReferenceContract } from "@tests/contracts/drivers/behaviors/field-reference-behavior";
import { geoPointContract } from "@tests/contracts/drivers/behaviors/geopoint-behavior";
import { implicitReturningContract } from "@tests/contracts/drivers/behaviors/implicit-returning-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { nestedOrderByContract } from "@tests/contracts/drivers/behaviors/nested-orderby-behavior";
import { nestedPaginationContract } from "@tests/contracts/drivers/behaviors/nested-pagination-behavior";
import { nestedWriteAdvancedContract } from "@tests/contracts/drivers/behaviors/nested-write-advanced-behavior";
import { nestedWriteContract } from "@tests/contracts/drivers/behaviors/nested-write-behavior";
import { nestedWriteConcurrencyContract } from "@tests/contracts/drivers/behaviors/nested-write-concurrency-behavior";
import { nestedWriteJsonEnvelopeContract } from "@tests/contracts/drivers/behaviors/nested-write-json-envelope-behavior";
import { omitContract } from "@tests/contracts/drivers/behaviors/omit-behavior";
import { optionalRelationParityContract } from "@tests/contracts/drivers/behaviors/optional-relation-parity-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import { readPathRegressionContract } from "@tests/contracts/drivers/behaviors/read-path-regression-behavior";
import { relationFilterMutationContract } from "@tests/contracts/drivers/behaviors/relation-filter-mutation-behavior";
import { relationReadAggregateContract } from "@tests/contracts/drivers/behaviors/relation-read-aggregate-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { upsertAtomicityContract } from "@tests/contracts/drivers/behaviors/upsert-atomicity-behavior";
import { vectorContract } from "@tests/contracts/drivers/behaviors/vector-behavior";
import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { beforeEach, describe } from "vitest";

/** Tests a shared contract states in SQL's own words, each with why it cannot run here. */
const WAIVED: Readonly<Record<string, string>> = {
  "an arithmetic expression compares against the row": "an SQL fragment",
  "a scalar subquery compares against the whole table": "an SQL fragment",
  "a fragment drives updateMany and deleteMany": "an SQL fragment",
  "a fragment survives both execution substrates": "an SQL fragment",
  "four same-shape rows are ONE statement, and the rows come back in input order":
    "reads the SQL text",
  "row shapes that differ split into one statement per contiguous run, still in input order":
    "reads the SQL text",
  "skipDuplicates with select is ONE statement whose rows are exactly the rows inserted":
    "reads the SQL text",
  "an owner-scoped orphan fails the read, even hidden behind only":
    "an edge cannot outlive its record, and the setup drops a SQL constraint",
  "a singular-inverse duplicate fails BEFORE the LIMIT":
    "the setup drops a SQL constraint to plant the duplicate",
  "an identifier against a plain string column is refused, not answered":
    "a key here is its public text, so it answers; surrealdb-keys.test.ts checks that",
  "the column has the type `tally`'s map names on this dialect":
    "reads a SQL column type",
  "include resolves junction join through mapped PK columns":
    "seeds the junction in SQL; surrealdb-keys.test.ts covers it",
  "relation filter resolves junction join through mapped PK columns":
    "seeds the junction in SQL; surrealdb-keys.test.ts covers it",
  "every quantifier through the junction answers the same in both directions":
    "seeds the junction in SQL; surrealdb-keys.test.ts covers it",
};

const named = {
  name: "SurrealDB",
  driverName: "SurrealDB",
  createDriver: createSurrealTestDriver,
  createTxDriver: createSurrealTestDriver,
} as never;

describe.skipIf(!surrealUrl)("SurrealDB", () => {
  runThroughModelBehavior({
    name: "SurrealDB",
    createDriver: createSurrealTestDriver,
  } as never);
  // biome-ignore lint/style/noDoneCallback: the test's context, to skip it by name.
  beforeEach((context) => {
    if (WAIVED[context.task.name]) context.skip();
  });

  blobFilterContract.register(named);
  bulkWriteLimitContract.register(named);
  compoundKeyContract.register(named);
  countAggregateWindowContract.register(named);
  cursorPaginationContract.register(named);
  geoPointContract.register({
    driverName: "SurrealDB",
    createDriver: createSurrealTestDriver,
    tier: "full",
    rawSelectSql:
      "SELECT location FROM geopoint_behavior_places WHERE record::id(id) = 'raw'",
  } as never);
  vectorContract.register({
    driverName: "SurrealDB",
    enabled: true,
    createDriver: createSurrealTestDriver,
  } as never);
  decimalExactnessContract.register({
    driverName: "SurrealDB",
    createDriver: createSurrealTestDriver,
    descriptor: { precision: 16, scale: 2 },
  } as never);
  distinctSkipWindowContract.register(named);
  fieldReferenceContract.register(named);
  implicitReturningContract.register(named);
  jsonNullSentinelContract.register(named);
  likeEscapeContract.register(named);
  listJsonFilterContract.register(named);
  manyToManyContract.register(named);
  nestedOrderByContract.register(named);
  nestedPaginationContract.register(named);
  nestedWriteAdvancedContract.register(named);
  nestedWriteContract.register(named);
  nestedWriteJsonEnvelopeContract.register(named);
  omitContract.register(named);
  optionalRelationParityContract.register(named);
  orderingArrayCreateContract.register(named);
  prismaParityContract.register(named);
  readPathRegressionContract.register(named);
  relationFilterMutationContract.register(named);
  relationReadAggregateContract.register(named);
  scalarRoundtripContract.register(named);
  fullScalarRoundtripContract.register(named);
  upsertAtomicityContract.register(named);
  compoundJunctionContract.register(named);
  createManyReturnFoldContract.register(named);
  polymorphicRelationContract.register(named);
  polymorphicCollectionReadContract.register(named);
  polymorphicCollectionWriteContract.register(named);
  nestedWriteConcurrencyContract.register(named);
});
