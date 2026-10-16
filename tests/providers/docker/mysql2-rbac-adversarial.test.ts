import { randomBytes } from "node:crypto";
import { MySQL2Driver } from "@drivers/mysql2";
import { runRbacAdversarialBehavior } from "@tests/contracts/public-client/rbac-adversarial-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createConnection } from "mysql2/promise";
import { describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const database = `viborm_rbac_adversarial_${randomBytes(5).toString("hex")}`;
function databaseUrl() {
  if (!TEST_CONNECTION_STRING)
    throw new Error("MySQL test connection is not configured");
  const url = new URL(TEST_CONNECTION_STRING);
  url.pathname = `/${database}`;
  return url.toString();
}
async function admin(sql: string) {
  if (!TEST_CONNECTION_STRING)
    throw new Error("MySQL test connection is not configured");
  const connection = await createConnection(TEST_CONNECTION_STRING);
  try {
    await connection.query(sql);
  } finally {
    await connection.end();
  }
}
(TEST_CONNECTION_STRING ? describe : describe.skip)(
  "isolated MySQL database",
  () => {
    runRbacAdversarialBehavior({
      name: "MySQL",
      createDriver: () =>
        new MySQL2Driver({
          databaseUrl: databaseUrl(),
          migrationNamespaceAttestation: "non-redirecting",
        }),
      prepare: async (client) => {
        await admin(`CREATE DATABASE \`${database}\``);
        await syncLiveSchema(client);
      },
      release: () => admin(`DROP DATABASE IF EXISTS \`${database}\``),
    });
  }
);
