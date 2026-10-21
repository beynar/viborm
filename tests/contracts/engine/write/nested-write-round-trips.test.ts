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
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
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

describe.each(SUBSTRATES)("%s", (_name, make) => {
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
