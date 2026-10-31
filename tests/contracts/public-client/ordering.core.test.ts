/** viborm/ordering on in-memory SQLite (`ordering-behavior.ts`). */

import { createClient } from "@client/client";
import {
  describeOrdering,
  describeOrderingAdmission,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const open = async () => {
  const client = createClient({ schema, driver: createInMemorySQLite3Driver() });
  await syncLiveSchema(client);
  return { client };
};

describeOrdering("SQLite", open);
describeOrderingAdmission(open);
