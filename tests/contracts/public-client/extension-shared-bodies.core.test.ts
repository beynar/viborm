/**
 * Relation bodies a statement repeats, stated once (permissions plan §9.3, provider
 * facts to meet; E5.2). A governed predicate repeats the same relation
 * filter body across its arms: the §1.1 grant move was 261 KB on D1 (limit
 * 100 KB) and the grant read referenced 241 tables on PlanetScale's Neki
 * (limit 256). An adapter declaring `capabilities.sharesRelationBodies`
 * states each repeated body once, in a `WITH`, as the key set every arm
 * testing it reads: `EXISTS (SELECT 1 FROM <set> WHERE set.k = parent.fk)`,
 * a semijoin on the correlated columns. This file pins, on SQLite3:
 *
 * - the spelling: one definition per repeated body, a nested repeated body
 *   defined before the body holding it, a body lowered once left in place;
 * - a statement repeating no body is byte-identical with the fact and
 *   without it, and every adapter without the fact keeps today's bytes;
 * - the rows: reads, counts and writes take the same rows both ways.
 *
 * The provider witnesses are tests/providers/workers/d1-permissions-placement.test.ts
 * (W-P10's grant move) and the Neki entry run (W-R1).
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { createClient } from "@client/client";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { v } from "@src/validation";
import { runSharedBodiesBehavior } from "@tests/contracts/public-client/shared-bodies-behavior";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
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
  role: s.string(),
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

/** The caller's membership of the row's organization: the repeated body. */
const inOrg = { org: { members: { some: { userId: { control: "user" } } } } };
const admin = {
  org: {
    members: { some: { userId: { control: "user" }, role: "admin" } },
  },
};
const policy = defineExtension({
  name: "policy",
  controls: { user: { schema: v.string(), required: true } },
  rows: {
    control: "scope",
    default: "member",
    models: {
      doc: {
        // `inOrg` twice: in each arm, as a policy's arms repeat `mandatory`.
        member: {
          root: {
            OR: [{ AND: [inOrg, { title: "a" }] }, { AND: [inOrg, admin] }],
          },
          related: inOrg,
        },
        // No body repeats.
        single: { root: inOrg, related: inOrg },
      },
    },
  },
});

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

async function open(shared: boolean) {
  const driver = createInMemorySQLite3Driver();
  // The driver's own adapter, given the fact a driver declaring it gets.
  if (shared) driver.adapter.capabilities.sharesRelationBodies = true;
  const base = createClient({ schema, driver });
  clients.push(base);
  await syncLiveSchema(base);
  await base.org.createMany({ data: [{ id: "o1" }, { id: "o2" }] });
  await base.member.createMany({
    data: [
      { id: "m1", userId: "ann", role: "admin", orgId: "o1" },
      { id: "m2", userId: "bob", role: "reader", orgId: "o2" },
      { id: "m3", userId: "ann", role: "reader", orgId: "o2" },
    ],
  });
  await base.doc.createMany({
    data: [
      { id: "d1", title: "a", orgId: "o1" },
      { id: "d2", title: "b", orgId: "o2" },
      { id: "d3", title: "c", orgId: "o1" },
      { id: "d4", title: "a", orgId: "o2" },
    ],
  });
  const statements: string[] = [];
  const db = base.$extends(policy).$extends({
    name: "statements",
    statement(context) {
      statements.push(context.statement.toStatement());
      return context.statement;
    },
  });
  return { db, statements };
}

const MEMBERS =
  'SELECT "q2"."orgId" AS "k0" FROM "member" AS "q2" WHERE "q2"."userId" COLLATE BINARY = ?';

