import { PgDriver } from "@drivers/pg";
import { rawIndexContract } from "@tests/contracts/drivers/behaviors/raw-index-behavior";
import { beforeEach, describe } from "vitest";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

describe.skipIf(!TEST_CONNECTION_STRING)("pg", () => {
  beforeEach(dropEveryLiveTable);

  rawIndexContract.register({
    driverName: "pg",
    createDriver: () => new PgDriver({ databaseUrl: TEST_CONNECTION_STRING }),
    push: true,
  });
});
