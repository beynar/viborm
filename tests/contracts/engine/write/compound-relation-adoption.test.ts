import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import {
  compoundAdoptSchema,
  registerCompoundAdoptBehavior,
} from "@tests/contracts/engine/write/compound-relation-adoption-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

async function setup(driver: PGliteDriver) {
  const client = createClient({ schema: compoundAdoptSchema, driver });
  await syncLiveSchema(client);
  return client;
}

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
  let shared: Awaited<ReturnType<typeof setup>> | undefined;
  registerCompoundAdoptBehavior(substrate.name, async () => {
    shared ??= await setup(substrate.make());
    return shared;
  });
}
