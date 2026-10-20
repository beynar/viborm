/**
 * A root write answering a RELATION projection, in its own statement
 * (perf 1.3.4, `OperationContext.answersInStatement`).
 *
 * 1.3.3 sent a locate, the write and a re-read, inside a transaction, for an
 * `update` with an `include`; on a remote driver each statement and each
 * BEGIN/COMMIT is a round trip. Now a write whose projection's statement reads
 * no row the write can change answers it in ONE statement: PostgreSQL reads
 * the projection over the write's `RETURNING *` in a data-modifying `WITH`,
 * SQLite reads it in the `RETURNING` itself. A provider without RETURNING
 * (MySQL) keeps its route, and so does every case the owner declines:
 *
 * - the projection's statement names the written table (a self-relation, a
 *   filter or a policy reaching it): its answer must see the write;
 * - an UPDATE writes a member of a referenceable key: a foreign key's action
 *   may change the rows the projection reads;
 * - a DELETE on SQLite: the `RETURNING` reads after the rows it cascades to
 *   are gone, where the route it replaces read them first.
 *
 * The first describe pins the statements per transport profile; the rest pin
 * the behaviours a fold must keep, on PGlite and SQLite3 alike.
 */

import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  ForbiddenError,
  NotFoundError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { beforeAll, describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    code: s.string(),
    name: s.string().map("display_name"),
    managerId: s.int().nullable(),
    manager: s
      .toOne(() => author)
      .fields("managerId")
      .references("id"),
    reports: s.toMany(() => author),
    posts: s.toMany(() => post),
    badges: s.toMany(() => badge),
  })
  .map("rt1_authors")
  .index(["code"], { unique: true });
const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    published: s.boolean(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id")
      .onDelete("cascade"),
    comments: s.toMany(() => comment),
  })
  .map("rt1_posts");
const comment = s
  .model({
    id: s.int().id(),
    body: s.string(),
    postId: s.int(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => comment)
      .fields("parentId")
      .references("id"),
    replies: s.toMany(() => comment),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id")
      .onDelete("cascade"),
  })
  .map("rt1_comments");
const badge = s
  .model({
    id: s.int().id(),
    label: s.string(),
    authorCode: s.string(),
    holder: s
      .toOne(() => author)
      .fields("authorCode")
      .references("code")
      .onUpdate("cascade"),
  })
  .map("rt1_badges");
const schema = { author, post, comment, badge };

beforeAll(() => hydrateSchemaNames(schema));
const SAVEPOINT = /SAVEPOINT/i;
const SHARED_BODY = /"__shared_\d+"/;
const getFamily = usePGliteSchemaFamily(schema);

interface Traffic {
  statements: string[];
  batches: number;
  transactions: number;
}
interface Recording {
  traffic: Traffic | undefined;
}
const record = (driver: Recording, sql: string) => {
  driver.traffic?.statements.push(sql);
};

class RecordingPGlite extends PGliteDriver implements Recording {
  traffic: Traffic | undefined;
  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    record(this, sql);
    return super.execute<T>(client, sql, params, context);
  }
  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    record(this, sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
  protected override transaction<T>(
    client: PGlite | Transaction,
    body: (transaction: Transaction) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    if (this.traffic) this.traffic.transactions++;
    return super.transaction(client, body, context);
  }
}
/** Neon HTTP's shape: an atomic native batch, no callback transaction. */
class BatchOnlyRecordingPGlite extends RecordingPGlite {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (this.traffic) this.traffic.batches++;
    return await (client as PGlite).transaction(async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries)
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      return results;
    });
  }
}

