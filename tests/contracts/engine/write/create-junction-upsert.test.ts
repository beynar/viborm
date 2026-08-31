import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import {
  createJunctionUpsertSchema,
  registerCreateJunctionUpsertBehavior,
} from "@tests/contracts/engine/write/create-junction-upsert-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";


const substrates = [
  {
    name: "transaction",
    make: () => new PGliteDriver({ client: openBorrowedPGlite() }),
  },
  {
    name: "atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: openBorrowedPGlite() }),
  },
] as const;

for (const substrate of substrates) {
  let shared: ReturnType<typeof createClient> | undefined;
  registerCreateJunctionUpsertBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: createJunctionUpsertSchema,
        driver: substrate.make(),
      });
      await syncLiveSchema(shared);
    }
    return shared;
  });
}
