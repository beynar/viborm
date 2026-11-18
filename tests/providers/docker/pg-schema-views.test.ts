/**
 * pg Driver Tests — schema views: created from their bodies, read like
 * tables, their JSON columns decoded as the read that carried them.
 */

import { PgDriver } from "@drivers/pg";
import { runSchemaViewsBehavior } from "@tests/contracts/public-client/schema-views-behavior";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  runSchemaViewsBehavior({
    name: "pg",
    dialect: "postgresql",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