class RecordingSQLite3 extends SQLite3Driver implements Recording {
  traffic: Traffic | undefined;
  constructor() {
    super({ dataDir: ":memory:" });
  }
  protected override execute<T>(
    client: Database.Database,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    record(this, sql);
    return super.execute<T>(client, sql, params, context);
  }
  protected override executeRaw<T>(
    client: Database.Database,
    sql: string,
    params: unknown[] | undefined
  ): Promise<QueryResult<T>> {
    record(this, sql);
    return super.executeRaw<T>(client, sql, params);
  }
  protected override transaction<T>(
    client: Database.Database,
    body: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    if (this.traffic) this.traffic.transactions++;
    return super.transaction(client, body, context);
  }
}
/** D1's shape: an atomic native batch, no callback transaction. */
class BatchOnlyRecordingSQLite3 extends RecordingSQLite3 {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (this.traffic) this.traffic.batches++;
    client.exec("BEGIN");
    try {
      const results = await super.executeBatch<T>(client, queries);
      client.exec("COMMIT");
      return results;
    } catch (error) {
      client.exec("ROLLBACK");
      throw error;
    }
  }
}
/** MySQL's capability profile on SQLite: no RETURNING, no targeted upsert. */
class NonReturningRecordingSQLite3 extends RecordingSQLite3 {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
    this.adapter.capabilities.supportsTargetedUpsert = false;
  }
}

type Driver = RecordingPGlite | RecordingSQLite3;
/** One loose client over every profile's driver. */
type Client = any;

async function boot(driver: Driver): Promise<Client> {
  const client = createClient({ schema, driver });
  if (driver instanceof RecordingPGlite) await getFamily().reset();
  else await syncLiveSchema(client);
  await client.author.create({
    data: { id: 1, email: "e1", code: "c1", name: "n1" },
  });
  await client.author.create({
    data: { id: 2, email: "e2", code: "c2", name: "n2", managerId: 1 },
  });
  await client.author.create({
    data: { id: 3, email: "e3", code: "c3", name: "n3" },
  });
  await client.author.update({ where: { id: 3 }, data: { managerId: 3 } });
  for (const [id, authorId, published] of [
    [10, 1, true],
    [11, 1, false],
    [12, 2, true],
  ] as const)
    await client.post.create({
      data: { id, title: `p${id}`, published, authorId },
    });
  for (const [id, postId] of [
    [100, 10],
    [101, 10],
  ] as const)
    await client.comment.create({ data: { id, body: `c${id}`, postId } });
  // A reply chain under post 12, for a recursive projection.
  for (const [id, parentId] of [
    [102, null],
    [103, 102],
    [104, 103],
  ] as const)
    await client.comment.create({
      data: { id, body: `c${id}`, postId: 12, parentId },
    });
  await client.badge.create({ data: { id: 1, label: "b1", authorCode: "c1" } });
  return client;
}

const pglite = () => {
  const family = getFamily();
  return new RecordingPGlite({
    client: family.database,
    namespace: family.namespace,
  });
};
const pgliteBatch = () => {
  const family = getFamily();
  return new BatchOnlyRecordingPGlite({
    client: family.database,
    namespace: family.namespace,
  });
};
const SUBSTRATES = [
  ["PGlite", pglite],
  ["SQLite3", () => new RecordingSQLite3()],
] as const;

async function traced<T>(
  driver: Driver,
  run: () => Promise<T>
): Promise<{ traffic: Traffic; value?: T; error?: unknown }> {
  const traffic: Traffic = { statements: [], batches: 0, transactions: 0 };
  driver.traffic = traffic;
  try {
    return { traffic, value: await run() };
  } catch (error) {
    return { traffic, error };
  } finally {
    driver.traffic = undefined;
  }
}

