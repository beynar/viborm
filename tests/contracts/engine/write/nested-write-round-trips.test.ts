/**
 * A nested write's root record answering the operation's result out of its own
 * INSERT or UPDATE (`CommandExecution.complete`, `StatementAnswer`).
 *
 * 1.4.0 ended every nested `create` and `update` with a read of the root row by
 * its key, after the children ran. Where nothing written after the root's own
 * statement can change that row, its `RETURNING` already holds the answer, and
 * the read is one round trip spent for nothing. It is kept where a later write
 * may change the row: one naming the root's own model (a self-relation), one
 * deleting or rewriting a row the root reaches through the foreign keys it
 * holds, a relation projection (it reads the children), a provider without
 * RETURNING, and the batch route (its read rides the batch already).
 */

import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NestedWriteError, NotFoundError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { beforeAll, describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    name: s.string(),
    managerId: s.int().nullable(),
    manager: s
      .toOne(() => user)
      .fields("managerId")
      .references("id"),
    reports: s.toMany(() => user),
    posts: s.toMany(() => post).name("authored"),
    reviewed: s.toMany(() => post).name("reviewed"),
    ownedTags: s.toMany(() => tag),
  })
  .map("nwrt_users");
const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s
      .toOne(() => user)
      .name("authored")
      .fields("authorId")
      .references("id")
      .onDelete("setNull"),
    reviewerId: s.int().nullable(),
    reviewer: s
      .toOne(() => user)
      .name("reviewed")
      .fields("reviewerId")
      .references("id")
      .onDelete("cascade"),
    tags: s.toMany(() => tag),
    notes: s.toMany(() => note),
  })
  .map("nwrt_posts");
const tag = s
  .model({
    id: s.int().id(),
    name: s.string().unique(),
    posts: s.toMany(() => post),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => user)
      .fields("ownerId")
      .references("id")
      .onDelete("setNull"),
    notes: s.toMany(() => note),
  })
  .map("nwrt_tags");
const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    postId: s.int().nullable(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id")
      .onDelete("setNull"),
    tags: s.toMany(() => tag),
  })
  .map("nwrt_notes");
const schema = { user, post, tag, note };

/** Tags whose posts carry the "secret" tag are hidden from related reads. */
const hiddenBesideSecret = {
  name: "test.nwrt",
  rows: {
    control: "visibility",
    default: "beside",
    models: {
      tag: {
        beside: {
          related: { posts: { none: { tags: { some: { name: "secret" } } } } },
        },
      },
    },
  },
} as const;

/** A post moves to another author only where its title is not "locked". */
const lockedStays = {
  name: "test.nwrt.moves",
  rows: {
    control: "moves",
    default: "all",
    models: {},
    verbs: {
      post: {
        predicates: { any: {}, open: { title: { not: "locked" } } },
        read: "any",
        update: "any",
        delete: "any",
        place: "any",
        moves: { authorId: "open" },
      },
    },
  },
} as const;

beforeAll(() => hydrateSchemaNames(schema));
const getFamily = usePGliteSchemaFamily(schema);

interface Recording {
  statements: string[] | undefined;
}

class RecordingPGlite extends PGliteDriver implements Recording {
  statements: string[] | undefined;
  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements?.push(sql);
    return super.execute<T>(client, sql, params, context);
  }
}
class RecordingSQLite3 extends SQLite3Driver implements Recording {
  statements: string[] | undefined;
  constructor() {
    super({ dataDir: ":memory:" });
  }
  protected override execute<T>(
    client: Database.Database,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements?.push(sql);
    return super.execute<T>(client, sql, params, context);
  }
}
/**
 * The batch route (D1's profile): no interactive transaction, a native batch
 * per unit. `trips` counts round trips: a lone statement or a whole batch.
 */
class BatchRecordingSQLite3 extends RecordingSQLite3 {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  trips = 0;
  #batching = false;
  protected override execute<T>(
    client: Database.Database,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (!this.#batching) this.trips++;
    return super.execute<T>(client, sql, params, context);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.trips++;
    this.#batching = true;
    client.exec("BEGIN");
    try {
      const results = await super.executeBatch<T>(client, queries);
      client.exec("COMMIT");
      return results;
    } catch (error) {
      client.exec("ROLLBACK");
      throw error;
    } finally {
      this.#batching = false;
    }
  }
}
/** MySQL's capability profile on SQLite: no RETURNING. */
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
  await client.user.createMany({
    data: [
      { id: 1, email: "e1", name: "n1" },
      { id: 2, email: "e2", name: "n2", managerId: 1 },
    ],
  });
  await client.tag.createMany({
    data: [
      { id: 1, name: "t1", ownerId: 1 },
      { id: 2, name: "t2" },
    ],
  });
  await client.post.createMany({
    data: [
      { id: 10, title: "p10", authorId: 1 },
      { id: 11, title: "p11", authorId: 2 },
    ],
  });
  return client;
}

