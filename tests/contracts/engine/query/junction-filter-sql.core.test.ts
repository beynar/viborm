import { hydrateSchemaNames, s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const post = s
  .model({
    tenant: s.string(),
    local: s.int(),
    title: s.string(),
    tags: s.toMany(() => tag),
  })
  .id(["tenant", "local"]);
const tag = s.model({
  id: s.int().id(),
  name: s.string().nullable(),
  posts: s.toMany(() => post),
});
const schema = { post, tag };
hydrateSchemaNames(schema);
const engineFor = (dialect: "postgresql" | "sqlite") =>
  new TestQueryEngine(
    new PlanningDriver(dialect),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );

describe("a many-to-many relation filter", () => {
  // SQLite walks the junction from its key per parent row; the membership
  // form rebuilt the junction subquery for every target row it tested.
  test("is the junction joined to its target on SQLite", () => {
    const sqlite = engineFor("sqlite");
    expect(
      sqlite
        .build(post, "findMany", {
          where: { tags: { some: { name: "orm" } } },
          select: { title: true },
        })
        .toStatement("?")
    ).toBe(
      'SELECT "q0"."title" AS "title" FROM "post" AS "q0" WHERE EXISTS (SELECT 1 FROM "post_tag" AS "q2" INNER JOIN "tag" AS "q1" ON "q1"."id" = "q2"."tagId" WHERE (("q2"."post_1" = "q0"."tenant" AND "q2"."post_2" = "q0"."local") AND "q1"."name" COLLATE BINARY = ?)) ORDER BY "q0"."tenant" ASC, "q0"."local" ASC'
    );
    expect(
      sqlite
        .build(tag, "count", { where: { posts: { every: { local: 1 } } } })
        .toStatement("?")
    ).toBe(
      'SELECT COUNT(*) AS "_count" FROM "tag" AS "q0" WHERE NOT EXISTS (SELECT 1 FROM "post_tag" AS "q2" INNER JOIN "post" AS "q1" ON ("q1"."tenant" = "q2"."post_1" AND "q1"."local" = "q2"."post_2") WHERE ("q2"."tagId" = "q0"."id" AND NOT ("q1"."local" = ?)))'
    );
  });

  test("keeps the target's membership in the junction on PostgreSQL", () => {
    expect(
      engineFor("postgresql")
        .build(post, "findMany", {
          where: { tags: { some: { name: "orm" } } },
          select: { title: true },
        })
        .toStatement("$n")
    ).toBe(
      'SELECT "q0"."title" FROM "public"."post" AS "q0" WHERE EXISTS (SELECT 1 FROM "public"."tag" AS "q1" WHERE ("q1"."id" IN (SELECT "q2"."tagId" FROM "public"."post_tag" AS "q2" WHERE ("q2"."post_1" = "q0"."tenant" AND "q2"."post_2" = "q0"."local")) AND "q1"."name" = $1)) ORDER BY "q0"."tenant" ASC, "q0"."local" ASC'
    );
  });
});