const posts = { posts: { orderBy: { id: "asc" } } } as const;
const WRITES = {
  "create + include": (client: Client) =>
    client.author.create({
      data: { id: 7, email: "e7", code: "c7", name: "n7" },
      include: posts,
    }),
  "update + include": (client: Client) =>
    client.author.update({
      where: { id: 1 },
      data: { name: "x" },
      include: posts,
    }),
  "upsert (found) + include": (client: Client) =>
    client.post.upsert({
      where: { id: 10 },
      create: { id: 10, title: "c", published: true, authorId: 1 },
      update: { title: "u" },
      include: { author: true, comments: true },
    }),
  "upsert (missing) + include": (client: Client) =>
    client.post.upsert({
      where: { id: 70 },
      create: { id: 70, title: "c", published: true, authorId: 1 },
      update: { title: "u" },
      include: { author: true, comments: true },
    }),
  "delete + include": (client: Client) =>
    client.post.delete({
      where: { id: 10 },
      include: { comments: true, author: true },
    }),
} as const;
type Write = keyof typeof WRITES;

/** [statements, transactions, batches] per write, per transport profile. */
const PROFILES: readonly {
  name: string;
  driver: () => Driver;
  expected: Record<Write, readonly [number, number, number]>;
}[] = [
  {
    name: "PostgreSQL, interactive (pg, PGlite)",
    driver: pglite,
    expected: {
      "create + include": [1, 0, 0],
      "update + include": [1, 0, 0],
      "upsert (found) + include": [1, 0, 0],
      "upsert (missing) + include": [1, 0, 0],
      "delete + include": [1, 0, 0],
    },
  },
  {
    name: "PostgreSQL, batch-only (Neon HTTP)",
    driver: pgliteBatch,
    expected: {
      "create + include": [1, 0, 0],
      "update + include": [1, 0, 0],
      "upsert (found) + include": [1, 0, 0],
      "upsert (missing) + include": [1, 0, 0],
      "delete + include": [1, 0, 0],
    },
  },
  {
    name: "SQLite, interactive (better-sqlite3, libSQL)",
    driver: () => new RecordingSQLite3(),
    expected: {
      "create + include": [1, 0, 0],
      "update + include": [1, 0, 0],
      "upsert (found) + include": [1, 0, 0],
      "upsert (missing) + include": [1, 0, 0],
      // Unchanged: a `RETURNING` reads after the delete's cascade.
      "delete + include": [3, 1, 0],
    },
  },
  {
    name: "SQLite, batch-only (D1)",
    driver: () => new BatchOnlyRecordingSQLite3(),
    expected: {
      "create + include": [1, 0, 0],
      "update + include": [1, 0, 0],
      "upsert (found) + include": [1, 0, 0],
      "upsert (missing) + include": [1, 0, 0],
      // Unchanged: a capture, a read, then a batch of two premises and the delete.
      "delete + include": [5, 0, 1],
    },
  },
  {
    name: "no RETURNING (MySQL's capabilities)",
    driver: () => new NonReturningRecordingSQLite3(),
    // Unchanged: no statement here answers a projection.
    expected: {
      "create + include": [2, 1, 0],
      "update + include": [4, 1, 0],
      "upsert (found) + include": [5, 1, 0],
      "upsert (missing) + include": [3, 1, 0],
      "delete + include": [3, 1, 0],
    },
  },
];

