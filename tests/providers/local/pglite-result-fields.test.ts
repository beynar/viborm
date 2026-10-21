/** `$extends({ result })` computed fields on PostgreSQL: reads, writes, nested rows, arrays, composition. */

import { runResultFieldsBehavior } from "@tests/contracts/public-client/result-fields-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runResultFieldsBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
});
