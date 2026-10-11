/** engine-10 on sqlite3: see `aggregate-sum-overflow-cases.ts`. */
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { runAggregateSumOverflowCases } from "./aggregate-sum-overflow-cases";

runAggregateSumOverflowCases({
  driverName: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  table: "sum_overflow_reading",
  intSum: "sqlite",
});
