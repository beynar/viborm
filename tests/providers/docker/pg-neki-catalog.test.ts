/**
 * The PostgreSQL catalog reads PlanetScale's Neki must accept, on a real
 * PostgreSQL server: a NULLS NOT DISTINCT unique index is refused by
 * introspection and abstained on by the digest, read through
 * `ix.indnullsnotdistinct` (never a whole-row reference), and the read built
 * for a server before PostgreSQL 15 runs without naming the column. PGlite
 * runs the same readings in `tests/unit/migrations/postgres-neki-catalog.test.ts`.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { createClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import {
  NULLS_NOT_DISTINCT_INDEX,
  nekiCatalogSchema,
  nullsNotDistinctIndexSql,
  readNullsNotDistinctIndex,
} from "@tests/unit/migrations/_neki-catalog";
import pg from "pg";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_neki_nnd";

describeIf("pg catalog reads Neki accepts", () => {
  const admin = new pg.Client({ connectionString: TEST_CONNECTION_STRING });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${NAMESPACE}"`);
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await admin.end();
  });

  it("refuses a NULLS NOT DISTINCT index, abstains in the digest, and reads it as before PostgreSQL 15", async () => {
    const orm = createClient({
      schema: nekiCatalogSchema(),
      databaseUrl: TEST_CONNECTION_STRING,
      namespace: NAMESPACE,
      options: { max: 1 },
    });
    try {
      await createMigrationClient(orm).push();
      await admin.query(nullsNotDistinctIndexSql(NAMESPACE));

      const reading = await readNullsNotDistinctIndex(orm);
      expect(reading.refusal).toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        meta: { indexName: NULLS_NOT_DISTINCT_INDEX },
      });
      expect(reading.digest).toBeUndefined();
      expect(reading.legacyIndexes).toContain(NULLS_NOT_DISTINCT_INDEX);
    } finally {
      await orm.$disconnect();
    }
  });
});
