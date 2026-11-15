/**
 * SQL Server: the produced row, which comes back from no INSERT (SQL Server
 * has no RETURNING here), in a schema of its own per test. The shared suite;
 * set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runProducedRowBehavior } from "@tests/contracts/engine/query/produced-row-behavior";
import { describe } from "vitest";
import {
  isolatedSchema,
  SQL_SERVER,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  runProducedRowBehavior({
    ...isolatedSchema("viborm_produced_rows", true),
    name: SQL_SERVER,
    refusesRecursion: true,
  });
});
