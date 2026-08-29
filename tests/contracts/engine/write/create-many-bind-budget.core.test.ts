import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryError, UnsupportedOperationError } from "@errors";

import { buildCreateManyPlan } from "@query-engine/operations/create";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import type { CommittedBatchNotification } from "@src/drivers/types";
import { createQueryScope } from "@src/query-engine/context/query-scope";
import { CreateManyOperation } from "@src/query-engine/write-engine/CreateManyOperation";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import type Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const entry = s
  .model({
    tenantId: s.string(),
    slot: s.string(),
    label: s.string(),
  })
  .id(["tenantId", "slot"])
  .map("create_many_bind_entries");
const collection = s
  .model({
    id: s.string().id(),
    tags: s.toMany(() => tag).through("create_many_bind_collection_tags"),
  })
  .map("create_many_bind_collections");
const tag = s
  .model({
    id: s.string().id(),
    // ONE endpoint owns every junction override (§4.4, R011).
    collections: s.toMany(() => collection),
  })
  .map("create_many_bind_tags");
const schema = { entry, collection, tag };

const compoundSchema = (() => {
  const parent = s
    .model({
      region: s.string(),
      code: s.string(),
      children: s.toMany(() => child),
    })
    .id(["region", "code"])
    .map("create_many_bind_parents");
  const child = s
    .model({
      id: s.string().id(),
      parentRegion: s.string(),
      parentCode: s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentRegion", "parentCode")
        .references("region", "code"),
    })
    .map("create_many_bind_children");
  return { parent, child };
})();

const scratchSchema = (() => {
  const parent = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      children: s.toMany(() => child),
    })
    .map("bind_scratch_parents");
  const child = s
    .model({
      id: s.int().id().increment(),
      parentId: s.int(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id"),
    })
    .map("bind_scratch_children");
  return { parent, child };
})();

hydrateSchemaNames(schema);
hydrateSchemaNames(compoundSchema);
hydrateSchemaNames(scratchSchema);

class CapacityDriver extends PGliteDriver {
  override readonly maxBindParametersPerStatement: number | undefined;

  constructor(
    capacity: number | undefined,
    options: ConstructorParameters<typeof PGliteDriver>[0] = {}
  ) {
    super(options);
    this.maxBindParametersPerStatement = capacity;
  }
}

class CapacitySQLite3Driver extends SQLite3Driver {
  override readonly maxBindParametersPerStatement: number | undefined;

  constructor(capacity: number | undefined) {
    super();
    this.maxBindParametersPerStatement = capacity;
  }
}

class BatchOnlyCapacityDriver extends CapacityDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

class BatchOnlyCapacitySQLite3Driver extends CapacitySQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

class UnknownCapacityProgressiveSQLite3Driver extends CapacitySQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override readonly supportsOrderedCommittedSegments = true;

  constructor() {
    super(undefined);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const results = await this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries, context)
    );
    await committed?.();
    return results;
  }
}

