/**
 * The shared behaviours the other providers run, on SurrealDB. Gated on
 * SURREAL_TEST_URL.
 */

import {
  fkIndexContract,
  fkIndexUpgradeContract,
} from "@tests/contracts/drivers/behaviors/fk-index-behavior";
import { geoPointMigrationLifecycleContract } from "@tests/contracts/drivers/behaviors/geopoint-migration-lifecycle-behavior";
import {
  mappedIndexContract,
  partialIndexCoverageContract,
} from "@tests/contracts/drivers/behaviors/index-ddl-behavior";
import "@migrations/dialects/surrealql";
import { runBoundMemberListBehavior } from "@tests/contracts/engine/query/bound-member-list-behavior";
import { runBoundRowsBehavior } from "@tests/contracts/engine/query/bound-rows-behavior";
import { runDomainPredicateBehavior } from "@tests/contracts/engine/query/domain-predicate-behavior";
import { runRecursiveRelationFilterBehavior } from "@tests/contracts/engine/query/recursive-relation-filter-behavior";
import { runRefusalClassificationBehavior } from "@tests/contracts/engine/query/refusal-classification-behavior";
import { runRowScopeBehavior } from "@tests/contracts/engine/query/row-scope-behavior";
import { runThroughModelGovernedBehavior } from "@tests/contracts/engine/query/through-model-governed-behavior";
import { runDeletionCapabilityBehavior } from "@tests/contracts/engine/write/deletion-capability-behavior";
import { runExtensionDataBehavior } from "@tests/contracts/engine/write/extension-data-behavior";
import { runJunctionSideActionsBehavior } from "@tests/contracts/engine/write/junction-side-actions-behavior";
import { runNestedCreateBatchBehavior } from "@tests/contracts/engine/write/nested-create-batch-behavior";
import { runSkipSelectCaptureBehavior } from "@tests/contracts/engine/write/skip-select-capture-behavior";
import { runStampedRequiredBehavior } from "@tests/contracts/engine/write/stamped-required-behavior";
import { runBulkWhereUndefinedBehavior } from "@tests/contracts/public-client/bulk-where-undefined-behavior";
import { runBoundViewsBehavior } from "@tests/contracts/public-client/extension-bound-views-behavior";
import { runFindUniqueBatchingBehavior } from "@tests/contracts/public-client/find-unique-batching-behavior";
import { runProjectionTrimsBehavior } from "@tests/contracts/public-client/projection-trims-behavior";
import { runResultFieldsBehavior } from "@tests/contracts/public-client/result-fields-behavior";
import { runSharedBodiesBehavior } from "@tests/contracts/public-client/shared-bodies-behavior";
import {
  createSurrealRecordingDriver,
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeEach, describe } from "vitest";

const LIST_FORM = / IN \$p\d+/;
const NOT_LIST_FORM = / NOT IN \$p\d+/;

/** What reads SQL's plan rather than what a call does, by the start of its name. */
const WAIVED: Readonly<Record<string, string>> = {
  "children past the bind budget split":
    "reads SQL's bind budget, which this driver does not have",
  "the originating client inside its own callback transaction":
    "refused where a transaction holds the one connection, as on PGlite; here transactions sit side by side, as on a pool, and the read answers",
  "an orphan link row and a malformed singular inverse fail the read":
    "writes a junction's columns raw, which an edge table does not have",
};
const waived = (name: string) =>
  Object.keys(WAIVED).some((start) => name.startsWith(start));

const provider = { name: "SurrealDB", createDriver: createSurrealTestDriver };
const named = {
  driverName: "SurrealDB",
  createDriver: createSurrealTestDriver,
};

describe.skipIf(!surrealUrl)("SurrealDB", () => {
  // biome-ignore lint/style/noDoneCallback: the test's context, to skip it by name.
  beforeEach((context) => {
    if (waived(context.task.name)) context.skip();
  });
  runDomainPredicateBehavior(provider);
  runRowScopeBehavior(provider);
  runBoundRowsBehavior(provider);
  runBoundMemberListBehavior({
    ...provider,
    dialect: "postgresql",
    listForm: LIST_FORM,
    notListForm: NOT_LIST_FORM,
  } as never);
  runRecursiveRelationFilterBehavior(provider);
  runSkipSelectCaptureBehavior({ ...provider, supportsReturning: true });
  runFindUniqueBatchingBehavior({
    name: "SurrealDB",
    createDriver: () => createSurrealRecordingDriver() as never,
  });
  runRefusalClassificationBehavior(provider);
  runThroughModelGovernedBehavior(provider);
  runJunctionSideActionsBehavior(provider);
  runStampedRequiredBehavior(provider);
  runNestedCreateBatchBehavior({ ...named, countsInserts: false });
  runExtensionDataBehavior(provider);
  runDeletionCapabilityBehavior(provider);
  runSharedBodiesBehavior(provider);
  runResultFieldsBehavior(provider);
  runProjectionTrimsBehavior(provider);
  fkIndexContract.register(named as never);
  fkIndexUpgradeContract.register(named as never);
  mappedIndexContract.register(named as never);
  partialIndexCoverageContract.register(named as never);
  geoPointMigrationLifecycleContract.register({
    ...named,
    // A history starts from an empty database, whichever opened before it.
    createDriver: () => {
      const driver = createSurrealTestDriver() as never as {
        fresh(): Promise<void>;
      };
      driver.fresh();
      return driver as never;
    },
    physicalType: "geometry<point>",
    physicalIndexType: "spatial",
  } as never);
  runBoundViewsBehavior({
    ...provider,
    prepare: (client) => syncLiveSchema(client as never).then(() => undefined),
  });
  runBulkWhereUndefinedBehavior(provider);
});
