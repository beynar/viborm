/**
 * PGlite Driver Tests — `viborm/ordering` on embedded PostgreSQL: the
 * interactive driver, and a batch-only one (every operation one atomic
 * batch, no interactive transaction).
 */

import { createClient } from "@client/client";
import {
  describeOrdering,
  schema,
} from "@tests/contracts/public-client/ordering-behavior";
import {
  BatchOnlyPGliteDriver,
  createInMemoryPGliteDriver,
} from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

describe("PGlite Driver", () => {
  describeOrdering("PGlite", async () => {
    const client = createClient({ schema, driver: createInMemoryPGliteDriver() });
    await syncLiveSchema(client);
    return { client };
  });
  describeOrdering("PGlite batch-only", async () => {
    const client = createClient({ schema, driver: new BatchOnlyPGliteDriver() });
    await syncLiveSchema(client);
    return { client };
  });
});
