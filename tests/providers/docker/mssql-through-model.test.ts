/**
 * SQL Server: a declared model as a junction (`.through()`), plain and under
 * permissions, each in a schema of its own. The shared suites; set
 * MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runThroughModelGovernedBehavior } from "@tests/contracts/engine/query/through-model-governed-behavior";
import { runThroughModelBehavior } from "@tests/contracts/engine/write/through-model-behavior";
import { afterAll, beforeAll, describe } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  SQL_SERVER,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_through_model";
const GOVERNED_NAMESPACE = "viborm_through_model_governed";

describeIf("SQL Server Driver", () => {
  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await createSchema(GOVERNED_NAMESPACE);
  });
  afterAll(async () => {
    await dropSchema(NAMESPACE);
    await dropSchema(GOVERNED_NAMESPACE);
  });

  runThroughModelBehavior({
    name: SQL_SERVER,
    createDriver: () => createMssqlDriverIn(NAMESPACE),
    refusesRecursion: true,
    heldParentPath: true,
  });
  runThroughModelGovernedBehavior({
    name: SQL_SERVER,
    createDriver: () => createMssqlDriverIn(GOVERNED_NAMESPACE),
    refusesRecursion: true,
  });
});
