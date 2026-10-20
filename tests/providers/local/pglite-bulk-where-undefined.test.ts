/** A bulk write whose where only undefined members emptied is refused on PostgreSQL; an explicit every-row where is not. */

import { runBulkWhereUndefinedBehavior } from "@tests/contracts/public-client/bulk-where-undefined-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

runBulkWhereUndefinedBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
});
