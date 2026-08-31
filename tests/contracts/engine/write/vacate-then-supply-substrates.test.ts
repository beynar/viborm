import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import {
  registerVacateThenSupplyBehavior,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * E6.5's live per-substrate bed. `registerVacateThenSupplyBehavior` mounts the same
 * sixteen witnesses on the transaction driver and on the forced atomic-batch driver,
 * and each substrate answers from ONE lazily created shared client: two databases for
 * the whole registration. That is why the bed is its own file — the pair enumeration
 * and the parent-held slices beside it open a FRESH database per test and have nothing
 * to share with these two.
 */
const substrates = [
  {
    name: "transaction",
    make: (db: PGlite) => new PGliteDriver({ client: db }),
  },
  {
    name: "atomic batch",
    make: (db: PGlite) => new BatchOnlyPGliteDriver({ client: db }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerVacateThenSupplyBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: vacateThenSupplySchema,
        driver: substrate.make(openBorrowedPGlite()),
      }) as any;
      await syncLiveSchema(shared);
    }
    return shared;
  });
}
