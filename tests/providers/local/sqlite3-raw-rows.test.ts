/**
 * SQLite3 Driver Tests — governed raw reads: `<model>.$rows(alias)` puts the
 * row domain a `findMany` of that model on that client takes into a tagged
 * `$queryRaw`, as a derived table. Hand-computed oracles: pages (id, owner,
 * title) a (alice, one), b (alice, two), c (bob, three); users alice, bob.
 */

import { createClient as createBaseClient } from "@client/client";
import { createClient, SQLite3Driver } from "@drivers/sqlite3";
import {
  ForbiddenError,
  QueryError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { sql } from "@sql";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  pages: s.toMany(() => page),
});
const page = s.model({
  id: s.string().id(),
  owner: s.string(),
  author: s
    .toOne(() => user)
    .fields("owner")
    .references("id"),
  title: s.string(),
  tenant: s.string(),
  deletedAt: s.dateTime().nullable(),
});
const secret = s.model({ id: s.string().id() });
const tag = s.model({ id: s.string().id() }).withoutRowid();
const project = s.model({ id: s.string().id(), budget: s.int() });
const schema = { user, page, secret, project, tag };

const policy = permissions({
  actor: v.object({ userId: v.string() }),
  models: {
    user: { read: true },
    page: { read: { owner: { actor: "userId" } } },
    project: { read: true, full: false, fields: { budget: { read: "full" } } },
  },
});

/** A bound control choosing the tenant, as the tenancy recipe's, with `$tenant`. */
type Tenants = { $tenant<Self>(this: Self, tenant: string): Self };
const tenancy = defineExtension<typeof schema>()({
  name: "tenancy",
  controls: { tenant: { schema: v.string(), bound: true, required: true } },
  rows: {
    control: "scope",
    default: "tenant",
    models: { page: { tenant: { root: { tenant: { control: "tenant" } } } } },
  },
  client: (scope) => {
    const methods: Tenants = {
      $tenant: (tenant) => scope.$bind({ tenant }) as never,
    };
    return methods;
  },
});

type Row = Record<string, unknown>;
const ANOTHER_VIEW = /received a \$rows\(\) fragment of another client or view/;
const ids = (rows: unknown) => (rows as Row[]).map((row) => row.id).sort();

let base: ReturnType<typeof open>;
const open = () => createClient({ schema, dataDir: ":memory:" });

beforeEach(async () => {
  base = open();
  await syncLiveSchema(base);
  await base.user.createMany({
    data: [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob" },
    ],
  });
  await base.page.createMany({
    data: [
      { id: "a", owner: "alice", title: "one", tenant: "acme" },
      { id: "b", owner: "alice", title: "two", tenant: "globex" },
      { id: "c", owner: "bob", title: "three", tenant: "acme" },
    ],
  });
  await base.secret.create({ data: { id: "s" } });
  await base.project.create({ data: { id: "x", budget: 10 } });
});

afterEach(async () => {
  await base.$disconnect();
});

