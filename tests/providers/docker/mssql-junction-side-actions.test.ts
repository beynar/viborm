/**
 * SQL Server: what a junction's side actions do, in a schema of its own. The
 * shared suite; set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runJunctionSideActionsBehavior } from "@tests/contracts/engine/write/junction-side-actions-behavior";
import { afterAll, beforeAll, describe } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  SQL_SERVER,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_junction_side_actions";

describeIf("SQL Server Driver", () => {
  beforeAll(() => createSchema(NAMESPACE));
  afterAll(() => dropSchema(NAMESPACE));

  runJunctionSideActionsBehavior({
    name: SQL_SERVER,
    createDriver: () => createMssqlDriverIn(NAMESPACE),
    refusesMigrations: true,
  });
});
