import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { CommittedBatchNotification } from "@src/drivers/types";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { junctionSkipAdoptSchema } from "@tests/contracts/engine/write/junction-skip-adoption-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

hydrateSchemaNames(junctionSkipAdoptSchema);

/** Count submitted work on both weak and acknowledged batch substrates. */
class CountingBatchOnlyPGlite extends BatchOnlyPGliteDriver {
  statements = 0;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.statements += queries.length;
    return await super.executeBatch<T>(client, queries);
  }
}

/** The exact capability D1 declares: batch-only, plus ordered committed segments. */
class CountingProgressivePGlite extends CountingBatchOnlyPGlite {
  override readonly supportsOrderedCommittedSegments = true;
  afterCommittedBatch: (() => Promise<void>) | undefined;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const results = await super.executeBatch<T>(client, queries);
    await committed?.();
    const hook = this.afterCommittedBatch;
    if (hook) {
      this.afterCommittedBatch = undefined;
      await hook();
    }
    return results;
  }
}

class ProgressiveSQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override readonly supportsOrderedCommittedSegments = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const results = await this.transaction(client, async (transaction) => {
      const batchResults: QueryResult<T>[] = [];
      for (const query of queries) {
        const statement = transaction.prepare<unknown[], T>(query.sql);
        const params = query.params ?? [];
        if (statement.reader) {
          statement.safeIntegers(true);
          const rows = statement.all(...params);
          batchResults.push({ rows, rowCount: rows.length });
        } else {
          const result = statement.run(...params);
          batchResults.push({
            rows: [],
            rowCount: result.changes,
            insertId: result.lastInsertRowid,
          });
        }
      }
      return batchResults;
    });
    await committed?.();
    return results;
  }
}

const rootFirstSuppression = () => ({
  where: { id: "v1" },
  data: {
    gems: {
      createMany: {
        data: [
          {
            tag: "taken",
            text: "OVERWRITTEN",
            facets: { create: [{ slug: "ghost" }] },
          },
          {
            tag: "kept",
            text: "fresh",
            facets: { create: [{ slug: "real" }] },
          },
        ],
        skipDuplicates: true,
      },
    },
  },
});

describe("root-first junction suppression on batch-only substrates", () => {
  const construct = (
    driver: CountingBatchOnlyPGlite,
    args: ReturnType<typeof rootFirstSuppression>
  ) => {
    const schemas = createSchemaRegistry(junctionSkipAdoptSchema);
    const engine = new QueryEngine(
      driver,
      createModelRegistry(junctionSkipAdoptSchema, schemas)
    );
    return () =>
      new UpdateOperation(engine, junctionSkipAdoptSchema.vault, args);
  };

  const substrates: readonly [
    string,
    (database: PGlite) => CountingBatchOnlyPGlite,
  ][] = [
    [
      "a capability-false batch driver",
      (database) => new CountingBatchOnlyPGlite({ client: database }),
    ],
    [
      "an ordered committed-segment driver",
      (database) => new CountingProgressivePGlite({ client: database }),
    ],
  ];

  for (const [substrate, createDriver] of substrates) {
    test(`${substrate} suppresses only the duplicate root and lands its sibling`, async () => {
      const database = new PGlite();
      const state = createClient({
        schema: junctionSkipAdoptSchema,
        driver: new PGliteDriver({ client: database }),
      });
      await push(state, { force: true });
      await state.gem.create({ data: { tag: "taken", text: "ORIGINAL" } });
      await state.vault.create({ data: { id: "v1" } });

      const driver = createDriver(database);
      const client = createClient({ schema: junctionSkipAdoptSchema, driver });
      expect(construct(driver, rootFirstSuppression())).not.toThrow();
      await client.vault.update(rootFirstSuppression());

      expect(driver.statements).toBeGreaterThan(0);
      await expect(
        state.gem.findMany({
          orderBy: { tag: "asc" },
          select: { tag: true, text: true },
        })
      ).resolves.toEqual([
        { tag: "kept", text: "fresh" },
        { tag: "taken", text: "ORIGINAL" },
      ]);
      await expect(
        state.facet.findMany({
          orderBy: { slug: "asc" },
          select: { slug: true },
        })
      ).resolves.toEqual([{ slug: "real" }]);
      const linked = await state.gem.findMany({
        where: { vaults: { some: { id: "v1" } } },
        select: { tag: true },
      });
      expect(linked.map((row) => row.tag)).toEqual(["kept"]);
      await state.$disconnect();
    }, 60_000);
  }
});

const progressiveSkipSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      marker: s.string(),
      buckets: s.oneToMany(() => bucket),
    })
    .map("f2_owners");
  const bucket = s
    .model({
      id: s.string().id(),
      label: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
      gems: s.manyToMany(() => gem).through("f2_bucket_gem"),
      boards: s.manyToMany(() => board).through("f2_board_bucket"),
    })
    .map("f2_buckets");
  const gem = s
    .model({
      id: s.int().id().increment(),
      tag: s.string(),
      buckets: s.manyToMany(() => bucket).through("f2_bucket_gem"),
    })
    .index(["tag"], { unique: true, name: "f2_gems_tag_uq" })
    .map("f2_gems");
  const board = s
    .model({
      id: s.string().id(),
      marker: s.string(),
      buckets: s.manyToMany(() => bucket).through("f2_board_bucket"),
    })
    .map("f2_boards");
  return { board, bucket, gem, owner };
})();

describe("nested root-first suppression keeps each progressive guard exact", () => {
  test("an outer scalar prefix and nested updateMany both land", async () => {
    const database = new PGlite();
    const state = createClient({
      schema: progressiveSkipSchema,
      driver: new PGliteDriver({ client: database }),
    });
    await push(state, { force: true });
    await state.owner.create({ data: { id: "o1", marker: "before" } });
    await state.bucket.create({
      data: { id: "b1", label: "before", ownerId: "o1" },
    });
    await state.gem.create({ data: { tag: "taken" } });

    const driver = new CountingProgressivePGlite({ client: database });
    const client = createClient({
      schema: progressiveSkipSchema,
      driver,
    });
    driver.statements = 0;
    await client.owner.update({
      where: { id: "o1" },
      data: {
        marker: "after",
        buckets: {
          updateMany: {
            where: {},
            data: {
              label: "after",
              gems: {
                createMany: {
                  data: [{ tag: "taken" }],
                  skipDuplicates: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      state.owner.findUnique({ where: { id: "o1" } })
    ).resolves.toMatchObject({
      marker: "after",
    });
    await expect(
      state.bucket.findUnique({ where: { id: "b1" } })
    ).resolves.toMatchObject({
      label: "after",
    });
    await expect(
      state.gem.findMany({ select: { tag: true } })
    ).resolves.toEqual([{ tag: "taken" }]);
    await expect(
      state.gem.findMany({
        where: { buckets: { some: { id: "b1" } } },
      })
    ).resolves.toEqual([]);
    expect(driver.statements).toBeGreaterThan(0);
    await state.$disconnect();
  }, 60_000);

  test("junction updateMany lands its prefix without linking the skipped root", async () => {
    const database = new PGlite();
    const state = createClient({
      schema: progressiveSkipSchema,
      driver: new PGliteDriver({ client: database }),
    });
    await push(state, { force: true });
    await state.bucket.create({ data: { id: "b1", label: "before" } });
    await state.board.create({
      data: {
        id: "board-1",
        marker: "before",
        buckets: { connect: { id: "b1" } },
      },
    });
    await state.gem.create({ data: { tag: "taken" } });

    const driver = new CountingProgressivePGlite({ client: database });
    const client = createClient({
      schema: progressiveSkipSchema,
      driver,
    });
    driver.statements = 0;
    await client.board.update({
      where: { id: "board-1" },
      data: {
        marker: "after",
        buckets: {
          updateMany: {
            where: {},
            data: {
              label: "after",
              gems: {
                createMany: {
                  data: [{ tag: "taken" }],
                  skipDuplicates: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      state.board.findUnique({ where: { id: "board-1" } })
    ).resolves.toMatchObject({ marker: "after" });
    await expect(
      state.bucket.findUnique({ where: { id: "b1" } })
    ).resolves.toMatchObject({ label: "after" });
    await expect(
      state.gem.findMany({ select: { tag: true } })
    ).resolves.toEqual([{ tag: "taken" }]);
    await expect(
      state.gem.findMany({
        where: { buckets: { some: { id: "b1" } } },
      })
    ).resolves.toEqual([]);
    expect(driver.statements).toBeGreaterThan(0);
    await state.$disconnect();
  }, 60_000);
});

function alternatingDefaultSkipSchema(replay: { complete: boolean }) {
  const owner = s
    .model({
      id: s.string().id(),
      marker: s.string(),
      buckets: s.oneToMany(() => bucket),
    })
    .map("f2_alt_owners");
  const bucket = s
    .model({
      id: s.string().id(),
      ownerId: s.string().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
      gems: s.manyToMany(() => gem).through("f2_alt_bucket_gem"),
    })
    .map("f2_alt_buckets");
  const gem = s
    .model({
      id: s.int().id().increment(),
      stable: s.string().unique(),
      slug: s
        .string()
        .nullable()
        .default(() => (replay.complete ? "dynamic" : null))
        .unique(),
      buckets: s.manyToMany(() => bucket).through("f2_alt_bucket_gem"),
    })
    .map("f2_alt_gems");
  return { bucket, gem, owner };
}

describe("replayable defaults are evaluated for each selected member", () => {
  test("a default is reparsed after the committed prefix", async () => {
    const replay = { complete: false };
    const schema = alternatingDefaultSkipSchema(replay);
    const database = new PGlite();
    const state = createClient({
      schema,
      driver: new PGliteDriver({ client: database }),
    });
    await push(state, { force: true });
    await state.owner.create({ data: { id: "o1", marker: "before" } });
    await state.bucket.create({ data: { id: "b1", ownerId: "o1" } });

    const driver = new CountingProgressivePGlite({ client: database });
    const client = createClient({ schema, driver });
    driver.afterCommittedBatch = async () => {
      replay.complete = true;
    };
    await client.owner.update({
      where: { id: "o1" },
      data: {
        marker: "after",
        buckets: {
          updateMany: {
            where: {},
            data: {
              gems: {
                createMany: {
                  data: [{ stable: "S" }],
                  skipDuplicates: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      state.owner.findUnique({ where: { id: "o1" } })
    ).resolves.toMatchObject({ marker: "after" });
    expect(replay.complete).toBe(true);
    await expect(
      state.gem.findMany({ select: { stable: true, slug: true } })
    ).resolves.toEqual([{ stable: "S", slug: "dynamic" }]);
    await expect(
      state.gem.findMany({
        where: { buckets: { some: { id: "b1" } } },
        select: { stable: true },
      })
    ).resolves.toEqual([{ stable: "S" }]);
    await state.$disconnect();
  }, 60_000);
});

const vacuousProgressiveSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      targets: s.manyToMany(() => target).through("f3_owner_target"),
    })
    .map("f3_owners");
  const target = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      owners: s.manyToMany(() => owner).through("f3_owner_target"),
      details: s.oneToMany(() => detail),
    })
    .map("f3_targets");
  const detail = s
    .model({
      id: s.string().id(),
      body: s.string(),
      targetId: s.int().nullable(),
      target: s
        .manyToOne(() => target)
        .fields("targetId")
        .references("id")
        .optional(),
    })
    .map("f3_details");
  return { detail, owner, target };
})();

describe("residual F3 — a vacuous relation-bearing skip drops the flag", () => {
  test("the unchanged relation series runs on ordered committed segments", async () => {
    const driver = new ProgressiveSQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({
      schema: vacuousProgressiveSchema,
      driver,
    });
    await push(client, { force: true });
    await client.owner.create({ data: { id: "o1" } });

    await client.owner.update({
      where: { id: "o1" },
      data: {
        targets: {
          createMany: {
            data: [
              {
                label: "one",
                details: { create: { id: "d1", body: "child" } },
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    await expect(
      client.target.findMany({
        where: { owners: { some: { id: "o1" } } },
        select: { label: true },
      })
    ).resolves.toEqual([{ label: "one" }]);
    await expect(
      client.detail.findMany({ select: { body: true } })
    ).resolves.toEqual([{ body: "child" }]);
    await client.$disconnect();
  }, 60_000);
});
