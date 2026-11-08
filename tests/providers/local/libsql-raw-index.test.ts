import { rawIndexContract } from "@tests/contracts/drivers/behaviors/raw-index-behavior";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";

// LibSQL refuses an effectful live push; a generated history applies.
rawIndexContract.register({
  driverName: "LibSQL",
  createDriver: createInMemoryLibSQLDriver,
  push: false,
});
