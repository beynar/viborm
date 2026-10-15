/**
 * Relation filters on a transport with a shallow expression limit (rbac plan
 * §9.3, provider facts to meet). SQLite counts a subquery's `WHERE` in the
 * height of the expression holding it and again while resolving names, so
 * nested relation filters cost about k² of the limit; Cloudflare D1 compiles
 * with 100 and refused a grant `updateMany` (depth 122) and a nested create
 * (104). A driver that declares `deepExpressions: false` gets every relation
 * filter's rows from a derived table: one statement, the same rows, linear
 * depth. The D1 witnesses are tests/providers/workers/d1-rbac-verbs.test.ts
 * (W-W3, W-W7); this file pins the spelling and the rows on SQLite3, where
 * the default adapter keeps its bytes.
 */

import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { v } from "@src/validation";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const org = s.model({
  id: s.string().id(),
  members: s.toMany(() => member),
  docs: s.toMany(() => doc),
});
const member = s.model({
  id: s.string().id(),
  userId: s.string(),
  orgId: s.string(),
  org: s
    .toOne(() => org)
    .fields("orgId")
    .references("id"),
});
const doc = s.model({
  id: s.string().id(),
  title: s.string(),
  orgId: s.string(),
  org: s
    .toOne(() => org)
    .fields("orgId")
    .references("id"),
});
const schema = { org, member, doc };

/** A document is read where the caller is a member of its organization. */
const inOrg = { org: { members: { some: { userId: { control: "user" } } } } };
const membership = defineExtension({
  name: "membership",
  controls: { user: { schema: v.string(), required: true } },
  rows: {
    control: "scope",
    default: "member",
    models: { doc: { member: { root: inOrg, related: inOrg } } },
  },
});

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

async function open(deepExpressions: boolean) {
  const driver = createInMemorySQLite3Driver();
  // The driver's own adapter, given the spelling a driver declaring the fact
  // gets: a driver overriding one hook changes only its own adapter.
  Object.assign(
    driver.adapter.subqueries,
    new SQLiteAdapter({ deepExpressions }).subqueries
  );
  const base = createClient({ schema, driver });
  clients.push(base);
  await syncLiveSchema(base);
  await base.org.createMany({ data: [{ id: "o1" }, { id: "o2" }] });
  await base.member.createMany({
    data: [
      { id: "m1", userId: "ann", orgId: "o1" },
      { id: "m2", userId: "bob", orgId: "o2" },
      { id: "m3", userId: "ann", orgId: "o2" },
    ],
  });
  await base.doc.createMany({
    data: [
      { id: "d1", title: "a", orgId: "o1" },
      { id: "d2", title: "b", orgId: "o2" },
      { id: "d3", title: "c", orgId: "o1" },
    ],
  });
  const statements: string[] = [];
  const db = base.$extends(membership).$extends({
    name: "statements",
    statement(context) {
      statements.push(context.statement.toStatement());
      return context.statement;
    },
  });
  return { db, statements };
}

describe("relation filters under a shallow expression limit", () => {
  test("a relation filter reads its rows from a derived table, and only where the adapter is told", async () => {
    const shallow = await open(false);
    const deep = await open(true);
    for (const { db } of [shallow, deep])
      await db.doc.findMany({
        user: "ann",
        select: { id: true },
        orderBy: { id: "asc" },
      });
    expect(shallow.statements).toEqual([
      'SELECT "q0"."id" AS "id" FROM "doc" AS "q0" WHERE EXISTS (SELECT 1 FROM (SELECT 1 FROM "org" AS "q1" WHERE ("q0"."orgId" = "q1"."id" AND EXISTS (SELECT 1 FROM (SELECT 1 FROM "member" AS "q2" WHERE ("q1"."id" = "q2"."orgId" AND "q2"."userId" COLLATE BINARY = ?)))))) ORDER BY "q0"."id" ASC',
    ]);
    expect(deep.statements).toEqual([
      'SELECT "q0"."id" AS "id" FROM "doc" AS "q0" WHERE EXISTS (SELECT 1 FROM "org" AS "q1" WHERE ("q0"."orgId" = "q1"."id" AND EXISTS (SELECT 1 FROM "member" AS "q2" WHERE ("q1"."id" = "q2"."orgId" AND "q2"."userId" COLLATE BINARY = ?)))) ORDER BY "q0"."id" ASC',
    ]);
  });

  test("both spellings read, count and write the same rows", async () => {
    const shallow = await open(false);
    const deep = await open(true);
    for (const { db } of [shallow, deep]) {
      expect(
        await db.doc.findMany({
          user: "bob",
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([{ id: "d2" }]);
      expect(
        await db.org.findMany({
          user: "bob",
          select: { id: true, _count: { select: { docs: true } } },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "o1", _count: { docs: 0 } },
        { id: "o2", _count: { docs: 1 } },
      ]);
      expect(
        await db.doc.updateMany({ user: "ann", data: { title: "seen" } })
      ).toEqual({ count: 3 });
      expect(await db.doc.deleteMany({ user: "bob" })).toEqual({ count: 1 });
      expect(
        await db.doc.findMany({
          user: "ann",
          select: { id: true, title: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "d1", title: "seen" },
        { id: "d3", title: "seen" },
      ]);
    }
  });
});
