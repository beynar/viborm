/** SQLite3 Driver Tests — views kept by triggers. */

import { runAutoViewsBehavior } from "@tests/contracts/public-client/schema-auto-views-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

runAutoViewsBehavior({
  name: "SQLite3",
  dialect: "sqlite",
  createDriver: createInMemorySQLite3Driver,
});
