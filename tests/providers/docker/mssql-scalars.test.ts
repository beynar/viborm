/**
 * The driver contract suites on SQL Server (scalars). Tables come from the
 * test-only T-SQL push (`tests/fixtures/mssql-schema.ts`): VibORM writes no
 * SQL Server DDL. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { blobFilterContract } from "@tests/contracts/drivers/behaviors/blob-filter-behavior";
import { decimalExactnessContract } from "@tests/contracts/drivers/behaviors/decimal-exactness-behavior";
import { jsonNullSentinelContract } from "@tests/contracts/drivers/behaviors/json-null-sentinel-behavior";
import { likeEscapeContract } from "@tests/contracts/drivers/behaviors/like-escape-behavior";
import { listJsonFilterContract } from "@tests/contracts/drivers/behaviors/list-json-filter-behavior";
import { prismaParityContract } from "@tests/contracts/drivers/behaviors/prisma-parity-behavior";
import {
  fullScalarRoundtripContract,
  scalarRoundtripContract,
} from "@tests/contracts/drivers/behaviors/scalar-roundtrip-behavior";
import { beforeEach, describe } from "vitest";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  beforeEach(dropEveryLiveTable);

  scalarRoundtripContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  fullScalarRoundtripContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  decimalExactnessContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
    descriptor: { precision: 16, scale: 2 },
  });
  jsonNullSentinelContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  likeEscapeContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  listJsonFilterContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  blobFilterContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  prismaParityContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
});
