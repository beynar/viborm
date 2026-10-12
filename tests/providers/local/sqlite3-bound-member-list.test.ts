/**
 * SQLite3 Driver Tests — a scalar list bound as one parameter (engine-09) and
 * a same-column OR read as that list (platform-15).
 */

import { runBoundMemberListBehavior } from "@tests/contracts/engine/query/bound-member-list-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

runBoundMemberListBehavior({
  name: "SQLite3",
  dialect: "sqlite",
  createDriver: createInMemorySQLite3Driver,
});
