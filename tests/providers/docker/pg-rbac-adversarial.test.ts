import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { runRbacAdversarialBehavior } from "@tests/contracts/public-client/rbac-adversarial-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const namespace = `viborm_rbac_adversarial_${randomBytes(5).toString("hex")}`;
async function admin(sql: string) {
  const connection = new pg.Client({
    connectionString: TEST_CONNECTION_STRING,
  });
  await connection.connect();
  try {
    await connection.query(sql);
  } finally {
    await connection.end();
  }
}
(TEST_CONNECTION_STRING ? describe : describe.skip)(
  "isolated PostgreSQL schema",
  () => {
    runRbacAdversarialBehavior({
      name: "PostgreSQL",
      createDriver: () =>
        new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace }),
      prepare: async (client) => {
        await admin(`CREATE SCHEMA "${namespace}"`);
        await syncLiveSchema(client);
      },
      release: () => admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`),
    });
  }
);