function engine(capacity: number | undefined): QueryEngine {
  return new QueryEngine(
    new CapacityDriver(capacity),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function statementsFromOperation(
  capacity: number | undefined,
  data: readonly Record<string, unknown>[]
) {
  const operation = new CreateManyOperation(engine(capacity), entry, { data });
  return operation.compile({}).steps.map((step) => {
    if (step.kind !== "write") throw new Error("expected a write step");
    return step.statement;
  });
}

describe("createMany bind-budget chunking", () => {
  const getFamily = usePGliteSchemaFamily(schema);

  test("the root operation passes its verified driver budget to the semantic builder", () => {
    const statements = statementsFromOperation(
      6,
      Array.from({ length: 5 }, (_, index) => ({
        tenantId: "tenant",
        slot: `slot-${index}`,
        label: `label-${index}`,
      }))
    );

    expect(statements).toHaveLength(3);
    expect(statements.map((statement) => statement.values.length)).toEqual([
      6, 6, 3,
    ]);
    expect(statements.flatMap((statement) => statement.values)).toEqual([
      "tenant",
      "slot-0",
      "label-0",
      "tenant",
      "slot-1",
      "label-1",
      "tenant",
      "slot-2",
      "label-2",
      "tenant",
      "slot-3",
      "label-3",
      "tenant",
      "slot-4",
      "label-4",
    ]);
  });

  test("budgets the compiled SQL values and chooses the largest fitting prefix", () => {
    const queryEngine = engine(5);
    const ctx = createQueryScope(queryEngine, entry);
    const plan = buildCreateManyPlan(
      ctx,
      {
        data: [
          {
            tenantId: sql`coalesce(${"tenant-0"}, ${"fallback"})`,
            slot: "slot-0",
            label: "label-0",
          },
          { tenantId: "tenant-1", slot: "slot-1", label: "label-1" },
          { tenantId: "tenant-2", slot: "slot-2", label: "label-2" },
        ],
      },
      false,
      undefined,
      queryEngine.maxBindParametersPerStatement
    );

    expect(plan.statements.map((statement) => statement.inputIndexes)).toEqual([
      [0],
      [1],
      [2],
    ]);
    expect(
      plan.statements.map((statement) => statement.sql.values.length)
    ).toEqual([4, 3, 3]);
  });

  test("keeps an under-budget run as one statement", () => {
    const statements = statementsFromOperation(6, [
      { tenantId: "t1", slot: "s1", label: "one" },
      { tenantId: "t2", slot: "s2", label: "two" },
    ]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toEqual([
      "t1",
      "s1",
      "one",
      "t2",
      "s2",
      "two",
    ]);
  });

  test("an unknown provider capacity preserves the maximal same-shape run", () => {
    const statements = statementsFromOperation(undefined, [
      { tenantId: "t1", slot: "s1", label: "one" },
      { tenantId: "t2", slot: "s2", label: "two" },
      { tenantId: "t3", slot: "s3", label: "three" },
    ]);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toHaveLength(9);
  });

  test("compound tuples and input ordinals stay whole across a chunk boundary", () => {
    const queryEngine = engine(4);
    const plan = buildCreateManyPlan(
      createQueryScope(queryEngine, entry),
      {
        data: [
          { tenantId: "t1", slot: "s1" },
          { tenantId: "t2", slot: "s2" },
          { tenantId: "t3", slot: "s3" },
        ],
      },
      false,
      undefined,
      queryEngine.maxBindParametersPerStatement
    );

    expect(plan.statements.map((statement) => statement.inputIndexes)).toEqual([
      [0, 1],
      [2],
    ]);
    expect(plan.statements.map((statement) => statement.sql.values)).toEqual([
      ["t1", "s1", "t2", "s2"],
      ["t3", "s3"],
    ]);
  });

  test("a nested createMany keeps both compound foreign-key members in every chunk", () => {
    const queryEngine = new QueryEngine(
      new CapacitySQLite3Driver(6),
      createModelRegistry(compoundSchema, createSchemaRegistry(compoundSchema))
    );
    const operation = constructRoutedOperation(
      queryEngine,
      compoundSchema.parent,
      "create",
      {
        data: {
          region: "eu",
          code: "central",
          children: {
            createMany: {
              data: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
            },
          },
        },
      }
    );
    if (!(operation && "compile" in operation)) {
      throw new Error("expected one ordinary routed create operation");
    }
    const childWrites = operation
      .compile({})
      .steps.filter(
        (step) => step.kind === "write" && step.id.includes("createMany")
      );

    expect(childWrites).toHaveLength(2);
    expect(
      childWrites.map((step) => {
        if (step.kind !== "write") throw new Error("expected a write step");
        return step.statement.values;
      })
    ).toEqual([
      ["c1", "eu", "central", "c2", "eu", "central"],
      ["c3", "eu", "central"],
    ]);
  });

  test("an indivisible over-budget row stays one statement for final enforcement", () => {
    const queryEngine = engine(2);
    const plan = buildCreateManyPlan(
      createQueryScope(queryEngine, entry),
      { data: [{ tenantId: "t1", slot: "s1", label: "one" }] },
      false,
      undefined,
      queryEngine.maxBindParametersPerStatement
    );

    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]?.inputIndexes).toEqual([0]);
    expect(plan.statements[0]?.sql.values).toHaveLength(3);
  });

  test("an indivisible over-budget row refuses before driver I/O", async () => {
    const driver = new CapacityDriver(2);
    const execute = vi.spyOn(driver, "_execute");
    const client = createClient({ schema, driver });

    await expect(
      client.entry.createMany({
        data: [{ tenantId: "t1", slot: "s1", label: "one" }],
      })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(execute).not.toHaveBeenCalled();
  });

  test("an explicit transaction array refuses an oversized member before batch I/O", async () => {
    const driver = new BatchOnlyCapacityDriver(2);
    const executeBatch = vi.spyOn(driver, "_executeBatch");
    const client = createClient({ schema, driver });

    await expect(
      client.$transaction([
        client.entry.createMany({
          data: [{ tenantId: "t1", slot: "s1", label: "one" }],
        }),
        client.tag.create({ data: { id: "sibling" } }),
      ])
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(executeBatch).not.toHaveBeenCalled();
  });

  test("adapter-owned insert-id scratch cannot exceed the active driver budget", async () => {
    const driver = new BatchOnlyCapacitySQLite3Driver(1);
    const executeBatch = vi.spyOn(driver, "_executeBatch");
    const client = createClient({ schema: scratchSchema, driver });

    await expect(
      client.parent.create({
        data: { label: "root", children: { create: {} } },
      })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(executeBatch).not.toHaveBeenCalled();
  });

  test("an unknown provider budget preserves exact progress before a later native capacity failure", async () => {
    const driver = new UnknownCapacityProgressiveSQLite3Driver();
    const client = createClient({ schema: scratchSchema, driver });
    const oversizedChildren = Array.from({ length: 32_767 }, () => ({}));

    try {
      await syncLiveSchema(client);
      expect(driver.maxBindParametersPerStatement).toBeUndefined();

      const failure = await client.parent
        .createMany({
          data: [
            {
              id: 1,
              label: "committed prefix",
              children: { create: {} },
            },
            {
              id: 2,
              label: "native capacity failure",
              children: { createMany: { data: oversizedChildren } },
            },
          ],
        })
        .catch((error) => error);

      expect(failure).toBeInstanceOf(QueryError);
      expect(failure).toMatchObject({
        meta: {
          driver: "sqlite3",
          recordSeriesProgress: {
            atomicity: "segment",
            phase: "member",
            committedSegments: 1,
            completedMembers: 1,
            committedWriteMembers: 1,
            memberPath: [1],
            totalMembers: 2,
          },
        },
      });
      await expect(
        client.parent.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([{ id: 1, label: "committed prefix" }]);
      await expect(client.child.findMany()).resolves.toEqual([
        { id: 1, parentId: 1 },
      ]);
    } finally {
      await client.$disconnect();
    }
  }, 60_000);

  test("a chunked junction set keeps its clear and every insert in one atomic unit", async () => {
    const family = getFamily();
    const client = createClient({
      schema,
      driver: new CapacityDriver(6, { client: family.database }),
    });
    const oldTags = [{ id: "old-0" }, { id: "old-1" }];
    const newTags = Array.from({ length: 5 }, (_, index) => ({
      id: `new-${index}`,
    }));
    const membership = () =>
      client.tag.findMany({
        where: { collections: { some: { id: "set-owner" } } },
        orderBy: { id: "asc" },
        select: { id: true },
      });

    await client.tag.createMany({ data: [...oldTags, ...newTags] });
    await client.collection.create({
      data: { id: "set-owner", tags: { connect: oldTags } },
    });
    await family.client.$executeRawUnsafe(
      'CREATE TABLE "create_many_bind_set_fires" ("id" SERIAL PRIMARY KEY)'
    );
    await family.client.$executeRawUnsafe(
      'CREATE OR REPLACE FUNCTION viborm_create_many_bind_set_fire() RETURNS trigger AS $$ BEGIN INSERT INTO "create_many_bind_set_fires" DEFAULT VALUES; RETURN NULL; END; $$ LANGUAGE plpgsql'
    );
    await family.client.$executeRawUnsafe(
      'CREATE TRIGGER "create_many_bind_set_statement" AFTER INSERT ON "create_many_bind_collection_tags" FOR EACH STATEMENT EXECUTE FUNCTION viborm_create_many_bind_set_fire()'
    );
    await family.client.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION viborm_create_many_bind_set_fail() RETURNS trigger AS $$ BEGIN IF NEW.\"tagId\" = 'new-4' THEN RAISE EXCEPTION 'late set chunk'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql"
    );
    await family.client.$executeRawUnsafe(
      'CREATE TRIGGER "create_many_bind_set_failure" BEFORE INSERT ON "create_many_bind_collection_tags" FOR EACH ROW EXECUTE FUNCTION viborm_create_many_bind_set_fail()'
    );

    try {
      await expect(
        client.collection.update({
          where: { id: "set-owner" },
          data: { tags: { set: newTags } },
        })
      ).rejects.toBeInstanceOf(QueryError);
      await expect(membership()).resolves.toEqual(oldTags);
      await expect(
        family.client.$queryRawUnsafe<{ count: number }>(
          'SELECT COUNT(*)::int AS "count" FROM "create_many_bind_set_fires"'
        )
      ).resolves.toEqual([{ count: 0 }]);

      await family.client.$executeRawUnsafe(
        'DROP TRIGGER "create_many_bind_set_failure" ON "create_many_bind_collection_tags"'
      );
      await family.client.$executeRawUnsafe(
        "DROP FUNCTION viborm_create_many_bind_set_fail()"
      );

      await expect(
        client.collection.update({
          where: { id: "set-owner" },
          data: { tags: { set: newTags } },
        })
      ).resolves.toMatchObject({ id: "set-owner" });
      await expect(membership()).resolves.toEqual(newTags);
      await expect(
        family.client.$queryRawUnsafe<{ count: number }>(
          'SELECT COUNT(*)::int AS "count" FROM "create_many_bind_set_fires"'
        )
      ).resolves.toEqual([{ count: 2 }]);
    } finally {
      await family.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS "create_many_bind_set_failure" ON "create_many_bind_collection_tags"'
      );
      await family.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS "create_many_bind_set_statement" ON "create_many_bind_collection_tags"'
      );
      await family.client.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS viborm_create_many_bind_set_fail()"
      );
      await family.client.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS viborm_create_many_bind_set_fire()"
      );
      await family.client.$executeRawUnsafe(
        'DROP TABLE IF EXISTS "create_many_bind_set_fires"'
      );
    }
  });

  test("a PostgreSQL statement trigger fires once per chunk and once under budget", async () => {
    const family = getFamily();
    const client = createClient({
      schema,
      driver: new CapacityDriver(6, { client: family.database }),
    });
    await family.client.$executeRawUnsafe(
      'CREATE TABLE "create_many_bind_trigger_fires" ("id" SERIAL PRIMARY KEY)'
    );
    await family.client.$executeRawUnsafe(
      'CREATE OR REPLACE FUNCTION viborm_create_many_bind_trigger() RETURNS trigger AS $$ BEGIN INSERT INTO "create_many_bind_trigger_fires" DEFAULT VALUES; RETURN NULL; END; $$ LANGUAGE plpgsql'
    );
    await family.client.$executeRawUnsafe(
      'CREATE TRIGGER "create_many_bind_statement" AFTER INSERT ON "create_many_bind_entries" FOR EACH STATEMENT EXECUTE FUNCTION viborm_create_many_bind_trigger()'
    );
    await family.client.$executeRawUnsafe(
      'CREATE TRIGGER "create_many_bind_junction_statement" AFTER INSERT ON "create_many_bind_collection_tags" FOR EACH STATEMENT EXECUTE FUNCTION viborm_create_many_bind_trigger()'
    );

    const chunkedRows = Array.from({ length: 5 }, (_, index) => ({
      tenantId: "chunked",
      slot: `slot-${index}`,
      label: `label-${index}`,
    }));
    await expect(
      client.entry.createMany({ data: chunkedRows })
    ).resolves.toEqual({ count: 5 });
    await expect(
      family.client.$queryRawUnsafe<{ count: number }>(
        'SELECT COUNT(*)::int AS "count" FROM "create_many_bind_trigger_fires"'
      )
    ).resolves.toEqual([{ count: 3 }]);

    await client.entry.deleteMany({});
    await family.client.$executeRawUnsafe(
      'TRUNCATE TABLE "create_many_bind_trigger_fires" RESTART IDENTITY'
    );
    await expect(
      client.entry.createMany({
        data: [
          { tenantId: "small", slot: "s1", label: "one" },
          { tenantId: "small", slot: "s2", label: "two" },
        ],
      })
    ).resolves.toEqual({ count: 2 });
    await expect(
      family.client.$queryRawUnsafe<{ count: number }>(
        'SELECT COUNT(*)::int AS "count" FROM "create_many_bind_trigger_fires"'
      )
    ).resolves.toEqual([{ count: 1 }]);

    await client.entry.deleteMany({});
    await family.client.$executeRawUnsafe(
      'TRUNCATE TABLE "create_many_bind_trigger_fires" RESTART IDENTITY'
    );
    const returnedRows = Array.from({ length: 5 }, (_, index) => ({
      tenantId: "returned",
      slot: `slot-${index}`,
      label: `label-${index}`,
    }));
    await expect(
      client.entry.createMany({
        data: returnedRows,
        select: { tenantId: true, slot: true, label: true },
      })
    ).resolves.toEqual(returnedRows);
    await expect(
      family.client.$queryRawUnsafe<{ count: number }>(
        'SELECT COUNT(*)::int AS "count" FROM "create_many_bind_trigger_fires"'
      )
    ).resolves.toEqual([{ count: 3 }]);

    await client.entry.deleteMany({});
    await family.client.$executeRawUnsafe(
      'TRUNCATE TABLE "create_many_bind_trigger_fires" RESTART IDENTITY'
    );
    await client.entry.create({
      data: { tenantId: "skip", slot: "dup", label: "existing" },
    });
    await family.client.$executeRawUnsafe(
      'TRUNCATE TABLE "create_many_bind_trigger_fires" RESTART IDENTITY'
    );
    await expect(
      client.entry.createMany({
        data: [
          { tenantId: "skip", slot: "a", label: "a" },
          { tenantId: "skip", slot: "b", label: "b" },
          { tenantId: "skip", slot: "dup", label: "ignored" },
          { tenantId: "skip", slot: "c", label: "c" },
          { tenantId: "skip", slot: "d", label: "d" },
        ],
        skipDuplicates: true,
      })
    ).resolves.toEqual({ count: 4 });
    await expect(
      family.client.$queryRawUnsafe<{ count: number }>(
        'SELECT COUNT(*)::int AS "count" FROM "create_many_bind_trigger_fires"'
      )
    ).resolves.toEqual([{ count: 3 }]);

    await family.client.$executeRawUnsafe(
      'TRUNCATE TABLE "create_many_bind_trigger_fires" RESTART IDENTITY'
    );
    await client.tag.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({ id: `tag-${index}` })),
    });
    await client.collection.create({ data: { id: "collection" } });
    await family.client.$executeRawUnsafe(
      'TRUNCATE TABLE "create_many_bind_trigger_fires" RESTART IDENTITY'
    );
    await client.collection.update({
      where: { id: "collection" },
      data: {
        tags: {
          connect: Array.from({ length: 5 }, (_, index) => ({
            id: `tag-${index}`,
          })),
        },
      },
    });
    await expect(
      family.client.$queryRawUnsafe<{ count: number }>(
        'SELECT COUNT(*)::int AS "count" FROM "create_many_bind_trigger_fires"'
      )
    ).resolves.toEqual([{ count: 2 }]);
    await expect(
      client.tag.findMany({
        where: { collections: { some: { id: "collection" } } },
        orderBy: { id: "asc" },
        select: { id: true },
      })
    ).resolves.toEqual(
      Array.from({ length: 5 }, (_, index) => ({ id: `tag-${index}` }))
    );
  });
});
