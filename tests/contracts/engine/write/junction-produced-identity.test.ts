import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import {
  producedIdentitySchema,
  registerProducedIdentityBehavior,
} from "@tests/contracts/engine/write/junction-produced-identity-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/**
 * `createClient` is generic over the whole configuration literal, so
 * `ReturnType<typeof createClient>` names its CONSTRAINT instantiation
 * (`VibORMClient<VibORMConfig<Schema>>`), which this suite's schema-shaped
 * client is not assignable to. Naming the holder through `setup` keeps the real
 * client type and leaves nothing to synchronize after the live schema is in.
 */
async function setup(driver: PGliteDriver) {
  const client = createClient({ schema: producedIdentitySchema, driver });
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
  registerProducedIdentityBehavior(substrate.name, async () => {
    shared ??= await setup(substrate.make());
    return shared;
  });
}
