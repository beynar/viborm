/** Native PostgreSQL array values must retain their member boundaries when sharing relation bodies. */
import { runSharedBodiesBehavior } from "@tests/contracts/public-client/shared-bodies-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runSharedBodiesBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
});
