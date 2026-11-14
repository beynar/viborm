/**
 * SQL Server: a judged update judges the rows it writes and no other. T-SQL
 * aggregates no subquery, so the guard is not `HAVING MIN(guard) = 1` per
 * key as elsewhere but `CASE WHEN kept THEN guard END = 1`
 * (`assertions.keptWhere`): the rows a filter does not keep must never
 * reach the guard, whose refusal is an error, however the plan reads them.
 * Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { ForbiddenError } from "@errors";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMssqlDriverIn,
  createSchema,
  dropSchema,
  TEST_CONNECTION_STRING,
} from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;
const NAMESPACE = "viborm_judged_writes";

const post = s
  .model({
    id: s.int().id(),
    authorId: s.string(),
    title: s.string(),
    views: s.int(),
  })
  .map("posts");

const base = createClient({
  schema: { post },
  driver: createMssqlDriverIn(NAMESPACE),
});
const db = permissions({
  actor: v.object({ userId: v.string() }),
  models: {
    post: {
      read: true,
      // The new row too: an update may not hand the row to someone else.
      update: { authorId: { actor: "userId" } },
    },
  },
})(base);
const ada = db.$as({ userId: "ada" });

describeIf("SQL Server judges the rows an update writes", () => {
  beforeAll(async () => {
    await createSchema(NAMESPACE);
    await syncLiveSchema(base);
    // One row of Ada's among 3,000 of Bob's, none reachable by an index
    // from the filters below: every row passes through the plan.
    await base.post.createMany({
      data: Array.from({ length: 3001 }, (_, id) => ({
        id,
        authorId: id === 1500 ? "ada" : "bob",
        title: id === 1500 ? "mine" : "theirs",
        views: id,
      })),
    });
  });
  afterAll(async () => {
    await base.$disconnect();
    await dropSchema(NAMESPACE);
  });

  test("an updateMany keeping one row among refused ones writes it, refused by none", async () => {
    expect(
      await ada.post.updateMany({
        where: { title: { contains: "min" }, views: { gte: 0 } },
        data: { views: 1 },
      })
    ).toEqual({ count: 1 });
    expect(
      await ada.post.updateMany({
        where: { title: { endsWith: "ine" } },
        data: { title: "still mine" },
        limit: 1,
      })
    ).toEqual({ count: 1 });
    expect(
      await base.post.findUnique({
        where: { id: 1500 },
        select: { title: true, views: true },
      })
    ).toEqual({ title: "still mine", views: 1 });
    expect(await base.post.count({ where: { title: "theirs" } })).toBe(3000);
  });

  test("an updateMany whose filter keeps none of the actor's rows writes nothing and refuses nothing", async () => {
    // The rule reads `authorId`, which the update writes: each kept row's
    // new image is judged. Bob's rows are not kept (the rule scopes the
    // update to Ada's), and judged, they would be refused.
    expect(
      await ada.post.updateMany({
        where: { authorId: "bob" },
        data: { authorId: "bob" },
      })
    ).toEqual({ count: 0 });
    expect(
      await ada.post.updateMany({
        where: { id: { in: [6, 7] } },
        data: { authorId: "bob" },
      })
    ).toEqual({ count: 0 });
    expect(await base.post.count({ where: { authorId: "ada" } })).toBe(1);
  });

  test("a new row the actor may not write refuses the whole statement", async () => {
    await expect(
      ada.post.updateMany({
        where: { authorId: "ada" },
        data: { authorId: "bob" },
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await base.post.count({ where: { authorId: "ada" } })).toBe(1);
  });
});
