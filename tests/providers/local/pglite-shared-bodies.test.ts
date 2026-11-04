/** Native PostgreSQL array values must retain their member boundaries when sharing relation bodies. */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { permissions } from "@src/permissions";
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
/** A statement led by a reaching set: its one recursive member. */
const LEADING_REACHING_SET = /^WITH RECURSIVE /;
const RECURSIVE_MEMBER = /RECURSIVE/g;
/** An `$exists` answer read where it is tested, not from a joined row. */
const EXISTS_READ = /EXISTS \(SELECT 1 FROM "__shared_\d+" WHERE TRUE\)/;
const CROSS_JOIN = /CROSS JOIN/g;
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
  expect(answers.slice(2, 4)).toEqual(answers.slice(0, 2));
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

// A walk its author states selective (the teams the actor belongs to,
// through their subteams), read only inside bodies computed over their whole
// tables, is computed once as a reaching set, from the actor's memberships
// back up the tree: in place it walks the tree once per row of each body.
// Unstated, nothing moves: the engine does not guess which walk is few.
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
const seat = s.model({
  id: s.string().id(),
  userId: s.string(),
  teamId: s.string(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
});
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
/** The actor's teams, through their subteams: a body the walk reads. */
const mine = { members: { some: { userId: user } } };
/** A walk to `some`'s rows; `selective` unstated, the key is absent. */
const walk = (selective: boolean | undefined, some: object = mine) => ({
  children: {
    recurse: { depth: false, ...(selective !== undefined && { selective }) },
    some,
  },
});
const grantedThrough = (team: object) => ({
  grants: { some: { team: { is: team } } },
});
/**
 * The team body read at two places (a grant of any id, and every grant): it
 * is computed over the whole team table, as a policy's repeated rules make
 * it. Read at one place, it is inlined into the grant body.
 */
const grantedTwice = (team: object) => ({
  OR: [
    grantedThrough(team),
    { grants: { some: { id: { not: "-" }, team: { is: team } } } },
  ],
});
/** Each arm repeats the rule, so its bodies are shared. */
const teamsPolicy = (rule: object) =>
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
                { AND: [rule, { title: "a" }] },
                { AND: [rule, { title: { not: "a" } }] },
              ],
            },
          },
          read: "held",
          update: "held",
          delete: "held",
        },
      },
    },
  });
/** Another layer: what a team read through a relation must hold. */
const visible = (related: object) =>
  defineExtension({
    name: "visible",
    rows: {
      control: "visibility",
      default: "on",
      models: { team: { on: { related: { AND: [related] } } } },
    },
  });
