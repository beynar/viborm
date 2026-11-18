/**
 * mysql2 Driver Tests — schema views: created from their bodies, read like
 * tables, their JSON columns decoded as the read that carried them.
 */

import { runSchemaViewsBehavior } from "@tests/contracts/public-client/schema-views-behavior";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("mysql2 Driver", () => {
  runSchemaViewsBehavior({
    name: "mysql2",
    dialect: "mysql",
    createDriver: createMySQL2Driver,
  });
});
