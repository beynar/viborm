/**
 * The write behaviours the other providers run on live servers, on SurrealDB.
 * Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import {
  adoptOwnedFkSchema,
  registerAdoptOwnedFkBehavior,
} from "@tests/contracts/engine/write/adopt-owned-fk-agreement-behavior";
import {
  compileTransitionSchema,
  registerCompileTransitionBehavior,
} from "@tests/contracts/engine/write/compiled-key-transition-behavior";
import {
  compoundAdoptSchema,
  registerCompoundAdoptBehavior,
} from "@tests/contracts/engine/write/compound-relation-adoption-behavior";
import {
  createJunctionUpsertSchema,
  registerCreateJunctionUpsertBehavior,
} from "@tests/contracts/engine/write/create-junction-upsert-behavior";
import {
  createManySeriesSchema,
  registerCreateManySeriesBehavior,
} from "@tests/contracts/engine/write/create-many-relation-series-behavior";
import {
  destinationCastSchema,
  registerDestinationCastBehavior,
} from "@tests/contracts/engine/write/destination-cast-behavior";
import {
  producedFieldSchema,
  registerProducedFieldBehavior,
  registerTwoSequenceBehavior,
  twoSequenceSchema,
} from "@tests/contracts/engine/write/fresh-produced-field-behavior";
import {
  producedIdentitySchema,
  registerProducedIdentityBehavior,
} from "@tests/contracts/engine/write/junction-produced-identity-behavior";
import {
  junctionUpsertArmSchema,
  registerJunctionUpsertArmProbeBehavior,
} from "@tests/contracts/engine/write/junction-upsert-arm-probe-behavior";
import {
  parentHeldCompoundEdgeSchema,
  registerParentHeldCompoundEdgeBehavior,
} from "@tests/contracts/engine/write/parent-held-compound-edge-behavior";
import {
  producedCompoundSchema,
  registerProducedCompoundBehavior,
} from "@tests/contracts/engine/write/produced-compound-identity-behavior";
import {
  registerSharedPkConnectOrCreateBehavior,
  sharedPkConnectOrCreateSchema,
} from "@tests/contracts/engine/write/shared-pk-connect-or-create-behavior";
import {
  registerSharedPkUpdateRootBehavior,
  sharedPkUpdateRootSchema,
} from "@tests/contracts/engine/write/shared-pk-update-root-behavior";
import {
  registerSqlOperandWallBehavior,
  sqlOperandWallSchema,
} from "@tests/contracts/engine/write/sql-operand-boundary-behavior";
import {
  registerSupplierContinuationBehavior,
  registerSupplierContinuationRefusals,
  supplierContinuationSchema,
} from "@tests/contracts/engine/write/supplier-continuation-behavior";
import {
  registerUpdateManySeriesBehavior,
  updateManySeriesSchema,
} from "@tests/contracts/engine/write/update-many-relation-series-behavior";
import {
  registerVacateThenSupplyBehavior,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeEach, describe } from "vitest";

const enabled = surrealUrl ? describe : describe.skip;

/** What this driver answers otherwise, by the start of its name. */
const WAIVED: Readonly<Record<string, string>> = {
  "a REF parent source":
    "a generated key is known here when the arm reads it, so it can agree",
};
const waived = (name: string) =>
  Object.keys(WAIVED).some((start) => name.startsWith(start));

// biome-ignore lint/style/noDoneCallback: the test's context, to skip it by name.
beforeEach((context) => {
  if (waived(context.task.name)) context.skip();
});

/** A client over `schema`, pushed on first use and closed with the suite. */
function connecting(schema: unknown): () => Promise<any> {
  let shared: any;
  afterAll(async () => {
    await shared?.$disconnect();
  });
  return async () => {
    if (!shared) {
      shared = createClient({
        schema: schema as never,
        driver: createSurrealTestDriver(),
      }) as any;
      await syncLiveSchema(shared);
    }
    return shared;
  };
}

registerAdoptOwnedFkBehavior(
  "SurrealDB",
  connecting(adoptOwnedFkSchema),
  enabled
);
registerCompileTransitionBehavior(
  "SurrealDB",
  connecting(compileTransitionSchema),
  enabled
);
registerCompoundAdoptBehavior(
  "SurrealDB",
  connecting(compoundAdoptSchema),
  enabled
);
registerCreateJunctionUpsertBehavior(
  "SurrealDB",
  connecting(createJunctionUpsertSchema),
  enabled
);
registerCreateManySeriesBehavior(
  "SurrealDB",
  connecting(createManySeriesSchema),
  enabled
);
registerDestinationCastBehavior(
  "SurrealDB",
  connecting(destinationCastSchema),
  enabled
);
registerProducedIdentityBehavior(
  "SurrealDB",
  connecting(producedIdentitySchema),
  enabled
);
registerJunctionUpsertArmProbeBehavior(
  "SurrealDB",
  connecting(junctionUpsertArmSchema),
  enabled
);
registerParentHeldCompoundEdgeBehavior(
  "SurrealDB",
  connecting(parentHeldCompoundEdgeSchema),
  enabled
);
registerSharedPkConnectOrCreateBehavior(
  "SurrealDB",
  connecting(sharedPkConnectOrCreateSchema),
  enabled
);
registerSharedPkUpdateRootBehavior(
  "SurrealDB",
  connecting(sharedPkUpdateRootSchema),
  enabled
);
registerSqlOperandWallBehavior(
  "SurrealDB",
  connecting(sqlOperandWallSchema),
  enabled
);
registerUpdateManySeriesBehavior(
  "SurrealDB",
  connecting(updateManySeriesSchema),
  enabled
);
registerVacateThenSupplyBehavior(
  "SurrealDB",
  connecting(vacateThenSupplySchema),
  enabled
);
registerSupplierContinuationBehavior(
  "SurrealDB",
  connecting(supplierContinuationSchema),
  enabled
);
registerSupplierContinuationRefusals(
  "SurrealDB",
  connecting(supplierContinuationSchema),
  enabled
);
registerProducedFieldBehavior(
  "SurrealDB",
  connecting(producedFieldSchema),
  enabled
);
registerTwoSequenceBehavior(
  "SurrealDB",
  connecting(twoSequenceSchema),
  enabled
);
registerProducedCompoundBehavior(
  "SurrealDB",
  connecting(producedCompoundSchema),
  enabled
);