type Dialect = "PGlite" | "SQLite";
/** A seeded client under `rule`, and the statements it sends. */
const teamsClient = async (
  dialect: Dialect,
  shared: boolean,
  rule: object,
  relationsPerStatement?: number
) => {
  const driver =
    dialect === "PGlite"
      ? createInMemoryPGliteDriver()
      : new SQLite3Driver({ dataDir: ":memory:" });
  driver.adapter.capabilities.sharesRelationBodies = shared;
  driver.adapter.capabilities.relationsPerStatement = relationsPerStatement;
  const base = createClient({ schema: { team, seat, page, grant }, driver });
  clients.push(base);
  await syncLiveSchema(base);
  // root ← mid ← leaf, other ← sub; ann sits in leaf, bob in sub. A team's
  // walk reads its subteams, not itself: a grant to leaf is none of ann's.
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
  const db = base.$extends(teamsPolicy(rule)).$extends({
    name: "statements",
    statement(context) {
      statements.push(context.statement.toStatement());
      return context.statement;
    },
  });
  return { base, db, statements };
};
/** A walk left in place: its own recursive `WITH` inside an `EXISTS`. */
const WALK_IN_PLACE = /EXISTS \(WITH RECURSIVE "__q\d+_recursive"/g;
const MATERIALIZED_MEMBER = /AS MATERIALIZED \(/g;
/** 1.9.1's statement for ann's pages, the walk unstated. */
const UNSTATED_PAGES = `WITH "__shared_0" AS NOT MATERIALIZED (SELECT "q4"."teamId" AS "k0" FROM "public"."seat" AS "q4" WHERE "q4"."userId" = ?), "__shared_2" AS (SELECT "q2"."id" AS "k0" FROM "public"."team" AS "q2" WHERE EXISTS (WITH RECURSIVE "__q5_recursive" AS (
        SELECT "q6"."id" AS "__q5_child_0" FROM "public"."team" AS "q6" WHERE "q2"."id" = "q6"."parentId"
        UNION
        SELECT "q8"."id" AS "__q5_child_0" FROM "__q5_recursive" AS "q7" INNER JOIN "public"."team" AS "q8" ON "q7"."__q5_child_0" = "q8"."parentId"
      ) SELECT 1 FROM "__q5_recursive" AS "q7" INNER JOIN "public"."team" AS "q3" ON "q3"."id" = "q7"."__q5_child_0" WHERE EXISTS (SELECT 1 FROM "__shared_0" WHERE "q3"."id" = "__shared_0"."k0"))), "__shared_3" AS (SELECT "q1"."pageId" AS "k0" FROM "public"."grant" AS "q1" WHERE (EXISTS (SELECT 1 FROM "__shared_2" WHERE "q1"."teamId" = "__shared_2"."k0") OR (NOT ("q1"."id" = ?) AND EXISTS (SELECT 1 FROM "__shared_2" WHERE "q1"."teamId" = "__shared_2"."k0")))) SELECT "q0"."id" FROM "public"."page" AS "q0" WHERE ((EXISTS (SELECT 1 FROM "__shared_3" WHERE "q0"."id" = "__shared_3"."k0") AND "q0"."title" = ?) OR (EXISTS (SELECT 1 FROM "__shared_3" WHERE "q0"."id" = "__shared_3"."k0") AND NOT ("q0"."title" = ?))) ORDER BY "q0"."id" ASC`;
const pagesOf = (
  db: Awaited<ReturnType<typeof teamsClient>>["db"],
  who: string
) =>
  db.page.findMany({ user: who, select: { id: true }, orderBy: { id: "asc" } });

test("a walk stated selective, read only in bodies computed over their whole tables, is one reaching set; unstated, the statement is 1.9.1's", async () => {
  for (const dialect of ["PGlite", "SQLite"] as const) {
    const answers: unknown[] = [];
    const forms: Record<string, string> = {};
    for (const shared of [true, false])
      for (const selective of [undefined, false, true]) {
        const { db, statements } = await teamsClient(
          dialect,
          shared,
          grantedTwice(walk(selective))
        );
        for (const who of ["ann", "bob"]) answers.push(await pagesOf(db, who));
        forms[`${shared} ${selective}`] = statements[0]!;
      }
    // ann reaches root and mid (leaf is below them); bob reaches other.
    expect(answers).toEqual(
      Array.from({ length: 6 }, () => [
        [{ id: "a" }, { id: "d" }],
        [{ id: "c" }],
      ]).flat()
    );
    const unstated = forms["true undefined"]!;
    if (dialect === "PGlite") expect(unstated).toBe(UNSTATED_PAGES);
    expect(forms["true false"]).toBe(unstated);
    expect(unstated.match(WALK_IN_PLACE)).toHaveLength(1);
    // Stated: one reaching set leads, no walk stays in place, and no body
    // changes form (the team body read the actor's seats already).
    const stated = forms["true true"]!;
    expect(stated).toMatch(LEADING_REACHING_SET);
    expect(stated.match(RECURSIVE_MEMBER)).toHaveLength(1);
    expect(stated).not.toMatch(WALK_IN_PLACE);
    expect(stated.match(MATERIALIZED_MEMBER)?.length).toBe(
      unstated.match(MATERIALIZED_MEMBER)?.length
    );
  }
});

// A walk whose body reads no other stays inlined, read by the outer row's
// key: lifted, the body would read a set and be computed over its whole
// table (a unique read 0.08 → 55 ms where most rows share the seed, a SQLite
// keyed read a full scan). A selective walk there stays; so does one an
// `every` judges, which reaches back from the rows its predicate does not
// hold of.
test("a selective walk stays in place where lifting it would change a body: keyed reads and locating writes keep their statements", async () => {
  const direct = { id: { in: ["leaf", "sub"] } };
  const rules = {
    "seed on the walked rows": (selective?: boolean) =>
      grantedTwice(walk(selective, direct)),
    "read at one place": (selective?: boolean) =>
      grantedThrough(walk(selective)),
    every: (selective?: boolean) =>
      grantedTwice({
        children: {
          recurse: {
            depth: false,
            ...(selective !== undefined && { selective }),
          },
          every: { members: { none: { userId: user } } },
        },
      }),
  };
  for (const dialect of ["PGlite", "SQLite"] as const)
    for (const [name, rule] of Object.entries(rules)) {
      const runs: { statements: string[]; answers: unknown[] }[] = [];
      for (const selective of [undefined, true]) {
        const { db, statements } = await teamsClient(
          dialect,
          true,
          rule(selective)
        );
        // A refused write answers by its error, as it does in place.
        const answer = (read: Promise<unknown>) =>
          read.catch((error: Error) => error.name);
        const answers = [
          await answer(pagesOf(db, "ann")),
          await answer(
            db.page.findUnique({
              user: "ann",
              where: { id: "a" },
              select: { id: true },
            })
          ),
          await answer(
            db.page.findFirst({
              user: "bob",
              where: { title: "c" },
              select: { id: true },
            })
          ),
          await answer(
            db.page.update({
              user: "ann",
              where: { id: "d" },
              data: { title: "d" },
              select: { id: true },
            })
          ),
          await answer(
            db.page.updateMany({
              user: "bob",
              where: { id: "c" },
              data: { title: "c" },
            })
          ),
          await answer(db.page.deleteMany({ user: "ann", where: { id: "x" } })),
        ];
        runs.push({ statements, answers });
      }
      expect(runs[1], `${dialect}: ${name}`).toEqual(runs[0]);
    }
});

// A related domain's walk is lowered where its body reads it: here a team
// body read at one place, so inlined, though the grant body around it is
// computed over its whole table. Lifted, the team body would read a set and
// a keyed read lose its index (SQLite: SEARCH by key → SCAN).
test("a selective walk in a related domain stays where its own body keeps it inlined", async () => {
  for (const dialect of ["PGlite", "SQLite"] as const) {
    const runs: { statements: string[]; answers: unknown }[] = [];
    for (const selective of [undefined, true] as const) {
      const { base } = await teamsClient(
        dialect,
        true,
        grantedThrough({ id: { not: "-" } })
      );
      const statements: string[] = [];
      const db = base
        .$extends(teamsPolicy(grantedThrough({ id: { not: "-" } })))
        .$extends(visible(walk(selective, { id: "leaf" })))
        .$extends({
          name: "statements",
          statement(context) {
            statements.push(context.statement.toStatement());
            return context.statement;
          },
        });
      runs.push({ statements, answers: await pagesOf(db, "ann") });
    }
    expect(runs[1], dialect).toEqual(runs[0]);
  }
});

// Two walks over one range merge into one, whose seeds are both arms': merged
// with a walk not stated selective, a selective one is not selective and
// stays, merged, in place (split, the first walk would run to its end before
// the second could hold: 0.18 → 184 ms over 300,000 teams).
test("a selective walk merges with a walk not stated selective, and the merged walk is not selective", async () => {
  const either = (selective?: boolean) =>
    grantedTwice({
      OR: [walk(selective), walk(undefined, { id: { in: ["leaf", "sub"] } })],
    });
  const answers: unknown[] = [];
  const forms: string[] = [];
  for (const [shared, selective] of [
    [false, true],
    [true, undefined],
    [true, true],
  ] as const) {
    const { db, statements } = await teamsClient(
      "PGlite",
      shared,
      either(selective)
    );
    for (const who of ["ann", "bob"]) answers.push(await pagesOf(db, who));
    forms.push(statements[0]!);
  }
  expect(answers.slice(2, 4)).toEqual(answers.slice(0, 2));
  expect(answers.slice(4)).toEqual(answers.slice(0, 2));
  expect(forms[1]!.match(WALK_IN_PLACE)).toHaveLength(1);
  expect(forms[2]).toBe(forms[1]);
});

// Under a relation budget (Neki, D1), a selective walk is lifted by the same
// rule, as it changes no body: escalation starts from it and lifts another
// walk only past the bound, as it did.
test("under a relation budget, only the selective walk is lifted while the statement fits", async () => {
  const fourWalks = (selective?: boolean) =>
    grantedTwice({
      AND: [
        walk(selective),
        ...[1, 2, 3].map((index) =>
          walk(undefined, { AND: [mine, { id: { not: `${index}` } }] })
        ),
      ],
    });
  for (const dialect of ["PGlite", "SQLite"] as const) {
    const answers: unknown[] = [];
    const forms: string[] = [];
    for (const [selective, budget] of [
      [undefined, 256],
      [true, 256],
      [true, undefined],
      [true, 30],
      [true, 20],
    ] as const) {
      const { db, statements } = await teamsClient(
        dialect,
        true,
        fourWalks(selective),
        budget
      );
      for (const who of ["ann", "bob"]) answers.push(await pagesOf(db, who));
      forms.push(statements[0]!);
    }
    expect(new Set(answers.map((rows) => JSON.stringify(rows))).size).toBe(2);
    expect(forms[0]!.match(WALK_IN_PLACE)).toHaveLength(4);
    expect(forms[1]).toMatch(LEADING_REACHING_SET);
    expect(forms[1]!.match(WALK_IN_PLACE)).toHaveLength(3);
    expect(forms[2]).toBe(forms[1]);
    // Past the bound, escalation starts from the selective walk and lifts
    // the others only as far as the bound needs.
    expect(forms[3]!.match(WALK_IN_PLACE)).toHaveLength(2);
    expect(forms[4]!.match(WALK_IN_PLACE) ?? []).toHaveLength(0);
  }
});

// Neki refuses a statement past 256 relations. A policy read past every other
// form still reads each `$exists` answer and key set at each row testing it:
// one row, computed once, then holds them all for the root read.
test("past every other form, one row holds what the root read tests, with the same answers", async () => {
  const seated = { $exists: { seat: { userId: user } } };
  const inLeaf = { $exists: { seat: { userId: user, teamId: "leaf" } } };
  const rule = {
    OR: [
      { AND: [seated, grantedTwice(walk())] },
      { AND: [inLeaf, { title: "b" }] },
      { AND: [{ NOT: inLeaf }, seated, { title: "c" }] },
    ],
  };
  const read = (
    db: Awaited<ReturnType<typeof teamsClient>>["db"],
    who: string
  ) =>
    db.page.findMany({
      user: who,
      select: { id: true, grants: { select: { id: true } } },
      orderBy: [{ grants: { _count: "desc" } }, { id: "asc" }],
    });
  const answers: unknown[] = [];
  const forms: string[] = [];
  for (const budget of [undefined, 1]) {
    const { db, statements } = await teamsClient("PGlite", true, rule, budget);
    for (const who of ["ann", "bob", "nobody"])
      answers.push(await read(db, who));
    forms.push(statements[0]!);
    // A write's statement takes the bound too, and its own rows.
    answers.push(
      await db.page.updateMany({
        user: "ann",
        where: { title: "b" },
        data: { title: "b" },
      })
    );
    answers.push(
      await db.page.updateMany({
        user: "bob",
        where: { id: "c" },
        data: { title: "c" },
      })
    );
  }
  const half = answers.length / 2;
  expect(answers.slice(half)).toEqual(answers.slice(0, half));
  expect(answers[0]).not.toEqual([]);
  expect(answers[2]).toEqual([]);
  const root = forms[1]!.slice(forms[1]!.lastIndexOf(') SELECT "q0"'));
  expect(forms[0]).not.toContain("CROSS JOIN");
  expect(root.match(CROSS_JOIN)).toHaveLength(1);
  expect(root).not.toMatch(EXISTS_READ);
});

// A recursive selection's node is a stored row: a walk from it may share its
// reaching set whatever its hop reads, as a declared junction's tenant column.
test("a declared junction's hop reads a column beyond the key: a walk from a selection's node still shares its set", async () => {
  const teamParent = s
    .model({
      organizationId: s.string(),
      childId: s.string(),
      parentId: s.string(),
      child: s
        .toOne(() => tree)
        .fields("organizationId", "childId")
        .references("organizationId", "id"),
      parent: s
        .toOne(() => tree)
        .fields("organizationId", "parentId")
        .references("organizationId", "id"),
    })
    .id(["childId", "parentId"]);
  const tree = s
    .model({
      id: s.string().id(),
      organizationId: s.string(),
      holder: s.string().nullable(),
      parents: s
        .toMany(() => tree)
        .name("graph")
        .through(() => teamParent)
        .source("child")
        .target("parent"),
      children: s.toMany(() => tree).name("graph"),
    })
    .unique(["organizationId", "id"]);
  const here = { actor: "organizationId" };
  const governed = permissions({
    actor: v.object({ organizationId: v.string(), userId: v.string() }),
    tenant: { field: "organizationId", actor: "organizationId" },
    models: {
      tree: {
        actions: { read: [], update: ["read"] },
        mandatory: { organizationId: here },
        read: true,
        update: {
          parents: {
            recurse: { depth: false, selective: true },
            self: true,
            some: { holder: { actor: "userId" } },
          },
        },
      },
      teamParent: {
        actions: { read: [] },
        mandatory: { organizationId: here },
        read: true,
      },
    },
  });
  const answers: unknown[] = [];
  const forms: string[] = [];
  for (const budget of [undefined, 8]) {
    const driver = createInMemoryPGliteDriver();
    driver.adapter.capabilities.sharesRelationBodies = true;
    driver.adapter.capabilities.relationsPerStatement = budget;
    const base = createClient({ schema: { tree, teamParent }, driver });
    clients.push(base);
    await syncLiveSchema(base);
    await base.tree.createMany({
      data: [
        { id: "a", organizationId: "o", holder: "ann" },
        { id: "b", organizationId: "o" },
        { id: "c", organizationId: "o" },
      ],
    });
    await base.teamParent.createMany({
      data: [
        { organizationId: "o", childId: "b", parentId: "a" },
        { organizationId: "o", childId: "c", parentId: "b" },
      ],
    });
    const statements: string[] = [];
    const db = base.$extends(governed).$extends({
      name: "statements",
      statement(context) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
    const row = { id: true, $access: true } as const;
    answers.push(
      await db.$as({ organizationId: "o", userId: "ann" }).tree.findMany({
        where: { parents: { none: {} } },
        select: {
          ...row,
          children: { select: row, recurse: { depth: false } },
        },
      })
    );
    forms.push(statements[0]!);
  }
  expect(answers[1]).toEqual(answers[0]);
  expect(answers[0]).toEqual([
    expect.objectContaining({
      id: "a",
      $access: { read: true, update: true },
    }),
  ]);
  expect(forms[0]!.match(WALK_IN_PLACE)).toHaveLength(2);
  expect(forms[1]).toMatch(LEADING_REACHING_SET);
  expect(forms[1]).not.toMatch(WALK_IN_PLACE);
});
