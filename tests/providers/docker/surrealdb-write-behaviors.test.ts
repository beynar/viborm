/**
 * The write behaviours the other providers run on live servers, on SurrealDB.
 * Gated on SURREAL_TEST_URL.
 *
 * Not here: a column an insert generates beside a record's id, which push refuses by
 * name. A sequence reaches only the id (fresh-produced-field, produced-compound-identity).
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

/** What this driver answers otherwise, or refuses by name, by the start of its name. */
const WAIVED: Readonly<Record<string, string>> = {
  "a REF parent source":
    "a generated key is known here when the arm reads it, so it can agree",
  "PORTABLE ARITHMETIC on the key":
    "arithmetic on a record's key refuses by name",
  "a primary-key transition writes descendants":
    "arithmetic on a record's key refuses by name",
  "a mixed row keeps the polymorphic membership":
    "reads the table raw, in SQL's words",
  "connect: the record's key moves":
    "moving a record's key through a relation refuses by name",
  "compound shared keys use every member":
    "moving a record's key through a relation refuses by name",
  "upsert FOUND publishes the target's post-update":
    "a key change under a key that holds it refuses by name",
  "update publishes the target's post-update key":
    "a key change under a key that holds it refuses by name",
  "a partial compound shared edge":
    "a key referenced by another field refuses by name",
  "upsert FOUND publishes a relation-folded":
    "moving a record's key through a relation refuses by name",
  "update publishes a nested relation-folded":
    "moving a record's key through a relation refuses by name",
  "a connect selected by alternate unique":
    "moving a record's key through a relation refuses by name",
  "a selected fold that keeps the key":
    "moving a record's key through a relation refuses by name",
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