async function traced(
  driver: Driver,
  run: () => Promise<unknown>
): Promise<{ statements: string[]; value: unknown }> {
  const statements: string[] = [];
  driver.statements = statements;
  try {
    return { statements, value: await run() };
  } finally {
    driver.statements = undefined;
  }
}

/** Whether the operation ended with a read: the re-read of its root row. */
const endsWithRead = (statements: readonly string[]) =>
  statements.at(-1)!.trimStart().startsWith("SELECT");

/** Whether a statement writes `nwrt_posts`. */
const updatesPosts = (statement: string) =>
  statement.trimStart().startsWith("UPDATE") &&
  statement.includes('"nwrt_posts"');

/** Each post's id and author, in id order. */
const authors = async (client: Client) =>
  (await client.post.findMany({ orderBy: { id: "asc" } })).map(
    (row: { id: number; authorId: number | null }) => [row.id, row.authorId]
  );

const SUBSTRATES = [
  [
    "PGlite",
    () => {
      const family = getFamily();
      return new RecordingPGlite({
        client: family.database,
        namespace: family.namespace,
      });
    },
  ],
  ["SQLite3", () => new RecordingSQLite3()],
] as const;

describe.each(SUBSTRATES)("%s", (name, make) => {
  test("a nested create answers its root out of the root INSERT", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements, value } = await traced(driver, () =>
      client.user.create({
        data: {
          id: 7,
          email: "e7",
          name: "n7",
          posts: { create: [{ id: 70, title: "a" }] },
        },
      })
    );
    expect(value).toEqual({ id: 7, email: "e7", name: "n7", managerId: null });
    expect(endsWithRead(statements)).toBe(false);
    expect(statements).toHaveLength(2);
  });

  test("a nested update answers its root out of the root UPDATE", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements, value } = await traced(driver, () =>
      client.post.update({
        where: { id: 10 },
        data: { title: "u", tags: { connect: [{ id: 1 }, { id: 2 }] } },
        select: { id: true, title: true },
      })
    );
    expect(value).toEqual({ id: 10, title: "u" });
    expect(endsWithRead(statements)).toBe(false);
    expect(await client.post.findUnique({ where: { id: 10 } })).toEqual({
      id: 10,
      title: "u",
      authorId: 1,
      reviewerId: null,
    });
  });

  test("a nested update locates its root in the root UPDATE: no locking read first", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements, value } = await traced(driver, () =>
      client.user.update({
        where: { email: "e2" },
        data: { name: "m", posts: { create: { id: 30, title: "q" } } },
      })
    );
    expect(value).toEqual({ id: 2, email: "e2", name: "m", managerId: 1 });
    expect(statements).toHaveLength(2);
    expect(statements[0]?.trimStart().startsWith("UPDATE")).toBe(true);
    expect(await client.post.findUnique({ where: { id: 30 } })).toMatchObject({
      authorId: 2,
    });
  });

  // PostgreSQL's probe locks the row it finds, so nothing confirms it;
  // SQLite takes no row lock and confirms it (`Selection.probesUnlocked`).
  test("a found connectOrCreate confirms its target only where the probe holds nothing", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements, value } = await traced(driver, () =>
      client.post.create({
        data: {
          id: 40,
          title: "r",
          author: {
            connectOrCreate: {
              where: { email: "e1" },
              create: { id: 9, email: "e1", name: "x" },
            },
          },
        },
      })
    );
    expect(value).toEqual({
      id: 40,
      title: "r",
      authorId: 1,
      reviewerId: null,
    });
    expect(
      statements.filter((sql) => sql.includes('"nwrt_users"'))
    ).toHaveLength(name === "PGlite" ? 1 : 2);
  });

  test("a nested update of a missing root fails as the locating read did, writing nothing", async () => {
    const driver = make();
    const client = await boot(driver);
    await expect(
      client.user.update({
        where: { id: 99 },
        data: { name: "m", posts: { create: { id: 31, title: "q" } } },
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await client.post.findUnique({ where: { id: 31 } })).toBeNull();
  });

  // `CommandExecution.prefetch` and `linkTogether`: the targets of a to-many
  // `connect` are one read, and their junction rows one INSERT.
  test("a to-many connect reads its targets once and links them in one INSERT", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements } = await traced(driver, () =>
      client.post.create({
        data: { id: 41, title: "c", tags: { connect: [{ id: 1 }, { id: 2 }] } },
      })
    );
    expect(
      statements.filter((sql) => sql.includes('"nwrt_tags"'))
    ).toHaveLength(1);
    expect(
      statements.filter((sql) => sql.trimStart().startsWith("INSERT"))
    ).toHaveLength(2);
    expect(
      await client.post.findUnique({
        where: { id: 41 },
        select: { tags: { select: { id: true } } },
      })
    ).toEqual({ tags: [{ id: 1 }, { id: 2 }] });
  });

  test("a to-many set reads its targets once and links them in one INSERT", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.post.update({
      where: { id: 10 },
      data: { tags: { connect: [{ id: 1 }] } },
    });
    const { statements } = await traced(driver, () =>
      client.post.update({
        where: { id: 10 },
        data: { title: "s", tags: { set: [{ id: 2 }, { id: 1 }] } },
      })
    );
    expect(
      statements.filter((sql) => sql.includes('"nwrt_tags"'))
    ).toHaveLength(1);
    expect(
      statements.filter((sql) => sql.trimStart().startsWith("INSERT"))
    ).toHaveLength(1);
    expect(
      await client.post.findUnique({
        where: { id: 10 },
        select: { tags: { select: { id: true } } },
      })
    ).toEqual({ tags: [{ id: 1 }, { id: 2 }] });
  });

  test("a to-many connect naming a missing target fails as each read did, writing nothing", async () => {
    const driver = make();
    const client = await boot(driver);
    await expect(
      client.post.create({
        data: {
          id: 42,
          title: "m",
          tags: { connect: [{ id: 1 }, { id: 99 }, { id: 2 }] },
        },
      })
    ).rejects.toBeInstanceOf(NestedWriteError);
    expect(await client.post.findUnique({ where: { id: 42 } })).toBeNull();
  });

  // The membership is not in the selector, so the run's read cannot state
  // it: post 11 is user 2's, and the update must not reach it.
  test("a to-many update through a membership does not read its targets together", async () => {
    const driver = make();
    const client = await boot(driver);
    await expect(
      client.user.update({
        where: { id: 1 },
        data: {
          posts: {
            update: [
              { where: { id: 10 }, data: { title: "a" } },
              { where: { id: 11 }, data: { title: "b" } },
            ],
          },
        },
      })
    ).rejects.toBeInstanceOf(NestedWriteError);
    expect(await client.post.findMany({ orderBy: { id: "asc" } })).toEqual([
      { id: 10, title: "p10", authorId: 1, reviewerId: null },
      { id: 11, title: "p11", authorId: 2, reviewerId: null },
    ]);
  });

  // The second target's scope reads the junction row the first link writes
  // (`dependent`, N1): tag 2 is hidden once a post it is on carries the
  // secret tag, which the first link gives post 10. Read ahead of that link
  // it would still be visible, and be linked.
  test("a target whose scope reads an earlier link of the same write reads after it", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.tag.create({ data: { id: 3, name: "secret" } });
    await client.post.update({
      where: { id: 10 },
      data: { tags: { connect: [{ id: 2 }] } },
    });
    const scoped = client.$extends(hiddenBesideSecret);
    await expect(
      scoped.post.update({
        where: { id: 10 },
        data: { tags: { connect: [{ id: 3 }, { id: 2 }] } },
      })
    ).rejects.toBeInstanceOf(NestedWriteError);
    expect(
      await client.post.findUnique({
        where: { id: 10 },
        select: { tags: { select: { id: true } } },
      })
    ).toEqual({ tags: [{ id: 2 }] });
  });

  // A miss is a connectOrCreate's ordinary answer, and a run's read with a
  // miss binds nothing: its probes read alone.
  test("a to-many connectOrCreate probes each target once", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements } = await traced(driver, () =>
      client.post.create({
        data: {
          id: 43,
          title: "o",
          tags: {
            connectOrCreate: [
              { where: { name: "t1" }, create: { id: 5, name: "t1" } },
              { where: { name: "t9" }, create: { id: 6, name: "t9" } },
            ],
          },
        },
      })
    );
    expect(
      statements.filter(
        (sql) =>
          sql.trimStart().startsWith("SELECT") && sql.includes('"nwrt_tags"')
      )
    ).toHaveLength(name === "PGlite" ? 2 : 3);
  });

  // `CommandExecution.updateTogether`: targets holding the key are each
  // rewritten by the same UPDATE, so they share one.
  test("a to-many connect of targets holding the key rewrites them in one UPDATE", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.post.create({ data: { id: 12, title: "p12" } });
    const { statements } = await traced(driver, () =>
      client.user.update({
        where: { id: 2 },
        data: { posts: { connect: [{ id: 10 }, { id: 12 }] } },
      })
    );
    expect(statements.filter(updatesPosts)).toHaveLength(1);
    expect(await authors(client)).toEqual([
      [10, 2],
      [11, 2],
      [12, 2],
    ]);
  });

  test("a to-many set of targets holding the key rewrites them in one UPDATE", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.post.create({ data: { id: 12, title: "p12" } });
    const { statements } = await traced(driver, () =>
      client.user.update({
        where: { id: 2 },
        data: { posts: { set: [{ id: 10 }, { id: 12 }] } },
      })
    );
    // The disconnect of post 11, then the two targets.
    expect(statements.filter(updatesPosts)).toHaveLength(2);
    expect(await authors(client)).toEqual([
      [10, 2],
      [11, null],
      [12, 2],
    ]);
  });

  // Two relations to one model read their targets in one run, but each
  // writes its own key: one UPDATE never writes both.
  test("targets of two relations to one model each take their own key", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.post.createMany({
      data: [
        { id: 12, title: "p12" },
        { id: 13, title: "p13" },
      ],
    });
    await client.user.update({
      where: { id: 2 },
      data: {
        posts: { connect: [{ id: 10 }, { id: 12 }] },
        reviewed: { connect: [{ id: 11 }, { id: 13 }] },
      },
    });
    expect(
      (await client.post.findMany({ orderBy: { id: "asc" } })).map(
        (row: {
          id: number;
          authorId: number | null;
          reviewerId: number | null;
        }) => [row.id, row.authorId, row.reviewerId]
      )
    ).toEqual([
      [10, 2, null],
      [11, 2, 2],
      [12, 2, null],
      [13, null, 2],
    ]);
  });

  // A to-many upsert's found arm requires its target to be a member: the
  // shared UPDATE is not taken where that requirement is still to confirm.
  test("a to-many upsert of a target another holder owns fails, writing nothing", async () => {
    const driver = make();
    const client = await boot(driver);
    await expect(
      client.user.update({
        where: { id: 1 },
        data: {
          posts: {
            upsert: [10, 11].map((id) => ({
              where: { id },
              create: { id: id + 50, title: "new" },
              update: { title: "x" },
            })),
          },
        },
      })
    ).rejects.toBeInstanceOf(NestedWriteError);
    expect(
      (await client.post.findMany({ orderBy: { id: "asc" } })).map(
        (row: { title: string }) => row.title
      )
    ).toEqual(["p10", "p11"]);
  });

  // The shared UPDATE judges each row it produces as that row's own did:
  // post 12 may not move, so the set fails and moves nothing.
  test("a shared UPDATE refusing one produced row refuses the write", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.post.create({ data: { id: 12, title: "locked" } });
    const scoped = client.$extends(lockedStays);
    await expect(
      scoped.user.update({
        where: { id: 2 },
        data: { posts: { set: [{ id: 10 }, { id: 12 }] } },
      })
    ).rejects.toBeInstanceOf(NestedWriteError);
    expect(await authors(client)).toEqual([
      [10, 1],
      [11, 2],
      [12, null],
    ]);
    await scoped.post.update({ where: { id: 12 }, data: { title: "free" } });
    await scoped.user.update({
      where: { id: 2 },
      data: { posts: { set: [{ id: 10 }, { id: 12 }] } },
    });
    expect(await authors(client)).toEqual([
      [10, 2],
      [11, null],
      [12, 2],
    ]);
  });

  test("a later write that changes the root row keeps the re-read, and the answer shows it", async () => {
    const driver = make();
    const client = await boot(driver);
    // The report's manager IS the root: the nested update rewrites the root
    // row after the root's own UPDATE ran.
    const { statements, value } = await traced(driver, () =>
      client.user.update({
        where: { id: 1 },
        data: {
          name: "first",
          reports: {
            update: {
              where: { id: 2 },
              data: { manager: { update: { name: "second" } } },
            },
          },
        },
      })
    );
    expect(value).toMatchObject({ id: 1, name: "second" });
    expect(endsWithRead(statements)).toBe(true);
  });

  test("a later delete reaching the root through its foreign key keeps the re-read", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.post.update({
      where: { id: 10 },
      data: { tags: { connect: { id: 1 } } },
    });
    // The tag's owner is the post's author: deleting it sets the root post's
    // `authorId` to null after the post's own UPDATE ran.
    const { statements, value } = await traced(driver, () =>
      client.post.update({
        where: { id: 10 },
        data: {
          title: "u",
          tags: {
            update: { where: { id: 1 }, data: { owner: { delete: true } } },
          },
        },
      })
    );
    expect(value).toEqual({
      id: 10,
      title: "u",
      authorId: null,
      reviewerId: null,
    });
    expect(endsWithRead(statements)).toBe(true);
  });

  test("a later delete reaching the root through two foreign keys keeps the re-read", async () => {
    const driver = make();
    const client = await boot(driver);
    await client.post.update({ where: { id: 11 }, data: { reviewerId: 2 } });
    await client.tag.update({ where: { id: 2 }, data: { ownerId: 2 } });
    await client.note.create({
      data: { id: 1, body: "n", postId: 11, tags: { connect: { id: 2 } } },
    });
    // Deleting the tag's owner deletes the post it reviews, which sets the
    // root note's `postId` to null after the note's own UPDATE ran.
    const { statements, value } = await traced(driver, () =>
      client.note.update({
        where: { id: 1 },
        data: {
          body: "m",
          tags: {
            update: { where: { id: 2 }, data: { owner: { delete: true } } },
          },
        },
      })
    );
    expect(value).toEqual({ id: 1, body: "m", postId: null });
    expect(endsWithRead(statements)).toBe(true);
  });

  test("a relation projection keeps the re-read: it reads the children", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements, value } = await traced(driver, () =>
      client.user.create({
        data: {
          id: 8,
          email: "e8",
          name: "n8",
          posts: { create: { id: 80, title: "b" } },
        },
        include: { posts: true },
      })
    );
    expect(value).toMatchObject({
      id: 8,
      posts: [{ id: 80, title: "b", authorId: 8 }],
    });
    expect(endsWithRead(statements)).toBe(true);
  });

  test("an update writing no column issues no UPDATE to answer, and reads", async () => {
    const driver = make();
    const client = await boot(driver);
    const { statements, value } = await traced(driver, () =>
      client.user.update({
        where: { id: 2 },
        data: { posts: { create: { id: 90, title: "c" } } },
      })
    );
    expect(value).toEqual({ id: 2, email: "e2", name: "n2", managerId: 1 });
    expect(endsWithRead(statements)).toBe(true);
  });
});