describe("statements per root write with a relation projection", () => {
  for (const profile of PROFILES)
    test(profile.name, async () => {
      const counts: Record<string, readonly [number, number, number]> = {};
      const answers: Record<string, unknown> = {};
      for (const [name, write] of Object.entries(WRITES)) {
        const driver = profile.driver();
        const client = await boot(driver);
        const { traffic, value, error } = await traced(driver, () =>
          write(client)
        );
        expect(error).toBeUndefined();
        counts[name] = [
          traffic.statements.length,
          traffic.transactions,
          traffic.batches,
        ];
        answers[name] = value;
      }
      expect(counts).toEqual(profile.expected);
      // The same answers on every profile.
      expect(answers).toEqual({
        "create + include": {
          id: 7,
          email: "e7",
          code: "c7",
          name: "n7",
          managerId: null,
          posts: [],
        },
        "update + include": {
          id: 1,
          email: "e1",
          code: "c1",
          name: "x",
          managerId: null,
          posts: [
            { id: 10, title: "p10", published: true, authorId: 1 },
            { id: 11, title: "p11", published: false, authorId: 1 },
          ],
        },
        "upsert (found) + include": {
          id: 10,
          title: "u",
          published: true,
          authorId: 1,
          author: {
            id: 1,
            email: "e1",
            code: "c1",
            name: "n1",
            managerId: null,
          },
          comments: [
            { id: 100, body: "c100", postId: 10, parentId: null },
            { id: 101, body: "c101", postId: 10, parentId: null },
          ],
        },
        "upsert (missing) + include": {
          id: 70,
          title: "c",
          published: true,
          authorId: 1,
          author: {
            id: 1,
            email: "e1",
            code: "c1",
            name: "n1",
            managerId: null,
          },
          comments: [],
        },
        "delete + include": {
          id: 10,
          title: "p10",
          published: true,
          authorId: 1,
          comments: [
            { id: 100, body: "c100", postId: 10, parentId: null },
            { id: 101, body: "c101", postId: 10, parentId: null },
          ],
          author: {
            id: 1,
            email: "e1",
            code: "c1",
            name: "n1",
            managerId: null,
          },
        },
      });
    });
});

const policy = permissions({
  actor: v.object({ userId: v.number() }),
  models: {
    author: { read: true, update: { id: { actor: "userId" } } },
    post: {
      read: { OR: [{ published: true }, { author: { name: "n1" } }] },
      // A row the actor may update is one it may read: published only, so
      // an unpublished post is read only through its author's name.
      update: { authorId: { actor: "userId" }, published: true },
    },
    comment: { read: true },
    badge: { read: true },
  },
});

