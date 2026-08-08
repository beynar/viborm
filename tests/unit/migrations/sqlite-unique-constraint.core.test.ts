/**
 * How a unique constraint is spelled on SQLite, and why it has to be inline.
 *
 * SQLite has two ways to say "these columns are unique" and only one of them
 * survives a round trip through introspection AS A CONSTRAINT:
 *
 *   - an inline `CONSTRAINT x UNIQUE (...)` in `CREATE TABLE` is reported by
 *     `PRAGMA index_list` with `origin = "u"`, which `introspect` files under
 *     `uniqueConstraints`;
 *   - a standalone `CREATE UNIQUE INDEX x` is reported with `origin = "c"` and
 *     filed under `indexes`, where no declared unique constraint ever matches
 *     it.
 *
 * REGRESSION, measured on better-sqlite3 at `f78fa83`. `addUniqueConstraint`
 * emitted the standalone index, so adding `.unique([...])` to an existing model
 * left the two snapshots disagreeing about which bucket the thing is in: push
 * #2 created the index, push #3 read it back under `indexes` and planned
 * `addUniqueConstraint` again beside `dropIndex` on the same name — and since
 * `addUniqueConstraint` (priority 14) runs ahead of a superseded index drop
 * (15.5), the push died on `index "…_slug_tenant_key" already exists`. So did
 * every push after it.
 *
 * That failure was UNMASKED, not introduced, by matching constraints by shape
 * where the name cannot be read (`constraint-identity.test.ts`). Before it, the
 * foreign-key churn rebuilt the table on every push and `DROP TABLE` destroyed
 * the just-created index each time, so pushes stayed green and the unique was
 * never enforced at all. The plan doc read the two as unrelated; they are not.
 *
 * `dropUniqueConstraint` had no working spelling either: every one the differ
 * plans here names a constraint read out of `PRAGMA index_list` with
 * `origin = "u"`, i.e. `sqlite_autoindex_<table>_<n>`, and SQLite refuses
 * `DROP INDEX` on an index it created itself. That is the sibling residue — a
 * REAL change to a compound unique — and it is closed here too.
 *
 * FIX: both halves go through a table recreation, so a unique constraint on
 * SQLite is always inline. A database written by the old add heals on the next
 * push.
 */

import { createClient } from "@client/client";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import type { SQLite3Driver } from "@src/drivers/sqlite3";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

// --- schemas ---------------------------------------------------------------

const plainUser = s
  .model({ id: s.string().id(), posts: s.oneToMany(() => plainPost) })
  .map("uq_users");

const plainPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    slug: s.string(),
    tenant: s.string(),
    author: s
      .manyToOne(() => plainUser)
      .fields("authorId")
      .references("id"),
  })
  .map("uq_posts");

const uniqueUser = s
  .model({ id: s.string().id(), posts: s.oneToMany(() => uniquePost) })
  .map("uq_users");

const uniquePost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    slug: s.string(),
    tenant: s.string(),
    author: s
      .manyToOne(() => uniqueUser)
      .fields("authorId")
      .references("id"),
  })
  .unique(["slug", "tenant"])
  .map("uq_posts");

const orderAB = s
  .model({ id: s.string().id(), a: s.string(), b: s.string() })
  .unique(["a", "b"])
  .map("uq_order");

const orderBA = s
  .model({ id: s.string().id(), a: s.string(), b: s.string() })
  .unique(["b", "a"])
  .map("uq_order");

// --- helpers ---------------------------------------------------------------

type AnyDriver = { _executeRaw: SQLite3Driver["_executeRaw"] };

async function indexList(driver: AnyDriver, table: string) {
  const result = (await driver._executeRaw(
    `PRAGMA index_list("${table}")`
  )) as unknown as {
    rows: Array<{ name: string; unique: number | bigint; origin: string }>;
  };
  return result.rows.map((row) => ({
    name: row.name,
    unique: Number(row.unique),
    origin: row.origin,
  }));
}

async function createTableSql(driver: AnyDriver, table: string) {
  const result = (await driver._executeRaw(
    `SELECT sql FROM sqlite_master WHERE name = '${table}'`
  )) as unknown as { rows: Array<{ sql: string }> };
  return result.rows[0]?.sql ?? "";
}

/** The single unique constraint SQLite reports as its own (`origin = "u"`). */
async function ownedUniqueColumns(driver: AnyDriver, table: string) {
  const owned = (await indexList(driver, table)).filter(
    (index) => index.origin === "u" && index.unique === 1
  );
  const columns: string[][] = [];
  for (const index of owned) {
    const info = (await driver._executeRaw(
      `PRAGMA index_info("${index.name}")`
    )) as unknown as {
      rows: Array<{ seqno: number | bigint; name: string }>;
    };
    columns.push(
      info.rows
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => c.name)
    );
  }
  return columns;
}

// --- the defect ------------------------------------------------------------

