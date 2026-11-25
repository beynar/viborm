/** mysql2 Driver Tests — views kept by triggers. */

import { runAutoViewsBehavior } from "@tests/contracts/public-client/schema-auto-views-behavior";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("mysql2 Driver", () => {
  runAutoViewsBehavior({
    name: "mysql2",
    dialect: "mysql",
    concurrent: true,
    createDriver: createMySQL2Driver,
  });
});
