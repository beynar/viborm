/**
 * SQL Server: `viborm/permissions` adversarial cases, in a schema of its own
 * (`viborm_permissions_adversarial_<random>`, dropped after) where MySQL
 * takes a database. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { runPermissionsAdversarialBehavior } from "@tests/contracts/public-client/permissions-adversarial-behavior";
import { describe } from "vitest";
import {
  isolatedSchema,
  SQL_SERVER,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const substrate = {
  ...isolatedSchema("viborm_permissions_adversarial"),
  // The estate's policy walks folder trees: SQL Server refuses `recurse`.
  refusesRecursion: true,
};

describeIf("SQL Server Driver", () => {
  runPermissionsAdversarialBehavior({ ...substrate, name: SQL_SERVER });
});
