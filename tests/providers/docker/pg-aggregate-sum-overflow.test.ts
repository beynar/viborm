/** engine-10 on pg: see `aggregate-sum-overflow-cases.ts`. */
import { PgDriver } from "@drivers/pg";
import { runAggregateSumOverflowCases } from "@tests/providers/local/aggregate-sum-overflow-cases";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

(TEST_CONNECTION_STRING ? describe : describe.skip)("pg", () => {
  runAggregateSumOverflowCases({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    table: "sum_overflow_reading",
    intSum: "postgresql",
  });
});