describe("relation bodies a statement repeats, stated once", () => {
  test("each repeated body is one definition its arms test; a nested one comes first; a body lowered once stays in place", async () => {
    const { db, statements } = await open(true);
    await db.doc.findMany({ user: "ann", select: { id: true } });
    expect(statements).toEqual([
      `WITH "__shared_0" AS (${MEMBERS}), "__shared_1" AS MATERIALIZED (SELECT "q1"."id" AS "k0" FROM "org" AS "q1" WHERE EXISTS (SELECT 1 FROM "__shared_0" WHERE "q1"."id" = "__shared_0"."k0")) SELECT "q0"."id" AS "id" FROM "doc" AS "q0" WHERE ((EXISTS (SELECT 1 FROM "__shared_1" WHERE "q0"."orgId" = "__shared_1"."k0") AND "q0"."title" COLLATE BINARY = ?) OR (EXISTS (SELECT 1 FROM "__shared_1" WHERE "q0"."orgId" = "__shared_1"."k0") AND EXISTS (SELECT 1 FROM "org" AS "q5" WHERE ("q0"."orgId" = "q5"."id" AND EXISTS (SELECT 1 FROM "member" AS "q6" WHERE ("q5"."id" = "q6"."orgId" AND ("q6"."userId" COLLATE BINARY = ? AND "q6"."role" COLLATE BINARY = ?))))))) ORDER BY "q0"."id" ASC`,
    ]);
  });

  test("a statement repeating no body is the same bytes with the fact and without it", async () => {
    const shared = await open(true);
    const plain = await open(false);
    for (const { db } of [shared, plain]) {
      await db.doc.findMany({
        user: "ann",
        scope: "single",
        select: { id: true },
      });
      await db.doc.findMany({
        user: "ann",
        scope: "member",
        select: { id: true },
      });
    }
    expect(shared.statements[0]).toBe(plain.statements[0]);
    expect(plain.statements[1]).not.toContain("WITH");
    expect(shared.statements[1]).not.toBe(plain.statements[1]);
  });

  // A write's row lookups are statements of their own (`Queries.select`):
  // an upsert's probe and its located row state the repeated body once.
  test("an upsert's located lookups state the repeated body once, read twice", async () => {
    const shared = await open(true);
    const plain = await open(false);
    const answers: unknown[] = [];
    for (const { db } of [shared, plain])
      answers.push(
        await db.doc.upsert({
          user: "ann",
          where: { id: "d1" },
          create: { id: "d9", title: "n", orgId: "o1" },
          update: { title: "z" },
          select: { id: true, title: true },
        })
      );
    expect(answers).toEqual([
      { id: "d1", title: "z" },
      { id: "d1", title: "z" },
    ]);
    // The probe and the located row: `take: 1` lookups of the governed doc.
    const lookups = shared.statements.filter((statement) =>
      statement.endsWith("LIMIT ?")
    );
    expect(lookups).toHaveLength(2);
    for (const lookup of lookups) {
      expect(
        lookup.startsWith(
          `WITH "__shared_0" AS (${MEMBERS}), "__shared_1" AS MATERIALIZED (SELECT "q1"."id" AS "k0" FROM "org" AS "q1" `
        )
      ).toBe(true);
      expect(lookup.split('FROM "__shared_1" WHERE').length - 1).toBe(2);
    }
    for (const statement of plain.statements)
      expect(statement).not.toContain("WITH");
  });

  test("both spellings read, count and write the same rows", async () => {
    const shared = await open(true);
    const plain = await open(false);
    const answers: unknown[] = [];
    for (const { db } of [shared, plain]) {
      answers.push([
        await db.doc.findMany({
          user: "ann",
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        await db.doc.findMany({
          user: "bob",
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        await db.doc.count({ user: "ann" }),
        await db.org.findMany({
          user: "ann",
          select: { id: true, _count: { select: { docs: true } } },
          orderBy: { id: "asc" },
        }),
        await db.doc.updateMany({ user: "ann", data: { title: "seen" } }),
        await db.doc.findMany({
          user: "ann",
          select: { id: true, title: true },
          orderBy: { id: "asc" },
        }),
      ]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[1]).toEqual([
      [{ id: "d1" }, { id: "d3" }, { id: "d4" }],
      [{ id: "d4" }],
      3,
      [
        { id: "o1", _count: { docs: 2 } },
        { id: "o2", _count: { docs: 2 } },
      ],
      { count: 3 },
      // d4 is no longer "a", and ann does not administer o2.
      [
        { id: "d1", title: "seen" },
        { id: "d3", title: "seen" },
      ],
    ]);
  });

  // MySQL quotes with backticks: a body's aliases are renumbered there too,
  // or no two bodies ever compare equal and nothing is shared.
  test("MySQL states the same repeated bodies once, under its own quotes", async () => {
    const statements: string[] = [];
    for (const shared of [true, false]) {
      const driver = new SqlOnlyDriver(new MySQLAdapter(), "mysql");
      driver.adapter.capabilities.sharesRelationBodies = shared;
      const base = createClient({ schema, driver });
      clients.push(base);
      await base
        .$extends(policy)
        .$extends({
          name: "statements",
          statement(context) {
            statements.push(context.statement.toStatement());
            return context.statement;
          },
        })
        .doc.findMany({ user: "ann", select: { id: true } });
    }
    const [sharedRead, plainRead] = statements;
    expect(
      sharedRead!.startsWith(
        "WITH `__shared_0` AS (SELECT `q2`.`orgId` AS `k0` FROM `member` AS `q2` WHERE "
      )
    ).toBe(true);
    expect(sharedRead).toContain(
      ", `__shared_1` AS (SELECT `q1`.`id` AS `k0` FROM `org` AS `q1` WHERE EXISTS (SELECT 1 FROM `__shared_0` WHERE `q1`.`id` = `__shared_0`.`k0`)) SELECT "
    );
    expect(sharedRead!.split("FROM `__shared_1` WHERE").length - 1).toBe(2);
    expect(plainRead).not.toContain("WITH");
  });

  // A closure stated thrice is one reaching set, and the row testing it
  // thrice joins it once; on MySQL, whose `cte_max_recursion_depth` a walk from
  // its start row alone would spend an iteration of, every walk keeps its
  // place and its first hop, sharing or not.
  const folder = s.model({
    id: s.string().id(),
    owner: s.string(),
    archived: s.boolean(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => folder)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => folder),
  });
  const underAnn = {
    parent: { recurse: { depth: false }, self: true, some: { owner: "ann" } },
  };
  const folders = defineExtension({
    name: "folders",
    rows: {
      control: "scope",
      default: "ann",
      models: {
        folder: {
          ann: {
            root: {
              OR: [
                { AND: [underAnn, { archived: false }] },
                { AND: [underAnn, { archived: true }] },
                { AND: [underAnn, { owner: "cid" }] },
              ],
            },
          },
        },
      },
    },
  });
  const readFolders = async (
    driver: SqlOnlyDriver | ReturnType<typeof createInMemorySQLite3Driver>
  ) => {
    const statements: string[] = [];
    const base = createClient({ schema: { folder }, driver });
    clients.push(base);
    const db = base.$extends(folders).$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
    return { base, db, statements };
  };

  // Neki's count: every `FROM` item is aliased `q<n>` or a bare member read.
  const relationsOf = (statement: string) =>
    (statement.match(/ AS "q\d+"/g) ?? []).length +
    (statement.match(/(?:FROM|JOIN) "__shared_\d+"(?! AS)/g) ?? []).length;
  const formOf = (statement: string) => ({
    inPlace: statement.split("EXISTS (WITH RECURSIVE").length - 1,
    reaching: statement.startsWith('WITH RECURSIVE "__shared_0" AS (SELECT'),
    joined: statement.includes('LEFT JOIN "__shared_'),
  });

  test("a closure stated thrice keeps its place within the relation budget, is one reaching set past it, and joins the row past that, with the same rows", async () => {
    const answers: unknown[] = [];
    const forms: [number | undefined, ReturnType<typeof formOf>][] = [];
    const counts: [number, number][] = [];
    let inPlace = 0;
    const budgets: (number | undefined)[] = [undefined];
    // Iterates the budgets the first read appends.
    for (const budget of budgets) {
      const driver = createInMemorySQLite3Driver();
      driver.adapter.capabilities.sharesRelationBodies = true;
      driver.adapter.capabilities.relationsPerStatement = budget;
      const { base, db, statements } = await readFolders(driver);
      await syncLiveSchema(base);
      await base.folder.createMany({
        data: [
          { id: "f1", owner: "ann", archived: false, parentId: null },
          { id: "f2", owner: "bob", archived: true, parentId: "f1" },
          { id: "f3", owner: "bob", archived: false, parentId: "f2" },
          { id: "f4", owner: "bob", archived: false, parentId: null },
        ],
      });
      answers.push(
        await db.folder.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        })
      );
      const [read] = statements;
      const form = formOf(read!);
      forms.push([budget, form]);
      const count = relationsOf(read!);
      if (budget !== undefined) counts.push([budget, count]);
      else {
        // Unbounded: every walk in place. Then each budget from that count
        // down to 1.
        inPlace = count;
        for (let below = count; below > 0; below--) budgets.push(below);
      }
    }
    // A statement fits its budget wherever its most compact form does.
    const least = counts.at(-1)![1];
    for (const [budget, count] of counts)
      expect(count <= budget || count === least).toBe(true);
    expect(forms[0]).toEqual([
      undefined,
      { inPlace: 3, reaching: false, joined: false },
    ]);
    expect(forms[1]).toEqual([
      inPlace,
      { inPlace: 3, reaching: false, joined: false },
    ]);
    expect(forms[2]).toEqual([
      inPlace - 1,
      { inPlace: 0, reaching: true, joined: false },
    ]);
    expect(forms.at(-1)).toEqual([
      1,
      { inPlace: 0, reaching: true, joined: true },
    ]);
    expect(least).toBeLessThan(inPlace - 1);
    for (const answer of answers)
      expect(answer).toEqual([{ id: "f1" }, { id: "f2" }, { id: "f3" }]);
  });

  test("on MySQL every walk keeps its place and its first hop, sharing or not", async () => {
    for (const shared of [true, false]) {
      const driver = new SqlOnlyDriver(new MySQLAdapter(), "mysql");
      driver.adapter.capabilities.sharesRelationBodies = shared;
      const { db, statements } = await readFolders(driver);
      await db.folder.findMany({ select: { id: true } });
      const [read] = statements;
      expect(read!.startsWith("SELECT")).toBe(true);
      expect(read!.split("EXISTS (WITH RECURSIVE").length - 1).toBe(3);
      // The start row and its first hop: one derived term of each anchor.
      expect(read!.split(" UNION SELECT `q").length - 1).toBe(3);
    }
  });
});

runSharedBodiesBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});
