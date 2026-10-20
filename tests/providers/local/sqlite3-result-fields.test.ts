/** `$extends({ result })` computed fields on SQLite: reads, writes, nested rows, arrays, composition. */

import { runResultFieldsBehavior } from "@tests/contracts/public-client/result-fields-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

runResultFieldsBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});
