/**
 * MySQL2 Driver Tests - `viborm/ordering` on MySQL: an append reads the last
 * key of its list first (a consistent read), since the one-statement form
 * deadlocks under concurrent appends there.
 *
 * NOTE: These tests require a running MySQL database.
 */

import { createClient } from "@client/client";
import {
  describeOrdering,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  describeOrdering(
    "MySQL2",
    async () => {
      await dropEveryLiveTable();
      const client = createClient({ schema, driver: createMySQL2Driver() });
      await syncLiveSchema(client);
      return { client };
    },
    // The read of the last key, the INSERT, and the read of the created row
    // a MySQL create always takes (no RETURNING).
    3
  );
});
