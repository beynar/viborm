import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import {
  producedIdentitySchema,
  registerProducedIdentityBehavior,
} from "@tests/contracts/engine/write/junction-produced-identity-behavior";
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
  registerProducedIdentityBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: producedIdentitySchema,
        driver: substrate.make(),
      });
      await syncLiveSchema(shared);
    }
    return shared;
  });
}
