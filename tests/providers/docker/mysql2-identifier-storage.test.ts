/**
 * MySQL2 Driver Tests — compact identifier storage.
 *
 * The MySQL leg: `BINARY(16)` and `BINARY(20)` in `information_schema`, the
 * payload bytes in the column, and the keyed-TEXT widening that must not reach
 * a binary key.
 */

import { runIdentifierStorageBehavior } from "@tests/contracts/engine/query/identifier-storage-behavior";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 Driver", () => {
  runIdentifierStorageBehavior({
    name: "mysql2",
    dialect: "mysql",
    createDriver: createMySQL2Driver,
  });
});