test("a provider whose locking miss takes a lock probes unlocked and confirms what it finds", async () => {
  const family = getFamily();
  const driver = new RecordingPGlite({
    client: family.database,
    namespace: family.namespace,
  });
  driver.adapter.capabilities.locksMissingKeys = true;
  const client = await boot(driver);
  const { statements } = await traced(driver, () =>
    client.post.create({
      data: {
        id: 41,
        title: "r",
        author: {
          connectOrCreate: {
            where: { email: "e1" },
            create: { id: 9, email: "e1", name: "x" },
          },
        },
      },
    })
  );
  expect(statements.filter((sql) => sql.includes('"nwrt_users"'))).toHaveLength(
    2
  );
});

// A singular polymorphic member is a TRANSFER: each link vacates the slot's
// captured owner first, which one shared INSERT would not. A `set` places
// those links side by side.
test("a to-many set of members another holder owns moves each of them", async () => {
  const book = s
    .model({
      id: s.string().id(),
      title: s.string(),
      shelf: s.toOne(() => shelf),
    })
    .map("nwrt_books");
  const shelf = s
    .model({
      id: s.string().id(),
      items: s
        .toMany({ book: () => book }, { values: { book: "book" } })
        .through({
          book: { table: "nwrt_members", source: "holder", target: "entry" },
        }),
    })
    .map("nwrt_shelves");
  const shelves = { shelf, book };
  hydrateSchemaNames(shelves);
  const client: Client = createClient({
    schema: shelves,
    driver: new RecordingSQLite3(),
  });
  await syncLiveSchema(client);
  const items = [
    { type: "book", where: { id: "b1" } },
    { type: "book", where: { id: "b2" } },
  ];
  await client.book.createMany({
    data: [
      { id: "b1", title: "one" },
      { id: "b2", title: "two" },
    ],
  });
  await client.shelf.create({ data: { id: "s1", items: { connect: items } } });
  await client.shelf.create({ data: { id: "s2" } });
  await client.shelf.update({
    where: { id: "s2" },
    data: { items: { set: items } },
  });
  for (const id of ["b1", "b2"])
    expect(
      await client.book.findUnique({
        where: { id },
        select: { shelf: { select: { id: true } } },
      })
    ).toEqual({ shelf: { id: "s2" } });
});

