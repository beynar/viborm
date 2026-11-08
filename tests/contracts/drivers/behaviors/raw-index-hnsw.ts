import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { CONTROL_TABLES } from "@migrations/control";
import { getMigrationDriver } from "@migrations/drivers";
import { postgresCatalogDigest } from "@migrations/drivers/postgres/catalog-digest";
import { fingerprintLive } from "@migrations/push-fingerprint";
import { introspectManaged } from "@migrations/push-plan";
import { rawIndexHash } from "@migrations/raw-index";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const HNSW =
  "CREATE INDEX {name} ON {table} USING hnsw ({embedding} vector_cosine_ops)";

const schema = () => ({
  document: s
    .model({ id: s.string().id(), embedding: s.vector().dimension(3) })
    .rawIndex("raw_hnsw_documents_embedding", { pg: HNSW })
    .map("raw_hnsw_documents"),
});

export interface RawIndexHnswOptions {
  readonly driverName: string;
  /** A PostgreSQL driver with pgvector, on an empty database. */
  readonly createDriver: () => AnyDriver;
}

/**
 * A pgvector HNSW index, which no index declaration can say: a raw index
 * creates it and recognizes it again, the catalog digest projects it, and the
 * same index made by hand still refuses before effects, naming `.rawIndex()`.
 */
export function runRawIndexHnswBehavior({
  driverName,
  createDriver,
}: RawIndexHnswOptions): void {
  describe(`${driverName} raw HNSW index`, () => {
    test("is created, recognized, digested and verified", async () => {
      const driver = createDriver();
      await driver._executeRaw("CREATE EXTENSION IF NOT EXISTS vector");
      const client = createClient({ schema: schema(), driver });
      try {
        const migrations = createMigrationClient(client, {
          storage: new MemoryEstateStorage(),
        });
        await migrations.generate({ name: "hnsw" });
        await expect(migrations.apply()).resolves.toMatchObject({
          outcome: "applied",
        });
        await expect(migrations.verify()).resolves.toEqual({ ok: true });
        await expect(migrations.push()).resolves.toMatchObject({
          outcome: "noop",
        });
        const command = getMigrationDriver(driver);
        const live = await introspectManaged(driver, command);
        expect(
          live.tables.find(({ name }) => name === "raw_hnsw_documents")?.indexes
        ).toEqual([
          {
            name: "raw_hnsw_documents_embedding",
            columns: ["embedding"],
            unique: false,
            raw: { hash: rawIndexHash(HNSW) },
          },
        ]);
        const methods = await driver._executeRaw<{ method: string }>(
          "SELECT am.amname AS method FROM pg_class i JOIN pg_am am ON am.oid = i.relam WHERE i.relname = 'raw_hnsw_documents_embedding'"
        );
        expect(methods.rows).toEqual([{ method: "hnsw" }]);
        // The one-statement digest projects it rather than abstain.
        await expect(
          postgresCatalogDigest(driver, command, CONTROL_TABLES)
        ).resolves.toBe(await fingerprintLive(live, command, driver));
      } finally {
        await client.$disconnect();
      }
    });

    test("made by hand, it refuses before effects and survives", async () => {
      const driver = createDriver();
      await driver._executeRaw("CREATE EXTENSION IF NOT EXISTS vector");
      const plain = createClient({
        schema: {
          document: s
            .model({ id: s.string().id(), embedding: s.vector().dimension(3) })
            .map("raw_hnsw_documents"),
        },
        driver,
      });
      try {
        await createMigrationClient(plain).push();
        await driver._executeRaw(
          'CREATE INDEX "raw_hnsw_documents_embedding" ON "raw_hnsw_documents" USING hnsw ("embedding" vector_cosine_ops)'
        );
        await expect(
          createMigrationClient(
            createClient({ schema: schema(), driver })
          ).push()
        ).rejects.toMatchObject({
          code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
          message: expect.stringContaining(".rawIndex()"),
        });
        const kept = await driver._executeRaw<{ comment: string | null }>(
          "SELECT obj_description('raw_hnsw_documents_embedding'::regclass, 'pg_class') AS comment"
        );
        expect(kept.rows).toEqual([{ comment: null }]);
      } finally {
        await plain.$disconnect();
      }
    });
  });
}
