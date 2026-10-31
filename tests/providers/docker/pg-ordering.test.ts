/**
 * pg Driver Tests - `viborm/ordering` on a real PostgreSQL server.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import {
  describeOrdering,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  describeOrdering("pg", async () => {
    await dropEveryLiveTable();
    const client = createClient({
      schema,
      driver: new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    });
    await syncLiveSchema(client);
    return { client };
  });
});
