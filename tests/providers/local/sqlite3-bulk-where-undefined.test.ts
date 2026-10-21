/** A bulk write whose where only undefined members emptied is refused on SQLite; an explicit every-row where is not. */

import { runBulkWhereUndefinedBehavior } from "@tests/contracts/public-client/bulk-where-undefined-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

runBulkWhereUndefinedBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});
