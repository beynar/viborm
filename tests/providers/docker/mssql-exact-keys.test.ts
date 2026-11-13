/**
 * SQL Server: a unique selector and a relation's join compare text exactly,
 * as a filter does. The server pads trailing spaces in `=` and `IN` under
 * every collation, so its unique index holds `"bob"` and `"bob "` as one
 * value and its foreign key accepts a child keyed `"ada "` under a parent
 * `"ada"`; VibORM addresses and joins rows by their exact text.
 * Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import {
  NestedWriteError,
  NotFoundError,
  UniqueConstraintError,
} from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_exact_keys";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("users");
const post = s
  .model({
    id: s.int().id(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
    tags: s.toMany(() => tag),
  })
  .map("posts");
const tag = s
  .model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  })
  .map("tags");

const db = createClient({
  schema: { user, post, tag },
  driver: createMssqlDriverIn(NAMESPACE),
});

/** `sql`'s text, the namespace's tables quoted. */
const inNamespace = (text: string) =>
  sql.raw(text.replaceAll("§", `"${NAMESPACE}".`));

describeIf("SQL Server addresses and joins rows by their exact text", () => {
  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await syncLiveSchema(db);
    await db.user.createMany({
      data: [
        { id: "ada", name: "Ada" },
        { id: "bob ", name: "Bob" },
      ],
    });
    await db.tag.create({ data: { id: "red" } });
    await db.post.create({ data: { id: 2, authorId: "ada" } });
    await db.post.create({
      data: { id: 1, authorId: "ada", tags: { connect: { id: "red" } } },
    });
    // The server's foreign keys accept a padded match: post 1 keyed "ada "
    // under "ada", its link keyed "red " under "red".
    await db.$executeRaw(
      inNamespace(`UPDATE §"posts" SET "authorId" = N'ada ' WHERE "id" = 1`)
    );
    const [junction] = await db.$queryRaw<{ table: string; column: string }>(
      sql`SELECT t.name AS "table", c.name AS "column" FROM sys.tables AS t JOIN sys.columns AS c ON c.object_id = t.object_id WHERE t.schema_id = SCHEMA_ID(${NAMESPACE}) AND t.name NOT IN (N'users', N'posts', N'tags') AND c.system_type_id = 231`
    );
    await db.$executeRaw(
      inNamespace(
        `UPDATE §"${junction!.table}" SET "${junction!.column}" = N'red '`
      )
    );
  });
  afterAll(async () => {
    await db.$disconnect();
    await dropSchema(NAMESPACE);
  });

  test("a unique selector finds only the exact key", async () => {
    expect(await db.user.findUnique({ where: { id: "bob" } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: "bob " } })).toMatchObject({
      name: "Bob",
    });
    await expect(
      db.user.update({ where: { id: "bob" }, data: { name: "changed" } })
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      db.user.delete({ where: { id: "bob" } })
    ).rejects.toBeInstanceOf(NotFoundError);
    // Not found, so created: the server's index refuses "bob" beside "bob ".
    await expect(
      db.user.upsert({
        where: { id: "bob" },
        create: { id: "bob", name: "created" },
        update: { name: "updated" },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    expect(
      await db.user.findMany({ select: { id: true, name: true } })
    ).toEqual([
      { id: "ada", name: "Ada" },
      { id: "bob ", name: "Bob" },
    ]);
  });

  test("connect finds only the exact key", async () => {
    await expect(
      db.post.create({
        data: { id: 3, author: { connect: { id: "bob" } } },
      })
    ).rejects.toBeInstanceOf(NestedWriteError);
    expect(await db.post.count()).toBe(2);
  });

  test("a relation joins only the exact key", async () => {
    expect(
      await db.user.findUnique({
        where: { id: "ada" },
        select: {
          posts: { select: { id: true } },
          _count: { select: { posts: true } },
        },
      })
    ).toEqual({ posts: [{ id: 2 }], _count: { posts: 1 } });
    expect(
      await db.user.findMany({
        where: { posts: { some: { id: 1 } } },
        select: { id: true },
      })
    ).toEqual([]);
    expect(
      await db.post.findMany({
        where: { author: { is: { id: "ada" } } },
        select: { id: true },
      })
    ).toEqual([{ id: 2 }]);
    // The server's foreign key holds post 1 under "ada"; VibORM finds no
    // author keyed "ada ".
    expect(
      await db.post.findUnique({
        where: { id: 1 },
        select: { author: { select: { id: true } } },
      })
    ).toEqual({ author: null });
  });

  test("a cursor's anchor is found only by its exact key", async () => {
    expect(
      await db.user.findMany({
        cursor: { id: "bob" },
        orderBy: { id: "asc" },
        select: { id: true },
      })
    ).toEqual([]);
    expect(
      await db.user.findMany({
        cursor: { id: "bob " },
        orderBy: { id: "asc" },
        select: { id: true },
      })
    ).toEqual([{ id: "bob " }]);
  });

  test("a many-to-many link joins only the exact key", async () => {
    expect(
      await db.post.findUnique({
        where: { id: 1 },
        select: { tags: { select: { id: true } } },
      })
    ).toEqual({ tags: [] });
    expect(
      await db.tag.findMany({
        where: { posts: { some: {} } },
        select: { id: true },
      })
    ).toEqual([]);
  });
});
