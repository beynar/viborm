import { rawIndexContract } from "@tests/contracts/drivers/behaviors/raw-index-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

rawIndexContract.register({
  driverName: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  push: true,
});
