import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { runReadBehavior } from "@tests/contracts/engine/write/read-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";

import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";

// The read family on PGlite, in transaction and forced atomic-batch modes.
runReadBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});

// The batch arm binds both drivers to one PGlite instance so both clients read
// the same seeded database.
let sharedBatchDb: PGlite | undefined;
runReadBehavior({
  name: "PGlite atomic batch",
  createDriver: () => {
    sharedBatchDb = openBorrowedPGlite();
    return new PGliteDriver({ client: sharedBatchDb });
  },
  createObservedDriver: () =>
    new BatchOnlyPGliteDriver({ client: sharedBatchDb as PGlite }),
});
