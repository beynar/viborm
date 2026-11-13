/**
 * SQL Server: the `rows` capability and domain predicates. The shared suite;
 * set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runDomainPredicateBehavior } from "@tests/contracts/engine/query/domain-predicate-behavior";
import { runRowScopeBehavior } from "@tests/contracts/engine/query/row-scope-behavior";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  beforeEach(dropEveryLiveTable);
  // The provider files share one database: leave it as empty as it was found.
  afterAll(dropEveryLiveTable);

  runRowScopeBehavior({
    name: "SQL Server",
    createDriver: createMssqlDriver,
    refusesRecursion: true,
  });
  runDomainPredicateBehavior({
    name: "SQL Server",
    createDriver: createMssqlDriver,
    refusesRecursion: true,
  });
});
