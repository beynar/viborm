/**
 * SQLite3 Driver Tests — schema views: created from their bodies, read like
 * tables, their JSON columns decoded as the read that carried them.
 */

import { runSchemaViewsBehavior } from "@tests/contracts/public-client/schema-views-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

runSchemaViewsBehavior({
  name: "SQLite3",
  dialect: "sqlite",
  createDriver: createInMemorySQLite3Driver,
});
