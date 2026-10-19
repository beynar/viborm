/** Native PostgreSQL array values must retain their member boundaries when sharing relation bodies. */

import { createClient } from "@client/client";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { v } from "@src/validation";
import { runSharedBodiesBehavior } from "@tests/contracts/public-client/shared-bodies-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, expect, test } from "vitest";

/** A relation body, read per row through its key: inlined. */
const SHARED_RELATION_BODY =
  /"__shared_\d" AS NOT MATERIALIZED \(SELECT "q\d+"\."orgId" AS "k0"/;
/** A relation body that reads another shared body: materialized. */
const NESTING_RELATION_BODY =
  /"__shared_\d" AS \(SELECT "q\d+"\."id" AS "k0" FROM "public"\."org"/;
/** A relation body over a table mapped `__shared_0`: still a leaf. */
const MAPPED_LIKE_A_BODY =
  /^WITH "__shared_\d" AS NOT MATERIALIZED \(SELECT "q\d+"\."teamId" AS "k0" FROM "public"\."__shared_0"/;
/** An `$exists` body, read once per statement: materialized. */
const SHARED_EXISTS_BODY =
  /"__shared_\d" AS \(SELECT 1 FROM "public"\."member"/;
const LEADING_SHARED_RELATION_BODY =
  /^WITH "__shared_0" AS NOT MATERIALIZED \(SELECT "q\d+"\."orgId" AS "k0"/;

runSharedBodiesBehavior({
  name: "PGlite",
  createDriver: createInMemoryPGliteDriver,
});

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
const user = { control: "user" } as const;
const inOrg = { org: { members: { some: { userId: user } } } };
const anyMembership = { $exists: { member: { userId: user } } };
const policy = defineExtension({
  name: "policy",
  controls: { user: { schema: v.string(), required: true } },
  rows: {
    control: "scope",
    default: "all",
    models: {},
    verbs: {
      doc: {
        predicates: {
          held: {
            OR: [
              { AND: [inOrg, { title: "a" }] },
              { AND: [inOrg, anyMembership] },
              { AND: [anyMembership, { title: "c" }] },
            ],
          },
        },
        read: "held",
      },
    },
  },
});

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

// PostgreSQL 12+ materializes a WITH member read twice and scans it, without
// an index, once per outer row: a relation body, read through its key
// columns, stays inlined (NOT MATERIALIZED); an `$exists` body, read once
// per statement, keeps the materialized form.
test("PGlite: a shared relation body reading no other is NOT MATERIALIZED; one reading another, and a shared $exists body, are not", async () => {
  const rows: unknown[] = [];
  for (const shared of [true, false]) {
    const driver = createInMemoryPGliteDriver();
    driver.adapter.capabilities.sharesRelationBodies = shared;
    const base = createClient({ schema: { org, member, doc }, driver });
    clients.push(base);
    await syncLiveSchema(base);
    await base.org.createMany({ data: [{ id: "o1" }, { id: "o2" }] });
    await base.member.createMany({
      data: [
        { id: "m1", userId: "ann", orgId: "o1" },
        { id: "m2", userId: "bob", orgId: "o2" },
      ],
    });
    await base.doc.createMany({
      data: [
        { id: "d1", title: "a", orgId: "o1" },
        { id: "d2", title: "b", orgId: "o2" },
        { id: "d3", title: "c", orgId: "o2" },
        { id: "d4", title: "b", orgId: "o1" },
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
    rows.push(
      await db.doc.findMany({
        user: "ann",
        select: { id: true },
        orderBy: { id: "asc" },
      })
    );
    const [statement] = statements;
    if (shared) {
      expect(statement).toMatch(SHARED_RELATION_BODY);
      expect(statement).toMatch(NESTING_RELATION_BODY);
      expect(statement).toMatch(SHARED_EXISTS_BODY);
    } else {
      expect(statement).not.toContain("WITH");
    }
  }
  expect(rows[0]).toEqual([{ id: "d1" }, { id: "d3" }, { id: "d4" }]);
  expect(rows[1]).toEqual(rows[0]);
});

// A write's located lookup is a statement of its own: its repeated body is
// one `WITH` member ahead of the `SELECT … FOR UPDATE`, which still locks
// only the row it locates.
test("PGlite: an upsert's locked lookup states its repeated body once, ahead of FOR UPDATE", async () => {
  const scoped = defineExtension({
    name: "scoped",
    controls: { user: { schema: v.string(), required: true } },
    rows: {
      control: "scope",
      default: "member",
      models: {
        doc: {
          member: {
            root: {
              OR: [
                { AND: [inOrg, { title: "a" }] },
                { AND: [inOrg, anyMembership] },
              ],
            },
            related: inOrg,
          },
        },
      },
    },
  });
  const answers: unknown[] = [];
  for (const shared of [true, false]) {
    const driver = createInMemoryPGliteDriver();
    driver.adapter.capabilities.sharesRelationBodies = shared;
    const base = createClient({ schema: { org, member, doc }, driver });
    clients.push(base);
    await syncLiveSchema(base);
    await base.org.createMany({ data: [{ id: "o1" }, { id: "o2" }] });
    await base.member.createMany({
      data: [{ id: "m1", userId: "ann", orgId: "o1" }],
    });
    await base.doc.createMany({
      data: [
        { id: "d1", title: "a", orgId: "o1" },
        { id: "d2", title: "b", orgId: "o2" },
      ],
    });
    const statements: string[] = [];
    const db = base.$extends(scoped).$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
    for (const id of ["d1", "d2"])
      answers.push(
        await db.doc.upsert({
          user: "ann",
          where: { id },
          create: { id: `${id}-new`, title: "n", orgId: "o1" },
          update: { title: "z" },
          select: { id: true, title: true },
        })
      );
    // d1's located row; d2, outside ann's organizations, is created.
    const locked = statements.filter((statement) =>
      statement.endsWith("FOR UPDATE")
    );
    expect(locked).toHaveLength(1);
    for (const statement of locked)
      if (shared) {
        expect(statement).toMatch(LEADING_SHARED_RELATION_BODY);
        expect(statement.split('FROM "__shared_1" WHERE').length - 1).toBe(2);
      } else {
        expect(statement).not.toContain("WITH");
      }
  }
  expect(answers.slice(0, 2)).toEqual([
    { id: "d1", title: "z" },
    { id: "d2-new", title: "n" },
  ]);
  expect(answers.slice(2)).toEqual(answers.slice(0, 2));
});

// A table may be named like a body: whether a body reads another is told by
// the bodies the statement stated, not by text (Devin review on #105).
test("PGlite: a shared relation body over a table named like a body is still NOT MATERIALIZED", async () => {
  const team = s.model({
    id: s.string().id(),
    seats: s.toMany(() => seat),
    notes: s.toMany(() => note),
  });
  const seat = s
    .model({
      id: s.string().id(),
      userId: s.string(),
      teamId: s.string(),
      team: s
        .toOne(() => team)
        .fields("teamId")
        .references("id"),
    })
    .map("__shared_0");
  const note = s.model({
    id: s.string().id(),
    title: s.string(),
    teamId: s.string(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
  });
  const seated = { team: { seats: { some: { userId: user } } } };
  const driver = createInMemoryPGliteDriver();
  const base = createClient({ schema: { team, seat, note }, driver });
  clients.push(base);
  await syncLiveSchema(base);
  await base.team.createMany({ data: [{ id: "t1" }, { id: "t2" }] });
  await base.seat.createMany({
    data: [
      { id: "s1", userId: "ann", teamId: "t1" },
      { id: "s2", userId: "bob", teamId: "t2" },
    ],
  });
  await base.note.createMany({
    data: [
      { id: "n1", title: "a", teamId: "t1" },
      { id: "n2", title: "b", teamId: "t1" },
      { id: "n3", title: "a", teamId: "t2" },
    ],
  });
  const statements: string[] = [];
  const db = base
    .$extends(
      defineExtension({
        name: "policy",
        controls: { user: { schema: v.string(), required: true } },
        rows: {
          control: "scope",
          default: "all",
          models: {},
          verbs: {
            note: {
              predicates: {
                held: {
                  OR: [
                    { AND: [seated, { title: "a" }] },
                    { AND: [seated, { title: "b" }] },
                  ],
                },
              },
              read: "held",
            },
          },
        },
      })
    )
    .$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
  expect(
    await db.note.findMany({
      user: "ann",
      select: { id: true },
      orderBy: { id: "asc" },
    })
  ).toEqual([{ id: "n1" }, { id: "n2" }]);
  expect(statements[0]).toMatch(MAPPED_LIKE_A_BODY);
});
