/**
 * pg Driver Tests — a read's bound values written as PostgreSQL literals
 * (the body of a view) read the rows the bound statement reads.
 */

import { PgDriver } from "@drivers/pg";
import { runInlineLiteralsBehavior } from "@tests/contracts/adapters/inline-literals-behavior";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  runInlineLiteralsBehavior({
    name: "pg",
    dialect: "postgresql",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
