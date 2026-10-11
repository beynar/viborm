/** engine-10 on PGlite: see `aggregate-sum-overflow-cases.ts`. */
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { runAggregateSumOverflowCases } from "./aggregate-sum-overflow-cases";

runAggregateSumOverflowCases({
  driverName: "PGlite",
  createDriver: createInMemoryPGliteDriver,
  table: "sum_overflow_reading",
  intSum: "postgresql",
});
