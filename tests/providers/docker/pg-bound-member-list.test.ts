/**
 * pg Driver Tests — a scalar list bound as one parameter (engine-09) on a
 * server PostgreSQL, where node-postgres sends the list untyped and the server
 * gives it the compared column's array type.
 */

import { PgDriver } from "@drivers/pg";
import { runBoundMemberListBehavior } from "@tests/contracts/engine/query/bound-member-list-behavior";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  runBoundMemberListBehavior({
    name: "pg",
    dialect: "postgresql",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
