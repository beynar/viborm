/** Trimmed projection SQL (json_group_array without json(), no COALESCE on counts, no WHERE TRUE) answers as before on SQLite. */

import { runProjectionTrimsBehavior } from "@tests/contracts/public-client/projection-trims-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

runProjectionTrimsBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});