for (const [substrate, make] of SUBSTRATES)
  describe(`${substrate}: what answering in the write's statement keeps`, () => {
    test("a missing row is the NotFoundError, in the one statement", async () => {
      const driver = make();
      const client = await boot(driver);
      const { traffic, error } = await traced(driver, () =>
        client.author.update({
          where: { id: 99 },
          data: { name: "ghost" },
          include: posts,
        })
      );
      expect(error).toBeInstanceOf(NotFoundError);
      expect(traffic.statements).toHaveLength(1);
      expect(traffic.transactions).toBe(0);
    });

    test("a unique violation in the folded statement keeps its typed error and writes nothing", async () => {
      const driver = make();
      const client = await boot(driver);
      const { traffic, error } = await traced(driver, () =>
        client.post.create({
          data: { id: 10, title: "again", published: true, authorId: 2 },
          include: { author: true },
        })
      );
      expect(error).toBeInstanceOf(UniqueConstraintError);
      expect(traffic.statements).toHaveLength(1);
      expect(await client.post.findUnique({ where: { id: 10 } })).toEqual({
        id: 10,
        title: "p10",
        published: true,
        authorId: 1,
      });
    });

    test("a projection that may refuse while decoding keeps the write's transaction", async () => {
      const driver = make();
      const client = await boot(driver);
      // A recursive relation's output budget is judged while decoding, after
      // the statement: the write must still be undone.
      const { traffic, error } = await traced(driver, () =>
        client.post.update({
          where: { id: 12 },
          data: { title: "over" },
          include: {
            comments: {
              where: { parentId: null },
              include: { replies: { recurse: { maxOccurrences: 1 } } },
            },
          },
        })
      );
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect(traffic.transactions + traffic.batches).toBe(1);
      expect((await client.post.findUnique({ where: { id: 12 } })).title).toBe(
        "p12"
      );
    });

    test("a refused produced row is the ForbiddenError, and nothing is written", async () => {
      const driver = make();
      const client = await boot(driver);
      const db = client.$extends(policy).$as({ userId: 1 });
      // `comments` reads `rt1_comments`, so the write answers in one statement.
      const { traffic, error } = await traced(driver, () =>
        db.post.update({
          where: { id: 10 },
          data: { authorId: 2 },
          include: { comments: true },
        })
      );
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(traffic.statements).toHaveLength(1);
      expect(
        (await client.post.findUnique({ where: { id: 10 } })).authorId
      ).toBe(1);
      // The permitted write, through the same owner, answers with its children.
      const permitted = await traced(driver, () =>
        db.post.update({
          where: { id: 10 },
          data: { title: "mine" },
          include: { comments: { orderBy: { id: "asc" } } },
        })
      );
      expect(permitted.traffic.statements).toHaveLength(1);
      expect(permitted.value).toEqual({
        id: 10,
        title: "mine",
        published: true,
        authorId: 1,
        comments: [
          { id: 100, body: "c100", postId: 10, parentId: null },
          { id: 101, body: "c101", postId: 10, parentId: null },
        ],
      });
    });

    test("a row outside the update domain is the NotFoundError", async () => {
      const driver = make();
      const client = await boot(driver);
      const db = client.$extends(policy).$as({ userId: 1 });
      await expect(
        db.author.update({
          where: { id: 2 },
          data: { name: "x" },
          include: { badges: true },
        })
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await client.author.findUnique({ where: { id: 2 } })).name).toBe(
        "n2"
      );
    });

    test("a projection reading the written table is re-read after the write", async () => {
      const driver = make();
      const client = await boot(driver);
      // Author 3 is its own manager: the nested copy must carry the new name.
      const { traffic, value } = await traced(driver, () =>
        client.author.update({
          where: { id: 3 },
          data: { name: "renamed" },
          include: { manager: true },
        })
      );
      expect(value).toEqual({
        id: 3,
        email: "e3",
        code: "c3",
        name: "renamed",
        managerId: 3,
        manager: {
          id: 3,
          email: "e3",
          code: "c3",
          name: "renamed",
          managerId: 3,
        },
      });
      expect(traffic.statements.length).toBeGreaterThan(1);
    });

    test("a policy reading the written table is judged after the write", async () => {
      const driver = make();
      const client = await boot(driver);
      const db = client.$extends(policy).$as({ userId: 1 });
      // Post 11 is unpublished and visible only while its author is "n1".
      const { traffic, value } = await traced(driver, () =>
        db.author.update({
          where: { id: 1 },
          data: { name: "hidden" },
          include: posts,
        })
      );
      expect(value).toEqual({
        id: 1,
        email: "e1",
        code: "c1",
        name: "hidden",
        managerId: null,
        posts: [{ id: 10, title: "p10", published: true, authorId: 1 }],
      });
      expect(traffic.statements.length).toBeGreaterThan(1);
    });

    test("a rewrite of a referenced key reads the rows its action changed", async () => {
      const driver = make();
      const client = await boot(driver);
      const { traffic, value } = await traced(driver, () =>
        client.author.update({
          where: { id: 1 },
          data: { code: "c9" },
          include: { badges: true },
        })
      );
      expect(value).toMatchObject({
        code: "c9",
        badges: [{ id: 1, label: "b1", authorCode: "c9" }],
      });
      expect(traffic.statements.length).toBeGreaterThan(1);
    });

    test("a nested write keeps its route and the projection sees its rows", async () => {
      const driver = make();
      const client = await boot(driver);
      const { traffic, value } = await traced(driver, () =>
        client.author.update({
          where: { id: 2 },
          data: {
            name: "nested",
            posts: { create: { id: 50, title: "p50", published: false } },
          },
          include: posts,
        })
      );
      expect(value).toEqual({
        id: 2,
        email: "e2",
        code: "c2",
        name: "nested",
        managerId: 1,
        posts: [
          { id: 12, title: "p12", published: true, authorId: 2 },
          { id: 50, title: "p50", published: false, authorId: 2 },
        ],
      });
      expect(traffic.statements.length).toBeGreaterThan(1);
    });

    test("a delete answers with the rows it cascades to, as they were", async () => {
      const driver = make();
      const client = await boot(driver);
      const deleted = await client.author.delete({
        where: { id: 2 },
        include: { posts: true, manager: true },
      });
      expect(deleted).toEqual({
        id: 2,
        email: "e2",
        code: "c2",
        name: "n2",
        managerId: 1,
        posts: [{ id: 12, title: "p12", published: true, authorId: 2 }],
        manager: {
          id: 1,
          email: "e1",
          code: "c1",
          name: "n1",
          managerId: null,
        },
      });
      expect(await client.post.findUnique({ where: { id: 12 } })).toBeNull();
    });

    test("inside a callback transaction it is one statement, and a miss leaves the transaction usable", async () => {
      const driver = make();
      const client = await boot(driver);
      const { traffic, value } = await traced<{
        missed: unknown;
        updated: unknown;
      }>(driver, () =>
        client.$transaction(async (tx: Client) => {
          let missed: unknown;
          try {
            await tx.author.update({
              where: { id: 99 },
              data: { name: "ghost" },
              include: posts,
            });
          } catch (error) {
            missed = error;
          }
          const updated = await tx.author.update({
            where: { id: 1 },
            data: { name: "inside" },
            include: { badges: true },
          });
          return { missed, updated };
        })
      );
      expect(value?.missed).toBeInstanceOf(NotFoundError);
      expect(value?.updated).toMatchObject({
        name: "inside",
        badges: [{ id: 1, label: "b1", authorCode: "c1" }],
      });
      // Two writes, one statement each: no savepoint around either.
      expect(traffic.statements.filter((sql) => SAVEPOINT.test(sql))).toEqual(
        []
      );
    });
  });

