import { hydrateSchemaNames, s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  name: s.string().nullable(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  views: s.int(),
  published: s.boolean(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const schema = { author, post };
hydrateSchemaNames(schema);
const engineFor = (dialect: "postgresql" | "mysql" | "sqlite") =>
  new TestQueryEngine(
    new PlanningDriver(dialect),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );

const backwardRelationPage = {
  distinct: ["authorId", "published"],
  orderBy: [{ author: { name: "asc" } }, { views: "desc" }],
  take: -2,
  select: { id: true },
};

describe("distinct is emulated with one window", () => {
  // `_rn` picks each group's representative in the logical order; the page
  // is ordered by the order's terms projected beside it (`_ordN`), presented
  // reversed for a negative take. No second window ranks every row.
  test("a backward page in a joined relation order (PostgreSQL)", () => {
    const statement = engineFor("postgresql").build(
      post,
      "findMany",
      backwardRelationPage
    );
    expect(statement.toStatement("$n")).toBe(
      'SELECT "id" FROM (SELECT "q0"."id", "q1"."name" AS "_ord0", "q0"."views" AS "_ord1", "q0"."id" AS "_ord2", ROW_NUMBER() OVER (PARTITION BY "q0"."authorId", "q0"."published" ORDER BY "q1"."name" ASC NULLS LAST, "q0"."views" DESC, "q0"."id" ASC) AS "_rn" FROM "public"."post" AS "q0" LEFT JOIN "public"."author" AS "q1" ON "q0"."authorId" = "q1"."id") AS "_distinct_subquery" WHERE "_rn" = 1 ORDER BY "_ord0" DESC NULLS FIRST, "_ord1" ASC, "_ord2" DESC LIMIT $1'
    );
    expect(statement.values).toEqual([2]);
  });

  test("the NULL placement reads the projected term (MySQL)", () => {
    expect(
      engineFor("mysql")
        .build(post, "findMany", backwardRelationPage)
        .toStatement("?")
    ).toBe(
      "SELECT `id` FROM (SELECT `q0`.`id`, `q1`.`name` AS `_ord0`, `q0`.`views` AS `_ord1`, `q0`.`id` AS `_ord2`, ROW_NUMBER() OVER (PARTITION BY `q0`.`authorId`, `q0`.`published` ORDER BY (`q1`.`name` IS NULL) ASC, `q1`.`name` ASC, `q0`.`views` DESC, `q0`.`id` ASC) AS `_rn` FROM `post` AS `q0` LEFT JOIN `author` AS `q1` ON `q0`.`authorId` = `q1`.`id`) AS `_distinct_subquery` WHERE `_rn` = 1 ORDER BY (`_ord0` IS NULL) DESC, `_ord0` DESC, `_ord1` ASC, `_ord2` DESC LIMIT 2"
    );
  });

  test("a nested page (SQLite)", () => {
    const statement = engineFor("sqlite").build(author, "findMany", {
      select: {
        id: true,
        posts: {
          distinct: ["published"],
          orderBy: { views: "desc" },
          take: 1,
          select: { id: true },
        },
      },
    });
    expect(statement.toStatement("?")).toBe(
      'SELECT "q0"."id" AS "id", (SELECT json_group_array(json_object(?, "q2"."id")) FROM (SELECT "id" FROM (SELECT "q1"."id" AS "id", "q1"."views" AS "_ord0", "q1"."id" AS "_ord1", ROW_NUMBER() OVER (PARTITION BY "q1"."published" ORDER BY "q1"."views" DESC, "q1"."id" ASC) AS "_rn" FROM "post" AS "q1" WHERE "q0"."id" = "q1"."authorId") AS "_distinct_subquery" WHERE "_rn" = 1 ORDER BY "_ord0" DESC, "_ord1" ASC LIMIT ?) AS "q2") AS "posts" FROM "author" AS "q0" ORDER BY "q0"."id" ASC'
    );
    expect(statement.values).toEqual(["id", 1]);
  });
});