// The batch route reads the targets once too, outside its one batch.
test("on the batch route a to-many connect reads its targets once", async () => {
  const driver = new BatchRecordingSQLite3();
  const client = await boot(driver);
  driver.trips = 0;
  await client.post.create({
    data: { id: 45, title: "b", tags: { connect: [{ id: 1 }, { id: 2 }] } },
  });
  expect(driver.trips).toBe(2);
  expect(
    await client.post.findUnique({
      where: { id: 45 },
      select: { tags: { select: { id: true } } },
    })
  ).toEqual({ tags: [{ id: 1 }, { id: 2 }] });
});

test("on the batch route an update reads its root and its targets in one batch", async () => {
  const driver = new BatchRecordingSQLite3();
  const client = await boot(driver);
  driver.trips = 0;
  await client.post.update({
    where: { id: 10 },
    data: { title: "b", tags: { connect: [{ id: 1 }, { id: 2 }] } },
  });
  expect(driver.trips).toBe(2);
  expect(
    await client.post.findUnique({
      where: { id: 10 },
      select: { title: true, tags: { select: { id: true } } },
    })
  ).toEqual({ title: "b", tags: [{ id: 1 }, { id: 2 }] });
});

// D1 counts every statement of a batch. The batch of reads takes the targets
// in one statement, and their links go as one INSERT (`#readTogether`,
// `#bindHeld`), where 1.4.0 sent one SELECT and one INSERT per target.
test("on the batch route an update's targets share one read and one INSERT", async () => {
  const driver = new BatchRecordingSQLite3();
  const client = await boot(driver);
  await client.tag.create({ data: { id: 3, name: "t3" } });
  const { statements } = await traced(driver, () =>
    client.post.update({
      where: { id: 10 },
      data: {
        title: "b",
        tags: { connect: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      },
    })
  );
  expect(
    statements.filter(
      (sql) =>
        sql.trimStart().startsWith("SELECT") && sql.includes('FROM "nwrt_tags"')
    )
  ).toHaveLength(1);
  expect(
    statements.filter((sql) => sql.trimStart().startsWith("INSERT"))
  ).toHaveLength(1);
  expect(
    await client.post.findUnique({
      where: { id: 10 },
      select: { tags: { select: { id: true } } },
    })
  ).toEqual({ tags: [{ id: 1 }, { id: 2 }, { id: 3 }] });
});

test("on the batch route a target missing from the batch of reads fails as its own read did, writing nothing", async () => {
  const driver = new BatchRecordingSQLite3();
  const client = await boot(driver);
  await expect(
    client.post.update({
      where: { id: 10 },
      data: { title: "b", tags: { connect: [{ id: 1 }, { id: 3 }] } },
    })
  ).rejects.toThrow("connect");
  expect(
    await client.post.findUnique({
      where: { id: 10 },
      select: { title: true, tags: { select: { id: true } } },
    })
  ).toEqual({ title: "p10", tags: [] });
});

test("a provider without RETURNING keeps the re-read", async () => {
  const driver = new NonReturningRecordingSQLite3();
  const client = await boot(driver);
  const { statements, value } = await traced(driver, () =>
    client.user.create({
      data: {
        id: 9,
        email: "e9",
        name: "n9",
        posts: { create: { id: 91, title: "d" } },
      },
    })
  );
  expect(value).toEqual({ id: 9, email: "e9", name: "n9", managerId: null });
  expect(endsWithRead(statements)).toBe(true);
});
