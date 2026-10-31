/**
 * pg Driver Tests - `viborm/ordering` on a real PostgreSQL server.
 *
 * Twice: in the default schema, and in a private one (a namespace), where
 * respacing must name the table the client's queries name.
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

const NAMESPACE = "viborm_ordering";

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

  describe("in a namespace", () => {
    const admin = new PgDriver({ databaseUrl: TEST_CONNECTION_STRING });
    afterAll(async () => {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
      await admin.disconnect();
    });

    describeOrdering("pg, in a namespace", async () => {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
      await admin._executeRaw(`CREATE SCHEMA "${NAMESPACE}"`);
      const client = createClient({
        schema,
        driver: new PgDriver({
          databaseUrl: TEST_CONNECTION_STRING,
          namespace: NAMESPACE,
        }),
      });
      await syncLiveSchema(client);
      return { client };
    });
  });
});
