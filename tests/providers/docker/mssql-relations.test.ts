/**
 * The driver contract suites on SQL Server (relations). Tables come from the
 * test-only T-SQL push (`tests/fixtures/mssql-schema.ts`): VibORM writes no
 * SQL Server DDL. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { compoundJunctionContract } from "@tests/contracts/drivers/behaviors/compound-junction-behavior";
import { compoundKeyContract } from "@tests/contracts/drivers/behaviors/compound-key-behavior";
import { forwardFkOrderingContract } from "@tests/contracts/drivers/behaviors/forward-fk-ordering-behavior";
import { manyToManyContract } from "@tests/contracts/drivers/behaviors/many-to-many-behavior";
import { orderingArrayCreateContract } from "@tests/contracts/drivers/behaviors/ordering-array-create-behavior";
import { polymorphicCollectionReadContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-read-behavior";
import { polymorphicCollectionWriteContract } from "@tests/contracts/drivers/behaviors/polymorphic-collection-write-behavior";
import { polymorphicMemberJunctionContract } from "@tests/contracts/drivers/behaviors/polymorphic-member-junction-behavior";
import { polymorphicRelationContract } from "@tests/contracts/drivers/behaviors/polymorphic-relation-behavior";
import { beforeEach, describe } from "vitest";
import {
  createMssqlDriver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("SQL Server Driver", () => {
  beforeEach(dropEveryLiveTable);

  compoundKeyContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  compoundJunctionContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  manyToManyContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  forwardFkOrderingContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  polymorphicRelationContract.register({
    name: "SQL Server",
    createDriver: createMssqlDriver,
  });
  polymorphicCollectionReadContract.register({
    name: "SQL Server",
    createDriver: createMssqlDriver,
  });
  polymorphicCollectionWriteContract.register({
    name: "SQL Server",
    createDriver: createMssqlDriver,
  });
  polymorphicMemberJunctionContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
  orderingArrayCreateContract.register({
    driverName: "SQL Server",
    createDriver: createMssqlDriver,
  });
});
