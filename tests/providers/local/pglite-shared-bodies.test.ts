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
    // Each upsert's probe: on PostgreSQL it locks the row it finds (d1) and
    // nothing where it finds none (d2, outside ann's organizations, created),
    // so no confirmation follows it (`Selection.probesUnlocked`).
    const locked = statements.filter((statement) =>
      statement.endsWith("FOR UPDATE")
    );
    expect(locked).toHaveLength(2);
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

// A walk read only inside repeated bodies (the teams the actor belongs to,
// through their subteams, inside "the grants that name them") is computed
// once as a reaching set, from the actor's memberships back up the tree:
// in place it walks the tree once per grant of each body. A walk to rows no
// call value names (any team with a member) stays in its body, read by the
// grant's key: as a set it would hold most of the tree.
test("PGlite: a walk to the actor's rows only repeated bodies read is one reaching set; a broad one stays in place; both answer as in place", async () => {
  const team = s.model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => team)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => team).name("tree"),
    members: s.toMany(() => seat),
    grants: s.toMany(() => grant),
  });
  // Reads select seats by user: the index says so.
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
    .index(["userId"]);
  const page = s.model({
    id: s.string().id(),
    title: s.string(),
    grants: s.toMany(() => grant),
  });
  const grant = s.model({
    id: s.string().id(),
    pageId: s.string(),
    teamId: s.string(),
    page: s
      .toOne(() => page)
      .fields("pageId")
      .references("id"),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
  });
  const reaching = (member: object) => ({
    grants: {
      some: {
        team: {
          is: {
            children: {
              recurse: { depth: false },
              some: { members: { some: member } },
            },
          },
        },
      },
    },
  });
  const policy = (member: object) =>
    defineExtension({
      name: "teams",
      controls: { user: { schema: v.string(), required: true } },
      rows: {
        control: "scope",
        default: "all",
        models: {},
        verbs: {
          page: {
            predicates: {
              held: {
                OR: [
                  { AND: [reaching(member), { title: "a" }] },
                  { AND: [reaching(member), { title: { not: "a" } }] },
                ],
              },
            },
            read: "held",
          },
        },
      },
    });
  const answers: unknown[] = [];
  for (const [shared, broad] of [
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ] as const) {
    // The actor's rows, as an OR whose every arm names them; or any member.
    const teams = policy(
      broad
        ? { id: { not: "" } }
        : { OR: [{ userId: user }, { AND: [{ userId: user }, { id: "-" }] }] }
    );
    const driver = createInMemoryPGliteDriver();
    driver.adapter.capabilities.sharesRelationBodies = shared;
    const base = createClient({ schema: { team, seat, page, grant }, driver });
    clients.push(base);
    await syncLiveSchema(base);
    // root ← mid ← leaf, other ← sub; ann sits in leaf, bob in sub. A
    // team's walk reads its subteams, not itself: a grant to leaf is none
    // of ann's.
    await base.team.createMany({
      data: [
        { id: "root" },
        { id: "mid", parentId: "root" },
        { id: "leaf", parentId: "mid" },
        { id: "other" },
        { id: "sub", parentId: "other" },
      ],
    });
    await base.seat.createMany({
      data: [
        { id: "s1", userId: "ann", teamId: "leaf" },
        { id: "s2", userId: "bob", teamId: "sub" },
      ],
    });
    await base.page.createMany({
      data: ["a", "b", "c", "d"].map((id) => ({ id, title: id })),
    });
    await base.grant.createMany({
      data: [
        { id: "g1", pageId: "a", teamId: "root" },
        { id: "g2", pageId: "b", teamId: "leaf" },
        { id: "g3", pageId: "c", teamId: "other" },
        { id: "g4", pageId: "d", teamId: "mid" },
      ],
    });
    const statements: string[] = [];
    const db = base.$extends(teams).$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
    for (const who of ["ann", "bob"])
      answers.push(
        await db.page.findMany({
          user: who,
          select: { id: true },
          orderBy: { id: "asc" },
        })
      );
    const [statement] = statements;
    if (shared && !broad) {
      // One recursive member, the reaching set, and no walk left in place.
      expect(statement).toMatch(/^WITH RECURSIVE /);
      expect(statement!.match(/RECURSIVE/g)).toHaveLength(1);
    }
    // The broad walk stays in each body (Sol's review: 0.03 ms in place,
    // 76 ms as a set over 30,000 rows).
    if (shared && broad) expect(statement).not.toMatch(/^WITH RECURSIVE /);
  }
  expect(answers.slice(0, 2)).toEqual([
    [{ id: "a" }, { id: "d" }],
    [{ id: "c" }],
  ]);
  expect(answers.slice(2, 4)).toEqual(answers.slice(0, 2));
  // Any team with a member under it: root, mid and other hold one.
  expect(answers.slice(4, 6)).toEqual([
    [{ id: "a" }, { id: "c" }, { id: "d" }],
    [{ id: "a" }, { id: "c" }, { id: "d" }],
  ]);
  expect(answers.slice(6)).toEqual(answers.slice(4, 6));
});
