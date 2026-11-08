import { rawIndexContract } from "@tests/contracts/drivers/behaviors/raw-index-behavior";
import { beforeEach, describe } from "vitest";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

describe.skipIf(!TEST_CONNECTION_STRING)("MySQL2", () => {
  beforeEach(dropEveryLiveTable);

  rawIndexContract.register({
    driverName: "MySQL2",
    createDriver: createMySQL2Driver,
    push: true,
  });
});
