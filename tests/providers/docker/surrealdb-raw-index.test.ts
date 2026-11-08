/**
 * Raw indexes on SurrealDB (gated on SURREAL_TEST_URL): the shared contract,
 * and what introspection makes of an index VibORM did not define — refused in
 * a table it manages, before effects, and left as it was; skipped elsewhere.
 */

import "@migrations/dialects/surrealql";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { getMigrationDriver } from "@migrations/drivers";
import { rawIndexHash } from "@migrations/raw-index";
import { s } from "@schema";
import { rawIndexContract } from "@tests/contracts/drivers/behaviors/raw-index-behavior";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { describe, expect, test } from "vitest";

const HNSW_COSINE = /^HNSW DIMENSION 3 DIST COSINE/;
const HAND_MADE_REFUSAL =
  /surreal_raw_documents\.surreal_raw_hnsw.*\.rawIndex\(\)/;
const HNSW_KIND = /^HNSW/;

const HNSW =
  "DEFINE INDEX {name} ON {table} FIELDS {embedding} HNSW DIMENSION 3 DIST COSINE";
const HAND_MADE =
  "DEFINE INDEX surreal_raw_hnsw ON surreal_raw_documents FIELDS embedding HNSW DIMENSION 3 DIST COSINE;";

/** A driver on a database of its own: a history starts from an empty one. */
function freshDriver(): AnyDriver {
  const driver = createSurrealTestDriver() as never as {
    fresh(): Promise<void>;
  };
  driver.fresh();
  return driver as never;
}

const documents = (raw: boolean, note = false) => {
  const fields = {
    id: s.string().id(),
    embedding: s.vector().dimension(3),
  };
  const model = note
    ? s.model({ ...fields, note: s.string().nullable() })
    : s.model(fields);
  return {
    document: (raw
      ? model.rawIndex("surreal_raw_hnsw", { surrealdb: HNSW })
      : model
    ).map("surreal_raw_documents"),
  };
};

async function tableInfo(driver: AnyDriver, table: string) {
  const { rows } = await driver._executeRaw<{
    indexes: { name: string; index: unknown; comment?: string }[];
    fields: { name: string }[];
  }>(`RETURN [(INFO FOR TABLE ${table} STRUCTURE)]`);
  return rows[0]!;
}

describe.skipIf(!surrealUrl)("SurrealDB raw indexes", () => {
  rawIndexContract.register({
    driverName: "SurrealDB",
    createDriver: freshDriver,
    push: true,
    resetsRenames: false,
  });

  test("a VibORM raw HNSW index is recognized by its marker", async () => {
    const driver = freshDriver();
    const client = createClient({ schema: documents(true), driver });
    try {
      const migrations = createMigrationClient(client);
      await migrations.push();
      await expect(migrations.push()).resolves.toMatchObject({
        outcome: "noop",
      });
      const info = await tableInfo(driver, "surreal_raw_documents");
      const index = info.indexes.find(
        ({ name }) => name === "surreal_raw_hnsw"
      );
      expect(String(index?.index)).toMatch(HNSW_COSINE);
      const live = await getMigrationDriver(driver).introspect(
        (statement, parameters) => driver._executeRaw(statement, parameters)
      );
      expect(
        live.tables.find(({ name }) => name === "surreal_raw_documents")
          ?.indexes
      ).toEqual([
        {
          name: "surreal_raw_hnsw",
          columns: ["embedding"],
          unique: false,
          raw: { hash: rawIndexHash(HNSW) },
        },
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  test("a table renamed as its raw index goes is not re-created with it", async () => {
    const driver = freshDriver();
    const named = (table: string, raw: boolean) => {
      const model = s.model({
        id: s.string().id(),
        embedding: s.vector().dimension(3),
      });
      return {
        document: (raw
          ? model.rawIndex("surreal_raw_hnsw", { surrealdb: HNSW })
          : model
        ).map(table),
      };
    };
    const before = createClient({
      schema: named("surreal_raw_before", true),
      driver,
    });
    const after = createClient({
      schema: named("surreal_raw_after", false),
      driver,
    });
    try {
      await createMigrationClient(before).push();
      // Renaming copies the rows: the push is destructive, and takes consent.
      const resolve = ((change: { type: string; rename?: () => unknown }) =>
        change.type === "ambiguous" ? change.rename?.() : undefined) as never;
      const migrations = createMigrationClient(after);
      const plan = await migrations.push({ dryRun: true, resolve });
      await migrations.push({ consent: plan.consent, resolve });
      const info = await tableInfo(driver, "surreal_raw_after");
      expect(info.indexes.map(({ name }) => name)).not.toContain(
        "surreal_raw_hnsw"
      );
      await expect(createMigrationClient(after).push()).resolves.toMatchObject({
        outcome: "noop",
      });
    } finally {
      await before.$disconnect();
    }
  });

  test("a hand-made HNSW index in a managed table refuses before effects and survives", async () => {
    const driver = freshDriver();
    const client = createClient({ schema: documents(false), driver });
    try {
      await createMigrationClient(client).push();
      await driver._executeRaw(HAND_MADE);

      // The same schema, one column more: nothing of it may run.
      const next = createClient({ schema: documents(false, true), driver });
      await expect(createMigrationClient(next).push()).rejects.toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        message: expect.stringMatching(HAND_MADE_REFUSAL),
      });
      // Declaring it is no adoption: the hand-made copy carries no marker.
      const declared = createClient({ schema: documents(true), driver });
      await expect(
        createMigrationClient(declared).push()
      ).rejects.toMatchObject({ code: VibORMErrorCode.FEATURE_NOT_SUPPORTED });

      const info = await tableInfo(driver, "surreal_raw_documents");
      expect(info.fields.map(({ name }) => name)).not.toContain("note");
      const kept = info.indexes.find(({ name }) => name === "surreal_raw_hnsw");
      expect(String(kept?.index)).toMatch(HNSW_KIND);
      expect(kept?.comment).toBeUndefined();
    } finally {
      await client.$disconnect();
    }
  });

  test("outside the managed tables, such an index is skipped", async () => {
    const driver = freshDriver();
    const client = createClient({
      schema: {
        ...documents(false),
        other: s.model({ id: s.string().id() }).map("surreal_raw_other"),
      },
      driver,
    });
    try {
      await createMigrationClient(client).push();
      await driver._executeRaw(HAND_MADE);
      const scoped = createClient({
        schema: {
          other: s
            .model({ id: s.string().id(), label: s.string().nullable() })
            .map("surreal_raw_other"),
        },
        driver,
      });
      await expect(
        createMigrationClient(scoped, {
          tables: ["surreal_raw_other"],
        }).push()
      ).resolves.toMatchObject({ outcome: "applied" });
    } finally {
      await client.$disconnect();
    }
  });

  test("a comment VibORM did not write on a managed table refuses", async () => {
    const driver = freshDriver();
    const client = createClient({ schema: documents(false), driver });
    try {
      await createMigrationClient(client).push();
      await driver._executeRaw(
        'ALTER TABLE surreal_raw_documents COMMENT "documents, by hand";'
      );
      await expect(createMigrationClient(client).push()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining(
          'table "surreal_raw_documents" carries a comment VibORM did not write'
        ),
      });
    } finally {
      await client.$disconnect();
    }
  });
});
