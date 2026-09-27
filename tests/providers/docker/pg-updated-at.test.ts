/** Native pg proof for the `.updatedAt()` admission contract. */

import { randomUUID } from "node:crypto";
import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { updatedAtCells, updatedAtSchema } from "@tests/fixtures/updated-at";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = `viborm_i54_${process.pid}_${randomUUID().slice(0, 8)}`;

describeIf("pg `.updatedAt()`", () => {
  const admin = new PgDriver({ databaseUrl: TEST_CONNECTION_STRING });
  const driver = new PgDriver({
    databaseUrl: TEST_CONNECTION_STRING,
    namespace: NAMESPACE,
  });
  const client = createClient({ schema: updatedAtSchema, driver });
  let ownsNamespace = false;

  const dropOwnedNamespace = async () => {
    if (!ownsNamespace) return;
    await admin._executeRaw(`DROP SCHEMA "${NAMESPACE}" CASCADE`);
    ownsNamespace = false;
  };

  beforeAll(async () => {
    await admin._executeRaw(`CREATE SCHEMA "${NAMESPACE}"`);
    ownsNamespace = true;
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
      try {
        await dropOwnedNamespace();
      } finally {
        await admin.disconnect();
      }
    }
  });

  updatedAtCells(() => client);
});
