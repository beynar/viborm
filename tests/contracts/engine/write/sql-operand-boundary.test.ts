import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import {
  registerSqlOperandWallBehavior,
  sqlOperandWallSchema,
} from "@tests/contracts/engine/write/sql-operand-boundary-behavior";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";


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
  registerSqlOperandWallBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: sqlOperandWallSchema,
        driver: substrate.make(openBorrowedPGlite()),
      }) as any;
      await syncLiveSchema(shared);
    }
    return shared;
  });
}
