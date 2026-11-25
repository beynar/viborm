/** pg Driver Tests — views kept by triggers. */

import { PgDriver } from "@drivers/pg";
import { runAutoViewsBehavior } from "@tests/contracts/public-client/schema-auto-views-behavior";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  runAutoViewsBehavior({
    name: "pg",
    dialect: "postgresql",
    concurrent: true,
    roles: true,
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
