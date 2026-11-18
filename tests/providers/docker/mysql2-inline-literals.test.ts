/**
 * mysql2 Driver Tests — a read's bound values written as MySQL literals
 * (the body of a view) read the rows the bound statement reads.
 */

import { runInlineLiteralsBehavior } from "@tests/contracts/adapters/inline-literals-behavior";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("mysql2 Driver", () => {
  runInlineLiteralsBehavior({
    name: "mysql2",
    dialect: "mysql",
    createDriver: createMySQL2Driver,
  });
});
