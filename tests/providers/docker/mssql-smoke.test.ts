/**
 * SQL Server end-to-end smoke: hand-written DDL, the public client over the
 * `mssql` driver. Set MSSQL_TEST_CONNECTION_STRING to run it.
 */

import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const url = process.env.MSSQL_TEST_CONNECTION_STRING;
const describeIf = url ? describe : describe.skip;

const user = s
  .model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
    age: s.int().nullable(),
    active: s.boolean(),
    posts: s.toMany(() => post),
  })
  .map("smoke_users");

const post = s
  .model({
    id: s.int().id().increment(),
    title: s.string(),
    views: s.int(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("smoke_posts");

const schema = { user, post };

const DDL = [
  `IF OBJECT_ID('dbo.smoke_posts') IS NOT NULL DROP TABLE dbo.smoke_posts`,
  `IF OBJECT_ID('dbo.smoke_users') IS NOT NULL DROP TABLE dbo.smoke_users`,
  "CREATE TABLE dbo.smoke_users (id NVARCHAR(450) NOT NULL CONSTRAINT smoke_users_pkey PRIMARY KEY, email NVARCHAR(450) NOT NULL CONSTRAINT smoke_users_email_key UNIQUE, name NVARCHAR(MAX) NOT NULL, age INT NULL, active BIT NOT NULL)",
  "CREATE TABLE dbo.smoke_posts (id INT IDENTITY(1,1) NOT NULL CONSTRAINT smoke_posts_pkey PRIMARY KEY, title NVARCHAR(MAX) NOT NULL, views INT NOT NULL, authorId NVARCHAR(450) NOT NULL CONSTRAINT smoke_posts_author_fkey FOREIGN KEY REFERENCES dbo.smoke_users(id) ON DELETE CASCADE)",
];

describeIf("SQL Server smoke", () => {
  const driver = new MssqlDriver({ databaseUrl: url });
  const client = createClient({ schema, driver });

  beforeAll(async () => {
    for (const statement of DDL) await client.$executeRawUnsafe(statement);
  });
  afterAll(async () => {
    await client.$disconnect();
  });

  test("creates, reads with includes, filters, updates, deletes", async () => {
    const ada = await client.user.create({
      data: {
        email: "ada@example.com",
        name: "Ada",
        age: 36,
        active: true,
        posts: {
          create: [
            { title: "Notes", views: 3 },
            { title: "Engine", views: 9 },
          ],
        },
      },
      include: { posts: { orderBy: { views: "desc" } } },
    });
    expect(ada.posts.map((p) => p.title)).toEqual(["Engine", "Notes"]);
    expect(ada.active).toBe(true);

    await client.user.createMany({
      data: [
        {
          id: "b",
          email: "bob@example.com",
          name: "Bob",
          age: null,
          active: false,
        },
        {
          id: "c",
          email: "cy@example.com",
          name: "cyril",
          age: 20,
          active: true,
        },
      ],
    });

    const found = await client.user.findMany({
      where: { name: { contains: "y", mode: "insensitive" } },
      orderBy: { name: "asc" },
      select: { name: true, _count: { select: { posts: true } } },
    });
    expect(found).toEqual([{ name: "cyril", _count: { posts: 0 } }]);

    const page = await client.user.findMany({
      orderBy: { email: "asc" },
      skip: 1,
      take: 1,
      select: { email: true },
    });
    expect(page).toEqual([{ email: "bob@example.com" }]);

    const first = await client.user.findFirst({ where: { active: false } });
    expect(first?.name).toBe("Bob");

    const updated = await client.user.update({
      where: { email: "bob@example.com" },
      data: { age: { increment: 1 }, name: "Bobby" },
    });
    expect(updated).toMatchObject({ name: "Bobby", age: null });

    const posts = await client.post.findMany({
      where: { author: { is: { email: "ada@example.com" } } },
      include: { author: { select: { name: true } } },
      orderBy: { id: "asc" },
    });
    expect(posts.map((p) => [p.title, p.author.name])).toEqual([
      ["Notes", "Ada"],
      ["Engine", "Ada"],
    ]);

    const aggregate = await client.post.aggregate({
      _sum: { views: true },
      _avg: { views: true },
      _count: true,
    });
    expect(aggregate).toMatchObject({
      _sum: { views: 12 },
      _avg: { views: 6 },
      _count: 2,
    });

    const grouped = await client.post.groupBy({
      by: ["authorId"],
      _count: { _all: true },
    });
    expect(grouped).toHaveLength(1);

    const upserted = await client.user.upsert({
      where: { email: "dee@example.com" },
      create: { id: "d", email: "dee@example.com", name: "Dee", active: true },
      update: { name: "never" },
    });
    expect(upserted.name).toBe("Dee");

    expect(await client.user.count()).toBe(4);
    const deleted = await client.user.deleteMany({ where: { active: true } });
    expect(deleted.count).toBe(3);
    expect(await client.post.count()).toBe(0);

    await client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: "b" }, data: { active: true } });
    });
    expect((await client.user.findUnique({ where: { id: "b" } }))?.active).toBe(
      true
    );
  });
});
