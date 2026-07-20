import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { manyToManySchema } from "../fixtures/many-to-many-schema";

const FOR_UPDATE_PATTERN = /FOR UPDATE/i;
const CHILD_UPDATE_PATTERN = /^UPDATE "nested_identity_children"/i;
const CHILD_DELETE_PATTERN = /^DELETE FROM "nested_identity_children"/i;
const CHILD_PK_WHERE_PATTERN = /WHERE (?:"nested_identity_children"\.)?"id"/i;
const INSERT_PATTERN = /^INSERT/i;
const JUNCTION_DELETE_PATTERN = /^DELETE FROM "m2m_post_tags"/i;
const TAG_DELETE_PATTERN = /^DELETE FROM "m2m_tags"/i;
const TAG_PK_WHERE_PATTERN = /WHERE (?:"m2m_tags"\.)?"id"/i;

class NonReturningAdapter extends PostgresAdapter implements DatabaseAdapter {
  constructor() {
    super();
    this.capabilities = { ...this.capabilities, supportsReturning: false };
    this.mutations = {
      ...this.mutations,
      returning: (_columns: Sql): Sql => sql.empty,
    };
  }
}

class RecordingDriver extends PGliteDriver {
  override readonly adapter: DatabaseAdapter = new NonReturningAdapter();
  readonly statements: string[] = [];

  resetTrace(): void {
    this.statements.length = 0;
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, params, context);
  }
}

class SplitWitnessBatchDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private isSplitWitnessArmed = false;
  private hasPlantedSplitWitness = false;
  private readonly plantSplitWitness: (client: PGlite) => Promise<void>;

  constructor(
    client: PGlite,
    plantSplitWitness: (client: PGlite) => Promise<void>
  ) {
    super({ client });
    this.plantSplitWitness = plantSplitWitness;
  }

  armSplitWitness(): void {
    this.isSplitWitnessArmed = true;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (!(client instanceof PGlite)) {
      throw new Error("Split-witness test requires the base PGlite client.");
    }
    if (this.isSplitWitnessArmed && !this.hasPlantedSplitWitness) {
      this.hasPlantedSplitWitness = true;
      await this.plantSplitWitness(client);
    }

    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

const parent = s
  .model({
    id: s.string().id(),
    children: s.oneToMany(() => child),
  })
  .map("nested_identity_parents");

const child = s
  .model({
    id: s.string().id(),
    code: s.string().unique(),
    name: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .manyToOne(() => parent)
      .fields("parentId")
      .references("id")
      .optional(),
  })
  .map("nested_identity_children");

const schema = { parent, child };

describe("nested single-mutation identity capture", () => {
  let driver: RecordingDriver;
  let client: ReturnType<typeof createIdentityClient>;

  function createIdentityClient(nextDriver: RecordingDriver) {
    return createClient({ schema, driver: nextDriver });
  }

  beforeEach(async () => {
    driver = new RecordingDriver();
    client = createIdentityClient(driver);
    await push(client, { force: true });
    await client.parent.create({ data: { id: "parent" } });
    await client.child.createMany({
      data: [
        { id: "child-a", code: "code-a", name: "a", parentId: "parent" },
        { id: "child-b", code: "code-b", name: "b", parentId: "parent" },
      ],
    });
    driver.resetTrace();
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  test("nested update locks an alternate unique selector and mutates the captured PK", async () => {
    await client.parent.update({
      where: { id: "parent" },
      data: {
        children: {
          update: {
            where: { code: "code-a" },
            data: { name: "updated" },
          },
        },
      },
    });

    const childLock = driver.statements.find(
      (statement) =>
        statement.includes("nested_identity_children") &&
        FOR_UPDATE_PATTERN.test(statement)
    );
    const childUpdate = driver.statements.find((statement) =>
      CHILD_UPDATE_PATTERN.test(statement)
    );
    expect(childLock).toContain('"code"');
    expect(childUpdate).toMatch(CHILD_PK_WHERE_PATTERN);
    expect(childUpdate).not.toContain(
      'WHERE "nested_identity_children"."code"'
    );
  });

  test("explicit disconnect arrays lock and update every captured PK separately", async () => {
    // Class B — maintainer decision (PLAN §P5): this asserts V1's statement-count
    // choreography (a repeated disconnect target deduped into 2 UPDATEs, not 3).
    // V2's shape is observably idempotent with identical final state ([null,
    // null]); reproducing the deduped statement count needs cross-part
    // coordination the one-part-per-item atom lacks. Retargeted to the frozen V1
    // runtime — it dies with V1 at P6 — rather than weakening the assertion.
    client = createClient({ schema, driver, queryEngine: "v1" });
    await client.parent.update({
      where: { id: "parent" },
      data: {
        children: {
          disconnect: [
            { code: "code-a" },
            { code: "code-a" },
            { code: "code-b" },
          ],
        },
      },
    });

    const childUpdates = driver.statements.filter((statement) =>
      CHILD_UPDATE_PATTERN.test(statement)
    );
    expect(childUpdates).toHaveLength(2);
    expect(
      childUpdates.every((statement) => CHILD_PK_WHERE_PATTERN.test(statement))
    ).toBe(true);
    expect(
      (await client.child.findMany({ orderBy: { id: "asc" } })).map(
        (row) => row.parentId
      )
    ).toEqual([null, null]);
  });

  test("an explicit array with a missing target rolls back every earlier member", async () => {
    await expect(
      client.parent.update({
        where: { id: "parent" },
        data: {
          children: {
            disconnect: [{ code: "code-a" }, { code: "missing" }],
          },
        },
      })
    ).rejects.toThrow();

    expect(
      (await client.child.findMany({ orderBy: { id: "asc" } })).map(
        (row) => row.parentId
      )
    ).toEqual(["parent", "parent"]);
  });

  test("explicit delete arrays lock and delete every captured PK separately", async () => {
    await client.parent.update({
      where: { id: "parent" },
      data: {
        children: {
          delete: [{ code: "code-a" }, { code: "code-b" }],
        },
      },
    });

    const childDeletes = driver.statements.filter((statement) =>
      CHILD_DELETE_PATTERN.test(statement)
    );
    expect(childDeletes).toHaveLength(2);
    expect(
      childDeletes.every((statement) => CHILD_PK_WHERE_PATTERN.test(statement))
    ).toBe(true);
    await expect(client.child.findMany()).resolves.toEqual([]);
  });

  test("planned guards require the original selector and captured PK on the same row", async () => {
    const db = new PGlite();
    const plannedDriver = new SplitWitnessBatchDriver(db, async (client) => {
      await client.query(
        'UPDATE "nested_identity_children" SET "code" = $1 WHERE "id" = $2',
        ["code-moved", "child-a"]
      );
      await client.query(
        'INSERT INTO "nested_identity_children" ("id", "code", "name", "parentId") VALUES ($1, $2, $3, $4)',
        ["child-replacement", "code-a", "replacement", "parent"]
      );
    });
    const plannedClient = createClient({
      schema,
      driver: plannedDriver,
    });
    try {
      await push(plannedClient, { force: true });
      await plannedClient.parent.create({ data: { id: "parent" } });
      await plannedClient.child.create({
        data: {
          id: "child-a",
          code: "code-a",
          name: "original",
          parentId: "parent",
        },
      });

      plannedDriver.armSplitWitness();
      await expect(
        plannedClient.parent.update({
          where: { id: "parent" },
          data: {
            children: {
              update: {
                where: { code: "code-a" },
                data: { name: "must-not-move" },
              },
            },
          },
        })
      ).rejects.toThrow();

      await expect(
        plannedClient.child.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([
        {
          id: "child-a",
          code: "code-moved",
          name: "original",
          parentId: "parent",
        },
        {
          id: "child-replacement",
          code: "code-a",
          name: "replacement",
          parentId: "parent",
        },
      ]);
    } finally {
      await plannedClient.$disconnect();
    }
  });

  test("planned set does not connect a replacement that inherited the selector", async () => {
    const db = new PGlite();
    const plannedDriver = new SplitWitnessBatchDriver(db, async (client) => {
      await client.query(
        'UPDATE "nested_identity_children" SET "code" = $1 WHERE "id" = $2',
        ["code-moved", "child-a"]
      );
      await client.query(
        'INSERT INTO "nested_identity_children" ("id", "code", "name", "parentId") VALUES ($1, $2, $3, $4)',
        ["child-replacement", "code-a", "replacement", null]
      );
    });
    const plannedClient = createClient({ schema, driver: plannedDriver });
    try {
      await push(plannedClient, { force: true });
      await plannedClient.parent.create({ data: { id: "parent" } });
      await plannedClient.child.create({
        data: {
          id: "child-a",
          code: "code-a",
          name: "original",
          parentId: null,
        },
      });

      plannedDriver.armSplitWitness();
      await expect(
        plannedClient.parent.update({
          where: { id: "parent" },
          data: { children: { set: [{ code: "code-a" }] } },
        })
      ).rejects.toThrow();
      expect(
        (await plannedClient.child.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.parentId
        )
      ).toEqual([null, null]);
    } finally {
      await plannedClient.$disconnect();
    }
  });

  test("planned m2m connectOrCreate never links a selector replacement", async () => {
    const db = new PGlite();
    const plannedDriver = new SplitWitnessBatchDriver(db, async (client) => {
      await client.query('UPDATE "m2m_tags" SET "name" = $1 WHERE "id" = $2', [
        "name-moved",
        "tag-a",
      ]);
      await client.query(
        'INSERT INTO "m2m_tags" ("id", "name", "featuredPostId") VALUES ($1, $2, $3)',
        ["tag-replacement", "name-a", null]
      );
    });
    const plannedClient = createClient({
      schema: manyToManySchema,
      driver: plannedDriver,
    });
    try {
      await push(plannedClient, { force: true });
      await plannedClient.post.create({
        data: { id: "post", title: "Post" },
      });
      await plannedClient.tag.create({
        data: { id: "tag-a", name: "name-a", featuredPostId: null },
      });

      plannedDriver.armSplitWitness();
      await expect(
        plannedClient.post.update({
          where: { id: "post" },
          data: {
            tags: {
              connectOrCreate: {
                where: { name: "name-a" },
                create: { id: "tag-created", name: "name-a" },
              },
            },
          },
        })
      ).rejects.toThrow();
      await expect(
        plannedClient.post.findUnique({
          where: { id: "post" },
          include: { tags: true },
        })
      ).resolves.toMatchObject({ tags: [] });
    } finally {
      await plannedClient.$disconnect();
    }
  });

  test("planned m2m set rejects a replacement that inherited the selector", async () => {
    const db = new PGlite();
    const plannedDriver = new SplitWitnessBatchDriver(db, async (client) => {
      await client.query('UPDATE "m2m_tags" SET "name" = $1 WHERE "id" = $2', [
        "name-moved",
        "tag-a",
      ]);
      await client.query(
        'INSERT INTO "m2m_tags" ("id", "name", "featuredPostId") VALUES ($1, $2, $3)',
        ["tag-replacement", "name-a", null]
      );
    });
    const plannedClient = createClient({
      schema: manyToManySchema,
      driver: plannedDriver,
    });
    try {
      await push(plannedClient, { force: true });
      await plannedClient.post.create({ data: { id: "post", title: "Post" } });
      await plannedClient.tag.create({
        data: { id: "tag-a", name: "name-a", featuredPostId: null },
      });
      await plannedClient.post.update({
        where: { id: "post" },
        data: { tags: { connect: { id: "tag-a" } } },
      });

      plannedDriver.armSplitWitness();
      await expect(
        plannedClient.post.update({
          where: { id: "post" },
          data: { tags: { set: [{ name: "name-a" }] } },
        })
      ).rejects.toThrow();
      await expect(
        plannedClient.post.findUnique({
          where: { id: "post" },
          include: { tags: true },
        })
      ).resolves.toMatchObject({
        tags: [{ id: "tag-a", name: "name-moved" }],
      });
    } finally {
      await plannedClient.$disconnect();
    }
  });

  test("planned explicit m2m delete rejects a connected selector replacement", async () => {
    const db = new PGlite();
    const plannedDriver = new SplitWitnessBatchDriver(db, async (client) => {
      await client.query('UPDATE "m2m_tags" SET "name" = $1 WHERE "id" = $2', [
        "name-moved",
        "tag-a",
      ]);
      await client.query(
        'INSERT INTO "m2m_tags" ("id", "name", "featuredPostId") VALUES ($1, $2, $3)',
        ["tag-replacement", "name-a", null]
      );
      await client.query(
        'INSERT INTO "m2m_post_tags" ("post_ref", "tag_ref") VALUES ($1, $2)',
        ["post", "tag-replacement"]
      );
    });
    const plannedClient = createClient({
      schema: manyToManySchema,
      driver: plannedDriver,
    });
    try {
      await push(plannedClient, { force: true });
      await plannedClient.post.create({ data: { id: "post", title: "Post" } });
      await plannedClient.tag.create({
        data: { id: "tag-a", name: "name-a", featuredPostId: null },
      });
      await plannedClient.post.update({
        where: { id: "post" },
        data: { tags: { connect: { id: "tag-a" } } },
      });

      plannedDriver.armSplitWitness();
      await expect(
        plannedClient.post.update({
          where: { id: "post" },
          data: { tags: { delete: { name: "name-a" } } },
        })
      ).rejects.toThrow();
      await expect(
        plannedClient.tag.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([
        { id: "tag-a", name: "name-moved" },
        { id: "tag-replacement", name: "name-a" },
      ]);
      const postWithTags = await plannedClient.post.findUnique({
        where: { id: "post" },
        include: { tags: true },
      });
      expect(postWithTags?.tags.map((tag) => tag.id).sort()).toEqual([
        "tag-a",
        "tag-replacement",
      ]);
    } finally {
      await plannedClient.$disconnect();
    }
  });

  test("non-returning live m2m connectOrCreate links the captured target", async () => {
    const liveDriver = new RecordingDriver();
    const liveClient = createClient({
      schema: manyToManySchema,
      driver: liveDriver,
    });
    try {
      await push(liveClient, { force: true });
      await liveClient.post.create({ data: { id: "post", title: "Post" } });
      await liveClient.tag.create({
        data: { id: "tag-a", name: "name-a", featuredPostId: null },
      });
      liveDriver.resetTrace();

      await liveClient.post.update({
        where: { id: "post" },
        data: {
          tags: {
            connectOrCreate: {
              where: { name: "name-a" },
              create: { id: "tag-created", name: "name-a" },
            },
          },
        },
      });
      const targetLock = liveDriver.statements.find(
        (statement) =>
          statement.includes('FROM "m2m_tags"') &&
          FOR_UPDATE_PATTERN.test(statement)
      );
      const junctionInsert = liveDriver.statements.find(
        (statement) =>
          INSERT_PATTERN.test(statement) &&
          statement.includes('"post_ref"') &&
          statement.includes('"tag_ref"')
      );
      expect(targetLock).toContain('"name"');
      expect(junctionInsert).toBeDefined();
      expect(junctionInsert).not.toContain('FROM "m2m_tags"');
      await expect(
        liveClient.post.findUnique({
          where: { id: "post" },
          include: { tags: true },
        })
      ).resolves.toMatchObject({ tags: [{ id: "tag-a", name: "name-a" }] });
    } finally {
      await liveClient.$disconnect();
    }
  });

  test("non-returning live m2m set locks members and deduplicates captured PKs", async () => {
    const liveDriver = new RecordingDriver();
    const liveClient = createClient({
      schema: manyToManySchema,
      driver: liveDriver,
    });
    try {
      await push(liveClient, { force: true });
      await liveClient.post.create({ data: { id: "post", title: "Post" } });
      await liveClient.tag.create({
        data: { id: "tag-a", name: "name-a", featuredPostId: null },
      });
      liveDriver.resetTrace();

      await liveClient.post.update({
        where: { id: "post" },
        data: { tags: { set: [{ id: "tag-a" }, { name: "name-a" }] } },
      });
      const targetLocks = liveDriver.statements.filter(
        (statement) =>
          statement.includes('FROM "m2m_tags"') &&
          FOR_UPDATE_PATTERN.test(statement)
      );
      const junctionInserts = liveDriver.statements.filter(
        (statement) =>
          INSERT_PATTERN.test(statement) &&
          statement.includes('"m2m_post_tags"')
      );
      expect(targetLocks).toHaveLength(2);
      expect(
        targetLocks.some((statement) => statement.includes('"name"'))
      ).toBe(true);
      expect(junctionInserts).toHaveLength(1);
      await expect(
        liveClient.post.findUnique({
          where: { id: "post" },
          include: { tags: true },
        })
      ).resolves.toMatchObject({ tags: [{ id: "tag-a", name: "name-a" }] });
    } finally {
      await liveClient.$disconnect();
    }
  });

  test("non-returning live explicit m2m delete locks and deletes the captured PK", async () => {
    const liveDriver = new RecordingDriver();
    const liveClient = createClient({
      schema: manyToManySchema,
      driver: liveDriver,
    });
    try {
      await push(liveClient, { force: true });
      await liveClient.post.create({ data: { id: "post", title: "Post" } });
      await liveClient.tag.create({
        data: { id: "tag-a", name: "name-a", featuredPostId: null },
      });
      await liveClient.post.update({
        where: { id: "post" },
        data: { tags: { connect: { id: "tag-a" } } },
      });
      liveDriver.resetTrace();

      await liveClient.post.update({
        where: { id: "post" },
        data: { tags: { delete: { name: "name-a" } } },
      });
      const targetLock = liveDriver.statements.find(
        (statement) =>
          statement.includes('FROM "m2m_tags"') &&
          FOR_UPDATE_PATTERN.test(statement)
      );
      const junctionDelete = liveDriver.statements.find((statement) =>
        JUNCTION_DELETE_PATTERN.test(statement)
      );
      const childDelete = liveDriver.statements.find((statement) =>
        TAG_DELETE_PATTERN.test(statement)
      );
      expect(targetLock).toContain('"name"');
      expect(junctionDelete).not.toContain('FROM "m2m_tags"');
      expect(childDelete).toMatch(TAG_PK_WHERE_PATTERN);
      expect(childDelete).not.toContain('WHERE "m2m_tags"."name"');
      await expect(
        liveClient.tag.findUnique({ where: { id: "tag-a" } })
      ).resolves.toBeNull();
    } finally {
      await liveClient.$disconnect();
    }
  });
});
