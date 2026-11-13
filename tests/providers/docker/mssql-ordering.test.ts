/**
 * SQL Server: `viborm/ordering`. The shared suite; set
 * MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import {
  describeOrdering,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  describeOrdering(
    "SQL Server",
    async () => {
      await dropEveryLiveTable();
      const client = createClient({ schema, driver: createMssqlDriver() });
      await syncLiveSchema(client);
      return { client };
    },
    // The INSERT, which computes the key from the list's last one, and the
    // read of the created row a SQL Server create takes (no RETURNING).
    2,
    // A move reads the anchor, then its neighbours within its list (the
    // list field is nullable here), then updates, as on MySQL; an update
    // locks its row, writes it, and reads it back once (no RETURNING). An
    // upsert locates its row first: a create then inserts and reads it (the
    // ordered one computing its key in its INSERT); an update locks, writes
    // and reads it.
    { move: 5, update: 3, upsert: [3, 5, 3, 5] }
  );
});
