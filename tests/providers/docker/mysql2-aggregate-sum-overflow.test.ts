/** engine-10 on mysql2: see `aggregate-sum-overflow-cases.ts`. */
import { runAggregateSumOverflowCases } from "@tests/providers/local/aggregate-sum-overflow-cases";
import { describe } from "vitest";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

(TEST_CONNECTION_STRING ? describe : describe.skip)("mysql2", () => {
  runAggregateSumOverflowCases({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    table: "sum_overflow_reading",
  });
});
