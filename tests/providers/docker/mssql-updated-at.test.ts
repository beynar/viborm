/**
 * SQL Server: the `.updatedAt()` admission contract, on tables the test-only
 * push creates in a schema of its own. Set MSSQL_TEST_CONNECTION_STRING to
 * run.
 */

import { createClient } from "@client/client";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  createUpdatedAtSchema,
  updatedAtCells,
} from "@tests/fixtures/updated-at";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_updated_at";

describeIf("SQL Server `.updatedAt()`", () => {
  const client = createClient({
    schema: createUpdatedAtSchema(),
    driver: createMssqlDriverIn(NAMESPACE),
  });

  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await syncLiveSchema(client);
  });

  beforeEach(async () => {
    await client.log.deleteMany({});
    await client.child.deleteMany({});
    await client.record.deleteMany({});
  });

  afterAll(async () => {
    try {
      await client.$disconnect();
    } finally {
      await dropSchema(NAMESPACE);
    }
  });

  updatedAtCells(() => client);
});
