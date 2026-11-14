/**
 * postgres.js: `groupBy` by a time step on a real PostgreSQL server, every
 * session in America/Los_Angeles, behind UTC where the pg suite's zone is
 * ahead of it.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PostgresDriver } from "@drivers/postgres";
import { runGroupByTimeStepBehavior } from "@tests/contracts/engine/query/groupby-time-step-behavior";
import {
  describeIf,
  dropEveryTable,
  TEST_CONNECTION_STRING,
} from "./postgres-fixtures";

const SESSION_ZONE = "America/Los_Angeles";

describeIf("postgres.js Driver", () => {
  beforeAll(dropEveryTable);
  afterAll(dropEveryTable);

  runGroupByTimeStepBehavior({
    name: "postgres.js",
    sessionZone: SESSION_ZONE,
    createDriver: () =>
      new PostgresDriver({
        databaseUrl: TEST_CONNECTION_STRING,
        options: { connection: { TimeZone: SESSION_ZONE } },
      }),
  });
});
