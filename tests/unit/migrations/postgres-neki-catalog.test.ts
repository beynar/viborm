/**
 * The PostgreSQL catalog reads PlanetScale's Neki must accept, on PGlite: a
 * NULLS NOT DISTINCT unique index is still refused by introspection and
 * abstained on by the digest, now read through `ix.indnullsnotdistinct` where
 * the server has the column and as `false` where it does not (before
 * PostgreSQL 15), never through a whole-row reference.
 * `postgres-neki-catalog.core.test.ts` holds the SQL shapes without a server;
 * `tests/providers/docker/pg-neki-catalog.test.ts` runs these readings on a
 * real PostgreSQL.
 */

import { createClient } from "@drivers/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";
import {
  NULLS_NOT_DISTINCT_INDEX,
  nekiCatalogSchema,
  nullsNotDistinctIndexSql,
  readNullsNotDistinctIndex,
} from "./_neki-catalog";

const database = openTestPGlite();

beforeAll(() => database.waitReady);

describe("a NULLS NOT DISTINCT index read without a whole-row reference", () => {
  it("is refused by introspection, abstained on by the digest, and absent before PostgreSQL 15", async () => {
    await database.exec(`CREATE SCHEMA "neki_nnd"`);
    const orm = createClient({
      client: database,
      schema: nekiCatalogSchema(),
      namespace: "neki_nnd",
    });
    await createMigrationClient(orm).push();
    await database.exec(nullsNotDistinctIndexSql("neki_nnd"));

    const reading = await readNullsNotDistinctIndex(orm);
    expect(reading.refusal).toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      meta: { indexName: NULLS_NOT_DISTINCT_INDEX },
    });
    expect(reading.digest).toBeUndefined();
    expect(reading.legacyIndexes).toContain(NULLS_NOT_DISTINCT_INDEX);
  });
});
