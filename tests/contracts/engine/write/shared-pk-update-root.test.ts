import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";

import {
  registerSharedPkUpdateRootBehavior,
  sharedPkUpdateRootSchema,
} from "@tests/contracts/engine/write/shared-pk-update-root-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe } from "vitest";

/**
 * Package E's live legs on the credential-free substrates. The atomic-batch leg is the
 * one that matters most: the create-root defect this lift had to avoid reproducing
 * COMMITTED its write there and reported an internal error afterwards, so a terminal
 * that addressed the pre-fold key would show up here as a passing write with a failing
 * read rather than as a clean refusal.
 */
const getTransactionFamily = usePGliteSchemaFamily(
  sharedPkUpdateRootSchema,
  "transaction"
);
const getBatchFamily = usePGliteSchemaFamily(
  sharedPkUpdateRootSchema,
  "atomicBatch"
);

let sharedSqlite: any;
const connectSqlite = async () => {
  if (!sharedSqlite) {
    sharedSqlite = createClient({
      schema: sharedPkUpdateRootSchema,
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    }) as any;
    await syncLiveSchema(sharedSqlite);
  }
  return sharedSqlite;
};

const substrates = [
  {
    name: "PGlite transaction",
    connect: async () => getTransactionFamily().client as any,
    includeProducedKey: true,
  },
  {
    name: "PGlite atomic batch",
    connect: async () => getBatchFamily().client as any,
    includeProducedKey: false,
  },
  {
    name: "better-sqlite3",
    connect: connectSqlite,
    includeProducedKey: true,
  },
] as const;

for (const substrate of substrates) {
  registerSharedPkUpdateRootBehavior(
    substrate.name,
    substrate.connect,
    describe,
    { includeProducedKey: substrate.includeProducedKey }
  );
}
