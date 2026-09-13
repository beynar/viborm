/**
 * pg Driver Tests — compact identifier storage.
 *
 * The PostgreSQL leg of the one contract that cannot be settled without a
 * database: the column type `information_schema` reports, the bytes a row
 * actually holds, and the order a byte column sorts in.
 */

import { PgDriver } from "@drivers/pg";
import { runIdentifierStorageBehavior } from "@tests/contracts/engine/query/identifier-storage-behavior";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver", () => {
  runIdentifierStorageBehavior({
    name: "pg",
    dialect: "postgresql",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
  });
});