describe("a unique constraint added to an existing SQLite table", () => {
  it("lands, is enforced, and every later push plans nothing", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: { plainUser, plainPost } as never,
      driver,
    }) as never;
    const after = createClient({
      schema: { uniqueUser, uniquePost } as never,
      driver,
    }) as never;

    await push(before, { force: true });

    // A row that must survive the recreation the add now performs.
    await driver._executeRaw(`INSERT INTO "uq_users" ("id") VALUES ('u1')`);
    await driver._executeRaw(
      `INSERT INTO "uq_posts" ("id", "authorId", "slug", "tenant") VALUES ('p1', 'u1', 's', 't')`
    );

    const planned = [
      (await push(after, { force: true })).operations.map((op) => op.type),
      // Push #3 is the one that died on `index … already exists`, and push #4
      // proves the quiet is stable rather than alternating.
      (await push(after, { force: true })).operations.map((op) => op.type),
      (await push(after, { force: true })).operations.map((op) => op.type),
    ];

    expect(planned[0]).toEqual(["addUniqueConstraint"]);
    expect(planned[1]).toEqual([]);
    expect(planned[2]).toEqual([]);

    // Inline, so SQLite owns the index and reports it as a constraint.
    expect(await createTableSql(driver, "uq_posts")).toContain(
      'CONSTRAINT "uq_posts_slug_tenant_key" UNIQUE ("slug", "tenant")'
    );
    expect(await ownedUniqueColumns(driver, "uq_posts")).toEqual([
      ["slug", "tenant"],
    ]);

    // The row is still there, and the constraint actually forbids a duplicate.
    const rows = (await driver._executeRaw(
      `SELECT "id" FROM "uq_posts"`
    )) as unknown as { rows: Array<{ id: string }> };
    expect(rows.rows.map((r) => r.id)).toEqual(["p1"]);

    await expect(
      driver._executeRaw(
        `INSERT INTO "uq_posts" ("id", "authorId", "slug", "tenant") VALUES ('p2', 'u1', 's', 't')`
      )
    ).rejects.toThrow();
  });

  it("heals a database the old standalone-index add wrote", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: { plainUser, plainPost } as never,
      driver,
    }) as never;
    const after = createClient({
      schema: { uniqueUser, uniquePost } as never,
      driver,
    }) as never;

    await push(before, { force: true });
    // Verbatim what the pre-fix `generateAddUniqueConstraint` emitted.
    await driver._executeRaw(
      'CREATE UNIQUE INDEX "uq_posts_slug_tenant_key" ON "uq_posts" ("slug", "tenant")'
    );

    const planned = [
      (await push(after, { force: true })).operations.map((op) => op.type),
      (await push(after, { force: true })).operations.map((op) => op.type),
    ];

    // The add rebuilds the table with the constraint inline; the stale index is
    // re-created by the rebuild and then dropped by the same batch.
    expect(planned[0]).toEqual(["addUniqueConstraint", "dropIndex"]);
    expect(planned[1]).toEqual([]);

    expect(await createTableSql(driver, "uq_posts")).toContain(
      'CONSTRAINT "uq_posts_slug_tenant_key" UNIQUE ("slug", "tenant")'
    );
    expect(
      (await indexList(driver, "uq_posts")).filter(
        (index) => index.name === "uq_posts_slug_tenant_key"
      )
    ).toEqual([]);
  });
});

describe("a real change to a compound unique on SQLite", () => {
  it("drops the old constraint and enforces the new column order", async () => {
    const driver = createInMemorySQLite3Driver();
    const ab = createClient({ schema: { orderAB } as never, driver }) as never;
    const ba = createClient({ schema: { orderBA } as never, driver }) as never;

    await push(ab, { force: true });
    expect(await ownedUniqueColumns(driver, "uq_order")).toEqual([["a", "b"]]);

    const planned = [
      (await push(ba, { force: true })).operations.map((op) => op.type),
      (await push(ba, { force: true })).operations.map((op) => op.type),
    ];

    // Before the fix this pair emitted `DROP INDEX "sqlite_autoindex_uq_order_2"`,
    // which SQLite refuses, and the push aborted.
    expect(planned[0]).toEqual(["dropUniqueConstraint", "addUniqueConstraint"]);
    expect(planned[1]).toEqual([]);

    expect(await ownedUniqueColumns(driver, "uq_order")).toEqual([["b", "a"]]);
    expect(await createTableSql(driver, "uq_order")).toContain(
      'CONSTRAINT "uq_order_b_a_key" UNIQUE ("b", "a")'
    );
  });
});

describe("LibSQL inherits the spelling", () => {
  it("adds a unique to an existing table and then plans nothing", async () => {
    const driver = createInMemoryLibSQLDriver();
    const before = createClient({
      schema: { plainUser, plainPost } as never,
      driver,
    }) as never;
    const after = createClient({
      schema: { uniqueUser, uniquePost } as never,
      driver,
    }) as never;

    await push(before, { force: true });

    const planned = [
      (await push(after, { force: true })).operations.map((op) => op.type),
      (await push(after, { force: true })).operations.map((op) => op.type),
      (await push(after, { force: true })).operations.map((op) => op.type),
    ];

    expect(planned[0]).toEqual(["addUniqueConstraint"]);
    expect(planned[1]).toEqual([]);
    expect(planned[2]).toEqual([]);
    expect(await ownedUniqueColumns(driver, "uq_posts")).toEqual([
      ["slug", "tenant"],
    ]);
  });
});
