/**
 * Two checks a `rows` predicate can make beside its own row's columns
 * (permissions 1.3.2), on in-memory SQLite3, with and without shared bodies:
 *
 * - `{ $exists: { <model>: <where> } }`: some row of another model the call
 *   may see matches. Without a `{ $row, up }` reaching out of it, it reads
 *   no row the statement judges, so a statement sharing bodies states it
 *   once (at most one row); with one, it is correlated and stays in place.
 * - `{ $row: "<field>", up: <n> }`: that column of the row `n` relation
 *   bodies above (`0`, the same row). Never past the predicate, across a
 *   recursive relation, or between columns a comparison cannot read; a write
 *   changing a column a body reads this way is judged on its new row.
 *
 * Both are domain-predicate markers only: a caller's `where` refuses them.
 */

import { createClient } from "@client/client";
import { ForbiddenError, UnsupportedOperationError } from "@errors";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { v } from "@src/validation";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const org = s.model({
  id: s.string().id(),
  members: s.toMany(() => member),
  grants: s.toMany(() => grant),
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
const grant = s.model({
  id: s.string().id(),
  role: s.string(),
  rank: s.int(),
  orgId: s.string(),
  org: s
    .toOne(() => org)
    .fields("orgId")
    .references("id"),
});
const schema = { org, member, grant };

const user = { control: "user" };
/** The caller is a member of the grant's organization, at the grant's role. */
const holdsRole = {
  $exists: {
    member: {
      userId: user,
      orgId: { $row: "orgId", up: 1 },
      role: { $row: "role", up: 1 },
    },
  },
};
/** The same through the grant's organization: the member row is 2 bodies down. */
const holdsRoleThroughOrg = {
  org: {
    is: {
      members: { some: { userId: user, role: { $row: "role", up: 2 } } },
    },
  },
};
/** The caller is a member of anything: no row of the statement is read. */
const isMember = { $exists: { member: { userId: user } } };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  update(args: object): Promise<Row>;
  updateMany(args: object): Promise<{ count: number }>;
}
type Loose = Record<string, Delegate> & {
  $extends(definition: object): Loose;
  $disconnect(): Promise<void>;
};

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

async function open(root: object, shared = false) {
  const driver = createInMemorySQLite3Driver();
  if (shared) driver.adapter.capabilities.sharesRelationBodies = true;
  const base = createClient({ schema, driver });
  clients.push(base);
  await syncLiveSchema(base);
  await base.org.createMany({ data: [{ id: "o1" }, { id: "o2" }] });
  await base.member.createMany({
    data: [
      { id: "m1", userId: "ann", role: "admin", orgId: "o1" },
      { id: "m2", userId: "bob", role: "reader", orgId: "o1" },
      { id: "m3", userId: "ann", role: "reader", orgId: "o2" },
    ],
  });
  await base.grant.createMany({
    data: [
      { id: "g1", role: "admin", rank: 1, orgId: "o1" },
      { id: "g2", role: "reader", rank: 2, orgId: "o1" },
      { id: "g3", role: "reader", rank: 3, orgId: "o2" },
      { id: "g4", role: "admin", rank: 4, orgId: "o2" },
    ],
  });
  const statements: string[] = [];
  const db = (base as unknown as Loose)
    .$extends(
      defineExtension({
        name: "policy",
        controls: { user: { schema: v.string(), required: true } },
        rows: {
          control: "scope",
          default: "all",
          models: { grant: { all: { root } } },
          verbs: {
            grant: {
              predicates: { held: root },
              read: "held",
              update: "held",
            },
          },
        },
      } as never)
    )
    .$extends({
      name: "statements",
      statement(context: { statement: { toStatement(): string } }) {
        statements.push(context.statement.toStatement());
        return context.statement;
      },
    });
  return { base: base as unknown as Loose, db, statements };
}

const ids = (rows: Row[]) => rows.map((row) => row.id).sort();

describe("$exists", () => {
  test("is true where another model's row matches, for every row of the statement alike", async () => {
    const { db } = await open(isMember);
    expect(ids(await db.grant!.findMany({ user: "ann" }))).toEqual([
      "g1",
      "g2",
      "g3",
      "g4",
    ]);
    expect(await db.grant!.findMany({ user: "carl" })).toEqual([]);
  });

  test("reading its own row's columns through { $row, up: 1 }, it is judged per row", async () => {
    const { db } = await open(holdsRole);
    expect(ids(await db.grant!.findMany({ user: "ann" }))).toEqual([
      "g1",
      "g3",
    ]);
    expect(ids(await db.grant!.findMany({ user: "bob" }))).toEqual(["g2"]);
  });

  test("uncorrelated, a statement sharing bodies states it once, as at most one row; correlated, it stays in place", async () => {
    const twice = {
      OR: [{ AND: [isMember, { rank: 1 }] }, { AND: [isMember, { rank: 2 }] }],
    };
    const uncorrelated = await open(twice, true);
    await uncorrelated.db.grant!.findMany({
      user: "ann",
      select: { id: true },
    });
    // The mode's root and the read verb both hold it: four tests, one body.
    expect(uncorrelated.statements).toEqual([
      'WITH "__shared_0" AS (SELECT 1 FROM "member" AS "q1" WHERE "q1"."userId" COLLATE BINARY = ? LIMIT ?) SELECT "q0"."id" AS "id" FROM "grant" AS "q0" WHERE (((EXISTS (SELECT 1 FROM "__shared_0" WHERE 1) AND "q0"."rank" = ?) OR (EXISTS (SELECT 1 FROM "__shared_0" WHERE 1) AND "q0"."rank" = ?)) AND ((EXISTS (SELECT 1 FROM "__shared_0" WHERE 1) AND "q0"."rank" = ?) OR (EXISTS (SELECT 1 FROM "__shared_0" WHERE 1) AND "q0"."rank" = ?))) ORDER BY "q0"."id" ASC',
    ]);
    const correlated = await open(
      {
        OR: [
          { AND: [holdsRole, { rank: 1 }] },
          { AND: [holdsRole, { rank: 3 }] },
        ],
      },
      true
    );
    expect(
      ids(
        await correlated.db.grant!.findMany({
          user: "ann",
          select: { id: true },
        })
      )
    ).toEqual(["g1", "g3"]);
    expect(correlated.statements[0]).not.toContain("WITH");
  });

  test("names one model of the schema, admitted with that model's where", async () => {
    for (const [root, message] of [
      [{ $exists: {} }, "names exactly one model"],
      [{ $exists: { member: {}, org: {} } }, "names exactly one model"],
      [{ $exists: { nobody: {} } }, "names exactly one model"],
      [{ $exists: { member: { nope: 1 } } }, '"$exists.member.nope"'],
    ] as const) {
      const driver = createInMemorySQLite3Driver();
      const base = createClient({ schema, driver });
      clients.push(base);
      expect(() =>
        (base as unknown as Loose).$extends(
          defineExtension({
            name: "policy",
            rows: {
              control: "scope",
              default: "all",
              models: { grant: { all: { root } } },
            },
          } as never)
        )
      ).toThrow(message);
    }
  });

  test("a body its conditions fold false finds no row; one folding true still needs a row", async () => {
    const folded = (equals: string) => ({
      $exists: {
        member: { $if: { control: "user", equals }, userId: user },
      },
    });
    const { db } = await open({ OR: [folded("nobody"), { rank: 4 }] });
    expect(ids(await db.grant!.findMany({ user: "ann" }))).toEqual(["g4"]);
    const held = await open(folded("ann"));
    expect(ids(await held.db.grant!.findMany({ user: "ann" }))).toHaveLength(4);
    const nobody = await open(folded("carl"));
    expect(await nobody.db.grant!.findMany({ user: "carl" })).toEqual([]);
  });

  test("a caller's where refuses it", async () => {
    const { base } = await open(isMember);
    await expect(
      base.grant!.findMany({ where: { $exists: { member: {} } } })
    ).rejects.toThrow("Unknown key: $exists");
  });
});

describe("{ $row, up }", () => {
  test("two bodies down, it compares with the grant's column", async () => {
    const { db } = await open(holdsRoleThroughOrg);
    expect(ids(await db.grant!.findMany({ user: "ann" }))).toEqual([
      "g1",
      "g3",
    ]);
  });

  test("up: 0 compares two columns of the same row", async () => {
    const { db } = await open({
      id: { not: { $row: "orgId", up: 0 } },
      rank: { gt: 2 },
    });
    expect(ids(await db.grant!.findMany({ user: "ann" }))).toEqual([
      "g3",
      "g4",
    ]);
  });

  test("a write changing a column a body reads that way is judged on its new row", async () => {
    for (const root of [holdsRole, holdsRoleThroughOrg]) {
      const { db, base } = await open(root);
      // ann is an admin of o1, not a reader: the grant cannot become one.
      await expect(
        db.grant!.update({
          where: { id: "g1" },
          data: { role: "reader" },
          user: "ann",
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        db.grant!.updateMany({
          where: { id: "g1" },
          data: { role: "reader" },
          user: "ann",
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(
        (await base.grant!.findMany({ where: { id: "g1" } }))[0]!.role
      ).toBe("admin");
      // A write the new row still passes.
      await db.grant!.update({
        where: { id: "g3" },
        data: { rank: 30 },
        user: "ann",
      });
    }
  });

  test("never past the predicate, across a recursive relation, or between columns a comparison cannot read", async () => {
    const refused = async (root: object, message: string) => {
      const { db } = await open(root);
      const call = db.grant!.findMany({ user: "ann" });
      await expect(call).rejects.toBeInstanceOf(UnsupportedOperationError);
      await expect(db.grant!.findMany({ user: "ann" })).rejects.toThrow(
        message
      );
    };
    await refused(
      { role: { $row: "role", up: 1 } },
      "reaches past the predicate it is written in"
    );
    await refused(
      { org: { is: { members: { some: { role: { $row: "rank", up: 2 } } } } } },
      "cannot be compared with 'role'"
    );
    await refused(
      { org: { is: { members: { some: { role: { $row: "nope", up: 2 } } } } } },
      "does not name a scalar field of 'grant'"
    );
  });

  test("a caller's where reads it as a literal, refused", async () => {
    const { base } = await open(isMember);
    await expect(
      base.grant!.findMany({ where: { role: { $row: "role", up: 0 } } })
    ).rejects.toThrow();
  });
});