test("a projection repeating a relation body: PostgreSQL shares it inside the fold, a RETURNING keeps the re-read", async () => {
  // The same body twice — the include's filter and the `_count`'s — is stated
  // once in a `WITH` where the transport shares bodies (PostgreSQL by default,
  // D1). A data-modifying `WITH` has room for it (a derived table); a
  // `RETURNING` has none, so that write keeps its re-read.
  const repeated = { comments: { some: { body: "c100" } } };
  const args = {
    where: { id: 1 },
    data: { name: "shared" },
    select: {
      id: true,
      posts: { where: repeated, select: { id: true } },
      _count: { select: { posts: { where: repeated } } },
    },
  };
  const expected = { id: 1, posts: [{ id: 10 }], _count: { posts: 1 } };
  const shared = new RecordingSQLite3();
  shared.adapter.capabilities.sharesRelationBodies = true;
  for (const [driver, statements] of [
    [pglite(), 1],
    [shared, 3],
  ] as const) {
    const client = await boot(driver);
    const { traffic, value } = await traced(driver, () =>
      client.author.update(args)
    );
    expect(value).toEqual(expected);
    expect(traffic.statements).toHaveLength(statements);
    expect(traffic.statements.some((sql) => SHARED_BODY.test(sql))).toBe(true);
  }
});

test("a batch-only transport packages an array of writes answering relations", async () => {
  // 1.3.3 refused this array: its located route issues a planning read, which
  // an array package cannot. One folded statement per write is packageable.
  for (const make of [pgliteBatch, () => new BatchOnlyRecordingSQLite3()]) {
    const driver = make();
    const client = await boot(driver);
    const { traffic, value } = await traced(driver, () =>
      client.$transaction([
        client.author.update({
          where: { id: 1 },
          data: { name: "arr" },
          include: { badges: true },
        }),
        client.post.update({
          where: { id: 12 },
          data: { title: "arr" },
          include: { author: true },
        }),
      ])
    );
    expect(value).toEqual([
      {
        id: 1,
        email: "e1",
        code: "c1",
        name: "arr",
        managerId: null,
        badges: [{ id: 1, label: "b1", authorCode: "c1" }],
      },
      {
        id: 12,
        title: "arr",
        published: true,
        authorId: 2,
        author: { id: 2, email: "e2", code: "c2", name: "n2", managerId: 1 },
      },
    ]);
    expect(traffic.batches).toBe(1);
  }
});
