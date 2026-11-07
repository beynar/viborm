/**
 * The permissions extension's shared behaviours, on SurrealDB. Gated on
 * SURREAL_TEST_URL.
 */

import { runPermissionsAdversarialBehavior } from "@tests/contracts/public-client/permissions-adversarial-behavior";
import { runPermissionsAppBehavior } from "@tests/contracts/public-client/permissions-app-behavior";
import { runPermissionsAppPlacement } from "@tests/contracts/public-client/permissions-app-placement";
import { runPermissionsAppVerbs } from "@tests/contracts/public-client/permissions-app-verbs";
import { runCompiledPolicyBehavior } from "@tests/contracts/public-client/permissions-compiled-policy-behavior";
import { runPermissionsEntryBehavior } from "@tests/contracts/public-client/permissions-entry-behavior";
import { runPermissionsEvidenceBehavior } from "@tests/contracts/public-client/permissions-evidence-behavior";
import { runPermissionsUpsertBehavior } from "@tests/contracts/public-client/permissions-upsert-behavior";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe } from "vitest";

const substrate = {
  name: "SurrealDB",
  createDriver: createSurrealTestDriver,
  prepare: async (client: Parameters<typeof syncLiveSchema>[0]) => {
    await syncLiveSchema(client);
  },
};

describe.skipIf(!surrealUrl)("SurrealDB", () => {
  runPermissionsAppBehavior(substrate);
  runPermissionsAppVerbs(substrate);
  runPermissionsAdversarialBehavior(substrate);
  runPermissionsEvidenceBehavior(substrate);
  runPermissionsUpsertBehavior(substrate);
  runCompiledPolicyBehavior({ ...substrate, timeout: 120_000 });
  runPermissionsEntryBehavior({ ...substrate, timeout: 300_000 });
  runPermissionsAppVerbs(substrate, { through: "entry" });
  runPermissionsAppPlacement({ ...substrate, timeout: 600_000 });
});
