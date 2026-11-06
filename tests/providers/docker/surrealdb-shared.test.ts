/**
 * The shared behaviours the other providers run, on SurrealDB. Gated on
 * SURREAL_TEST_URL.
 */

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
import { runStampedRequiredBehavior } from "@tests/contracts/engine/write/stamped-required-behavior";
import { runBulkWhereUndefinedBehavior } from "@tests/contracts/public-client/bulk-where-undefined-behavior";
import { runBoundViewsBehavior } from "@tests/contracts/public-client/extension-bound-views-behavior";
import { runProjectionTrimsBehavior } from "@tests/contracts/public-client/projection-trims-behavior";
import { runResultFieldsBehavior } from "@tests/contracts/public-client/result-fields-behavior";
import { runSharedBodiesBehavior } from "@tests/contracts/public-client/shared-bodies-behavior";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeEach, describe } from "vitest";

const LIST_FORM = / IN \$p\d+/;
const NOT_LIST_FORM = / NOT IN \$p\d+/;

/** What reads SQL's plan rather than what a call does, by the start of its name. */
const WAIVED: Readonly<Record<string, string>> = {
  "250 nested children are one INSERT": "counts the INSERTs of SQL's plan",
  "children past the bind budget split":
    "reads SQL's bind budget, which this driver does not have",
  "every tombstone writes the update stamp":
    "reads the text of SQL's UPDATE statements",
  "a soft delete behind restrict children":
    "reads SQL's lock and EXISTS statements; no read here takes a lock",
  "an orphan link row and a malformed singular inverse fail the read":
    "writes a junction's columns raw, which an edge table does not have",
  "SurrealDB: nested includes three deep keep their JSON documents":
    "reads the aliases of SQL's projection",
  "SurrealDB: an unbounded, unfiltered walk states no WHERE":
    "reads SQL's WITH RECURSIVE",
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
  runRefusalClassificationBehavior(provider);
  runThroughModelGovernedBehavior(provider);
  runJunctionSideActionsBehavior(provider);
  runStampedRequiredBehavior(provider);
  runNestedCreateBatchBehavior({ ...named, countsInserts: false });
  runExtensionDataBehavior(provider);
  runDeletionCapabilityBehavior({ ...provider, restrictedDelete: 0 });
  runSharedBodiesBehavior(provider);
  runResultFieldsBehavior(provider);
  runProjectionTrimsBehavior(provider);
  runBoundViewsBehavior({
    ...provider,
    prepare: (client) => syncLiveSchema(client as never).then(() => undefined),
  });
  runBulkWhereUndefinedBehavior(provider);
});
