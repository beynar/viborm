/**
 * pg — one schema, a native type per dialect (#45), on a real server.
 *
 * The suite owns one private PostgreSQL schema (namespace), created before and
 * dropped after, so pushing its two tables plans nothing against any other
 * suite's tables. The cells are shared with the SQLite3, PGlite and MySQL
 * suites: `tests/fixtures/native-type-map.ts`.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import {
  nativeTypeMapCells,
  nativeTypeMapSchema,
} from "@tests/fixtures/native-type-map";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const NAMESPACE = "viborm_native_type_map";

describeIf("pg native type per dialect", () => {
  const admin = new PgDriver({ databaseUrl: TEST_CONNECTION_STRING });
  const driver = new PgDriver({
    databaseUrl: TEST_CONNECTION_STRING,
    namespace: NAMESPACE,
  });
  const client = createClient({ schema: nativeTypeMapSchema, driver });

  beforeAll(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin._executeRaw(`CREATE SCHEMA "${NAMESPACE}"`);
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await client.$disconnect();
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin.disconnect();
  });

  nativeTypeMapCells({
    dialect: "pg",
    namespace: () => NAMESPACE,
    client: () => client,
    clientFor: (schema) => createClient({ schema, driver }),
    reset: async () => {
      await client.pet.deleteMany({});
      await client.owner.deleteMany({});
    },
    expectedCatalog: {
      owners: {
        id: "bytea",
        handle: "character varying(40)",
        score: "smallint",
        ratio: "real",
        seenAt: "timestamp(3) with time zone",
        tags: "text[]",
      },
      pets: { id: "text", name: "text", ownerId: "bytea" },
    },
    raw: { id: "bytes", seenAt: "provider" },
  });
});
