/**
 * mysql2 — one schema, a native type per dialect (#45), on a real server.
 *
 * The suite owns one private MySQL database, created before and dropped
 * after, so pushing its two tables plans nothing against any other suite's
 * tables. MySQL selects the maps' `mysql` entries — a `VARCHAR(36)` uuid key
 * (text storage instead of the automatic `BINARY(16)`), a `VARCHAR(40)`
 * handle, `SMALLINT` and `FLOAT` — its automatic `DATETIME(3)` where the map
 * has no `mysql` entry, and its JSON container for the list whatever the
 * member's entry says. The cells are shared with the SQLite3, PGlite and
 * PostgreSQL suites: `tests/fixtures/native-type-map.ts`.
 *
 * Requires the Docker test database:
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import {
  nativeTypeMapCells,
  nativeTypeMapSchema,
} from "@tests/fixtures/native-type-map";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe } from "vitest";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const DATABASE = "viborm_native_type_map";

function databaseUrl(): string {
  const url = new URL(TEST_CONNECTION_STRING ?? "mysql://localhost/");
  url.pathname = `/${DATABASE}`;
  return url.toString();
}

describeIf("mysql2 native type per dialect", () => {
  const admin = createMySQL2Driver();
  const driver = new MySQL2Driver({
    databaseUrl: databaseUrl(),
    migrationNamespaceAttestation: "non-redirecting",
  });
  const client = createClient({ schema: nativeTypeMapSchema, driver });

  beforeAll(async () => {
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await admin._executeRaw(`CREATE DATABASE \`${DATABASE}\``);
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await client.$disconnect();
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await admin.disconnect();
  });

  nativeTypeMapCells({
    dialect: "mysql",
    client: () => client,
    clientFor: (schema) => createClient({ schema, driver }),
    reset: async () => {
      await client.pet.deleteMany({});
      await client.owner.deleteMany({});
    },
    expectedCatalog: {
      owners: {
        id: "varchar(36)",
        handle: "varchar(40)",
        score: "smallint",
        ratio: "float",
        seenAt: "datetime(3)",
        tags: "json",
      },
      pets: { id: "varchar(191)", name: "text", ownerId: "varchar(36)" },
    },
    raw: { id: "text", seenAt: "provider" },
  });
});
