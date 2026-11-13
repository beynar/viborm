/**
 * The SQL of a judged update on SQLite, pinned. A judged update lowers its
 * candidates and its guard, each minting aliases in turn; a dialect with
 * `assertions.keptWhere` (SQL Server) needs its candidates first, every
 * other dialect keeps the order it always had. This text is main's,
 * byte for byte.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { Sql } from "@sql";
import { permissions } from "@src/permissions";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { expect, test } from "vitest";

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
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");

test("a judged update whose filter walks a relation keeps main's aliases", async () => {
  const statements: string[] = [];
  const base = createClient({
    schema: { user, post },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(base);
  await base.user.createMany({
    data: [
      { id: "ada", name: "Ada" },
      { id: "bob", name: "Bob" },
    ],
  });
  await base.post.createMany({
    data: [
      { id: 1, title: "one", authorId: "ada" },
      { id: 2, title: "two", authorId: "bob" },
    ],
  });
  const captured = base.$extends({
    name: "capture",
    statement: ({ statement }: { statement: Sql }) => {
      statements.push(Sql.peek(statement).strings.join("?"));
      return statement;
    },
  });
  const db = permissions({
    actor: v.object({ userId: v.string() }),
    models: {
      user: { read: true },
      post: { read: true, update: { authorId: { actor: "userId" } } },
    },
  })(captured).$as({ userId: "ada" });
  expect(
    await db.post.updateMany({
      where: { author: { is: { name: "Ada" } } },
      data: { authorId: "ada" },
    })
  ).toEqual({ count: 1 });
  const update = statements.find((text) => text.startsWith("UPDATE"));
  expect(update).toMatchInlineSnapshot(
    `"UPDATE "posts" SET "authorId" = ? WHERE "posts"."id" IN (SELECT "q0"."id" FROM "posts" AS "q0" WHERE (EXISTS (SELECT 1 FROM "users" AS "q4" WHERE (("q0"."authorId" = "q4"."id" AND 1) AND "q4"."name" COLLATE BINARY = ?)) AND "q0"."authorId" COLLATE BINARY = ?) GROUP BY "q0"."id" HAVING MIN((SELECT CASE WHEN ("q1"."authorId" COLLATE BINARY = ? AND EXISTS (SELECT 1 FROM "users" AS "q3" WHERE ("q1"."authorId" = "q3"."id" AND 1))) THEN 1 ELSE json_extract('{}', '__viborm_refused__') END AS "__viborm_judged__" FROM (SELECT "q2"."id", "q2"."title", "q2"."authorId" FROM "posts" AS "q2" WHERE 0 UNION ALL VALUES ("q0"."id", "q0"."title", ?)) AS "q1")) = 1)"`
  );
  await base.$disconnect();
});