describe("$rows", () => {
  test("without a rows extension it is the whole table, as a derived table", async () => {
    let statement: string | undefined;
    const seen = base.$extends({
      name: "seen",
      statement: (context) => {
        statement = context.statement.toStatement();
        return context.statement;
      },
    });
    const rows =
      await seen.$queryRaw`SELECT p.id FROM ${seen.page.$rows("p")} ORDER BY p.id`;
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(statement).toBe(
      'SELECT p.id FROM (SELECT "q0"."rowid" AS rowid, * FROM "main"."page" AS "q0" WHERE 1 = 1) AS "p" ORDER BY p.id'
    );
  });

  test("it carries the rowid an FTS5 table joins on, where the table has one", async () => {
    await base.$executeRawUnsafe(
      "CREATE VIRTUAL TABLE page_fts USING fts5(title)"
    );
    await base.$executeRawUnsafe(
      "INSERT INTO page_fts (rowid, title) SELECT rowid, title FROM page"
    );
    const alice = base.$extends(policy).$as({ userId: "alice" });
    const hits = await alice.$queryRaw`
      SELECT p.id FROM ${alice.page.$rows("p")}
      JOIN page_fts ON page_fts.rowid = p.rowid
      WHERE page_fts MATCH ${"one OR three"}`;
    expect(hits).toEqual([{ id: "a" }]);
    let statement: string | undefined;
    const seen = base.$extends({
      name: "seen",
      statement: (context) => {
        statement = context.statement.toStatement();
        return context.statement;
      },
    });
    await seen.$queryRaw`SELECT t.id FROM ${seen.tag.$rows("t")}`;
    expect(statement).toBe(
      'SELECT t.id FROM (SELECT * FROM "main"."tag" AS "q0" WHERE 1 = 1) AS "t"'
    );
  });

  test("under a policy it reads the actor's rows, composed with a JOIN", async () => {
    const db = base.$extends(policy);
    const alice = db.$as({ userId: "alice" });
    const rows = await alice.$queryRaw`
      SELECT p.id, u.name FROM ${alice.page.$rows("p")}
      JOIN ${alice.user.$rows("u")} ON u.id = p.owner
      WHERE p.title <> ${"none"} ORDER BY p.id`;
    expect(rows).toEqual([
      { id: "a", name: "Alice" },
      { id: "b", name: "Alice" },
    ]);
    expect(ids(await alice.page.findMany({ select: { id: true } }))).toEqual(
      ids(rows)
    );
  });

  test("a fragment of another view is refused, the base client's included", async () => {
    const db = base.$extends(policy);
    const alice = db.$as({ userId: "alice" });
    const bob = db.$as({ userId: "bob" });
    await expect(
      alice.$queryRaw`SELECT p.id FROM ${base.page.$rows("p")}`
    ).rejects.toThrow(ANOTHER_VIEW);
    await expect(
      alice.$queryRaw`SELECT p.id FROM ${bob.page.$rows("p")}`
    ).rejects.toThrow(ANOTHER_VIEW);
    await expect(
      base.$queryRaw`SELECT p.id FROM ${alice.page.$rows("p")}`
    ).rejects.toThrow(ANOTHER_VIEW);
    await expect(
      alice.$queryRaw`SELECT p.id FROM ${db.page.$rows("p")}`
    ).rejects.toThrow(ANOTHER_VIEW);
    // A transaction of the view keeps it.
    await expect(
      alice.$transaction(
        (tx) => tx.$queryRaw`SELECT p.id FROM ${alice.page.$rows("p")}`
      )
    ).resolves.toHaveLength(2);
  });

  test("a caller's CTE named like a table cannot stand for it", async () => {
    const bob = base
      .$extends(
        permissions({
          actor: v.object({ name: v.string() }),
          models: {
            user: { read: true },
            page: { read: { author: { name: { actor: "name" } } } },
          },
        })
      )
      .$as({ name: "Bob" });
    const plain = ids(
      await bob.$queryRaw`SELECT p.id FROM ${bob.page.$rows("p")}`
    );
    expect(plain).toEqual(["c"]);
    // A CTE naming every user Bob, and one replacing the page table.
    const shadowed = await bob.$queryRaw`
      WITH "user" AS (SELECT u0.id AS id, ${"Bob"} AS name FROM "main"."user" AS u0),
      page AS (SELECT 'x' AS id)
      SELECT p.id FROM ${bob.page.$rows("p")}`;
    expect(ids(shadowed)).toEqual(plain);
  });

  test("a domain through a relation lowers its own subquery, whatever the alias", async () => {
    const db = base.$extends(
      permissions({
        actor: v.object({ name: v.string() }),
        models: {
          user: { read: true },
          page: { read: { author: { name: { actor: "name" } } } },
        },
      })
    );
    const bob = db.$as({ name: "Bob" });
    // The caller's alias is a name the lowering mints inside: its scope
    // there is its own.
    const rows = await bob.$queryRaw`
      SELECT q1.id, o.id AS other FROM ${bob.page.$rows("q1")}
      JOIN page AS o ON o.owner = q1.owner`;
    expect(rows).toEqual([{ id: "c", other: "c" }]);
  });

  test("an unlisted model reads no row, where its findMany is refused", async () => {
    const alice = base.$extends(policy).$as({ userId: "alice" });
    await expect(alice.secret.findMany()).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(
      await alice.$queryRaw`SELECT q_1.id FROM ${alice.secret.$rows("q_1")}`
    ).toEqual([]);
  });

  test("a model whose fields are read-gated is refused", async () => {
    const alice = base.$extends(policy).$as({ userId: "alice" });
    const refused = alice.$queryRaw`SELECT * FROM ${alice.project.$rows("p")}`;
    await expect(refused).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(refused).rejects.toThrow(
      "project.$rows() refuses read-gated fields: budget"
    );
  });

  test("soft delete hides tombstoned rows", async () => {
    const db = base.$extends(
      softDelete({ models: { page: { deletedAt: "deletedAt" } } })
    );
    await db.page.delete({ where: { id: "b" } });
    expect(
      ids(await db.$queryRaw`SELECT p.id FROM ${db.page.$rows("p")}`)
    ).toEqual(["a", "c"]);
    expect(ids(await base.$queryRaw`SELECT id FROM page`)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("a bound control chooses the domain; unbound and required, it is refused", async () => {
    const db = base.$extends(tenancy);
    const acme = db.$tenant("acme");
    expect(
      ids(await acme.$queryRaw`SELECT p.id FROM ${acme.page.$rows("p")}`)
    ).toEqual(["a", "c"]);
    await expect(
      db.$queryRaw`SELECT p.id FROM ${db.page.$rows("p")}`
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("inside a transaction, it reads the transaction's view of the rows", async () => {
    const alice = base.$extends(policy).$as({ userId: "alice" });
    const rows = await alice.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO page (id, owner, title, tenant) VALUES (${"d"}, ${"alice"}, ${"four"}, ${"acme"})`;
      return tx.$queryRaw`SELECT p.id FROM ${tx.page.$rows("p")}`;
    });
    expect(ids(rows)).toEqual(["a", "b", "d"]);
    const batched = await alice.$transaction([
      alice.$queryRaw`SELECT p.id FROM ${alice.page.$rows("p")}`,
    ]);
    expect(ids(batched[0])).toEqual(["a", "b", "d"]);
  });

  test("a bad alias is refused when $rows is called", () => {
    for (const alias of ["P", "1p", "p-1", 'p"', "", "a".repeat(64)])
      expect(() => base.page.$rows(alias)).toThrow(QueryError);
    expect(() => base.page.$rows(1 as never)).toThrow(QueryError);
    expect(() => base.page.$rows("a".repeat(63))).not.toThrow();
  });

  test("it is a read of the tagged $queryRaw only", async () => {
    const rows = base.page.$rows("p");
    await expect(
      base.$executeRaw`DELETE FROM page WHERE id IN (SELECT p.id FROM ${rows})`
    ).rejects.toThrow("$executeRaw received a $rows() fragment: only");
    await expect(
      base.$queryRawUnsafe("SELECT * FROM page WHERE id = ?", rows)
    ).rejects.toThrow("$queryRawUnsafe received a $rows() fragment: only");
    await expect(
      base.$executeRawUnsafe("DELETE FROM page WHERE id = ?", rows)
    ).rejects.toThrow("$executeRawUnsafe received a $rows() fragment: only");
    // A prebuilt fragment keeps the text it first flattens to: refused.
    await expect(base.$queryRaw(sql`SELECT p.id FROM ${rows}`)).rejects.toThrow(
      "$queryRaw received a $rows() fragment: only"
    );
    await expect(
      base.$queryRaw`SELECT p.id FROM ${sql`${rows}`}`
    ).rejects.toThrow("$queryRaw received a $rows() fragment: only");
    // An ORM statement taking a caller's fragment refuses it too.
    await expect(
      base.page.findMany({ where: { title: { equals: () => rows } } })
    ).rejects.toThrow("page.$rows() is for a tagged $queryRaw only");
    expect(await base.page.count()).toBe(3);
    // Every other interpolation of a $rows-free call is unchanged.
    expect(
      ids(
        await base.$queryRaw`SELECT id FROM ${sql.raw("page")} WHERE id <> ${"z"}`
      )
    ).toEqual(["a", "b", "c"]);
  });

  test("an extension's model method cannot take its name", () => {
    expect(() =>
      base.$extends({
        name: "shadowing",
        model: { page: () => ({ $rows: () => "mine" }) },
      } as never)
    ).toThrow(
      'model method "page.$rows" collides with the existing model surface'
    );
  });

  test("a fragment of another client is refused", async () => {
    const other = open();
    try {
      await expect(
        base.$queryRaw`SELECT p.id FROM ${other.page.$rows("p")}`
      ).rejects.toThrow(
        "$queryRaw received a $rows() fragment of another client or view"
      );
    } finally {
      await other.$disconnect();
    }
  });

  test("past the driver's bind capacity, the statement is refused before dispatch", async () => {
    class SmallDriver extends SQLite3Driver {
      override readonly maxBindParametersPerStatement = 2;
    }
    const small = createBaseClient({
      schema,
      driver: new SmallDriver({ dataDir: ":memory:" }),
    });
    try {
      await syncLiveSchema(small);
      const db = small.$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: { page: { read: { id: { in: ["a", "b", "c"] } } } },
        })
      );
      const alice = db.$as({ userId: "alice" });
      await expect(
        alice.$queryRaw`SELECT p.id FROM ${alice.page.$rows("p")}`
      ).rejects.toThrow("needs 3 bound values, above the verified limit of 2");
    } finally {
      await small.$disconnect();
    }
  });
});
