import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";

import {
  registerSharedPkUpdateRootBehavior,
  sharedPkUpdateRootSchema,
} from "@tests/contracts/engine/write/shared-pk-update-root-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * Package E's live legs on the credential-free substrates. The atomic-batch leg is the
 * one that matters most: the create-root defect this lift had to avoid reproducing
 * COMMITTED its write there and reported an internal error afterwards, so a terminal
 * that addressed the pre-fold key would show up here as a passing write with a failing
 * read rather than as a clean refusal.
 */
const substrates = [
  {
    name: "PGlite transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
    includeProducedKey: true,
  },
  {
    name: "PGlite atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
    includeProducedKey: false,
  },
  {
    name: "better-sqlite3",
    make: () => new SQLite3Driver({ dataDir: ":memory:" }),
    includeProducedKey: true,
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerSharedPkUpdateRootBehavior(
    substrate.name,
    async () => {
      if (!shared) {
        shared = createClient({
          schema: sharedPkUpdateRootSchema,
          driver: substrate.make(),
        }) as any;
        await syncLiveSchema(shared);
      }
      return shared;
    },
    describe,
    { includeProducedKey: substrate.includeProducedKey }
  );
}
