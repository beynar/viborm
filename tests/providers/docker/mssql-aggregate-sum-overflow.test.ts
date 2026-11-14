/**
 * SQL Server: `_sum` past the column's type and past 2^53. The shared suite;
 * set MSSQL_TEST_CONNECTION_STRING to run.
 */
import { runAggregateSumOverflowCases } from "@tests/providers/local/aggregate-sum-overflow-cases";
import { describe } from "vitest";
import { createMssqlDriver, TEST_CONNECTION_STRING } from "./mssql-fixtures";

(TEST_CONNECTION_STRING ? describe : describe.skip)("SQL Server", () => {
  runAggregateSumOverflowCases({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
    table: "sum_overflow_reading",
    intSum: "mssql",
  });
});
