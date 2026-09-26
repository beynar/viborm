/**
 * LibSQL provider boundary: the refusal of effectful live-schema setup, and the contracts that build their own tables and so run on LibSQL: the GeoPoint storage tier and the batch-reference smoke.
 *
 * One file of the LibSQL provider suite, which is split across sibling
 * `libsql-*.test.ts` files. Every registered contract instantiates the
 * client's generic surface over its own multi-model schema, and the 1280 MB
 * TypeScript shard heap holds only a handful of those instantiations per
 * program, so the suite is partitioned by schema group rather than by size.
 * The forced-batch driver the batch contracts need lives in
 * `./libsql-fixtures`, which Vitest does not collect.
 */

import { createClient } from "@client/client";
import { VibORMErrorCode } from "@errors";
import { s } from "@schema";
import { batchRefSmokeContract } from "@tests/contracts/drivers/behaviors/batch-ref-smoke-behavior";
import {
  geoPointBatchContract,
  geoPointContract,
  setupGeoPointBehaviorSQLite,
} from "@tests/contracts/drivers/behaviors/geopoint-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";
import { BatchOnlyLibSQLDriver } from "./libsql-fixtures";

describe("LibSQL Driver", () => {
  test("refuses effectful live-schema setup", async () => {
    const user = s.model({ id: s.string().id() });
    const client = createClient({
      schema: { user },
      driver: createInMemoryLibSQLDriver(),
    });
    // Effectful V1 push is refused on libsql. Do not convert this setup
    // path to syncLiveSchema expecting success.
    await expect(syncLiveSchema(client)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    await client.$disconnect();
  });
  geoPointContract.register({
    driverName: "LibSQL",
    createDriver: createInMemoryLibSQLDriver,
    tier: "storage",
    rawSelectSql:
      'SELECT "location" FROM "geopoint_behavior_places" WHERE "id" = \'raw\'',
    setup: setupGeoPointBehaviorSQLite,
  });
  geoPointBatchContract.register({
    driverName: "LibSQL forced native batch",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
  batchRefSmokeContract.register({
    driverName: "LibSQL batch-only",
    createDriver: () => new BatchOnlyLibSQLDriver(),
  });
});
