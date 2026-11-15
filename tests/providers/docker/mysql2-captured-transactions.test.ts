/**
 * MySQL2 Driver Tests - what an extension captures of the writes a
 * transaction makes, on MySQL (no RETURNING: each write a part concerns reads
 * its rows back), against in-memory SQLite: `watch` told the rows of each
 * write, `settled` after the outermost commit, a `keep` delete stated as the
 * update that keeps the row, a `check` that refuses a produced row; inside a
 * callback transaction, a caught failing savepoint, a committed savepoint, and
 * array transactions that commit or are refused. Both answer the same.
 *
 * NOTE: These tests require a running MySQL database.
 */

import type { AnyDriver } from "@drivers/exports";
import {
  call,
  check,
  extension,
  keep,
  now,
  rule,
  settled,
  target,
  watch,
  writes,
} from "@src/index";
import { openOnFixture } from "@tests/contracts/public-client/on-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

/** Every write the scenario makes, what the chain was told, and what stayed. */
async function scenario(driver: AnyDriver) {
  const base = await openOnFixture(driver);
  const log: string[] = [];
  const db = base.$extends(
    extension(
      "captured",
      call((c) => {
        watch(c, {
          wants: () => true,
          rows: (model, kind, rows, nested) => {
            log.push(
              `${nested ? "nested " : ""}${model}.${kind} ${rows
                .map((row) => `${row.id}:${row.views}`)
                .join(",")}`
            );
          },
        });
        settled(c, ({ certainty }) => {
          log.push(
            `settled ${String(c.model)}.${String(c.operation)} ${certainty}`
          );
        });
      }, target(writes)),
      rule({
        post: {
          update: { check: check({ views: { lt: 100 } }) },
          delete: { instead: keep({ deletedAt: now }) },
        },
      })
    )
  );
  const failure = (error: unknown) => {
    log.push(`failed ${(error as Error).name}`);
  };
  try {
    log.push("callback");
    await db.$transaction(async (tx) => {
      await tx.post.update({ where: { id: "p1" }, data: { views: 5 } });
      await tx.post.delete({ where: { id: "p2" } });
      // A refused write fails its own savepoint: SQLite and PostgreSQL leave
      // a transaction rollback-only after a failed statement, MySQL does not.
      await tx
        .$transaction((nested) =>
          nested.post.update({ where: { id: "p3" }, data: { views: 500 } })
        )
        .catch(failure);
      await tx
        .$transaction(async (nested) => {
          await nested.post.update({ where: { id: "p1" }, data: { views: 6 } });
          throw new TypeError("nested refuses");
        })
        .catch(failure);
      await tx.$transaction(async (nested) => {
        await nested.post.update({ where: { id: "p3" }, data: { views: 7 } });
      });
      log.push("body done");
    });
    log.push("array");
    await db.$transaction([
      db.post.update({ where: { id: "p1" }, data: { views: 8 } }),
      db.post.delete({ where: { id: "p3" } }),
    ]);
    log.push("refused array");
    await db
      .$transaction([
        db.post.update({ where: { id: "p1" }, data: { views: 9 } }),
        db.post.update({ where: { id: "p1" }, data: { views: 900 } }),
      ])
      .catch(failure);
    const rows = await base.post.findMany({
      orderBy: { id: "asc" },
      select: { id: true, views: true, deletedAt: true },
    });
    return {
      log,
      rows: rows.map((row) => ({ ...row, deletedAt: row.deletedAt !== null })),
    };
  } finally {
    await base.$disconnect();
  }
}

describeIf("MySQL2 Driver: captured writes in transactions", () => {
  beforeEach(dropEveryLiveTable);
  afterAll(dropEveryLiveTable);

  test("watch, settled, keep and check in callback, nested and array transactions answer as SQLite does", async () => {
    const mysql = await scenario(createMySQL2Driver());
    const sqlite = await scenario(createInMemorySQLite3Driver());
    expect(mysql).toEqual(sqlite);
    // What both say, read once: the savepoint caught and the refused array
    // leave nothing, and settled is told after the commit only.
    expect(mysql.rows).toEqual([
      { id: "p1", views: 8, deletedAt: false },
      { id: "p2", views: 0, deletedAt: true },
      { id: "p3", views: 7, deletedAt: true },
    ]);
    const body = mysql.log.indexOf("body done");
    expect(mysql.log.findIndex((line) => line.startsWith("settled"))).toBe(
      body + 1
    );
    expect(mysql.log.filter((line) => line.includes(":6"))).toEqual([
      "post.update p1:6",
    ]);
  });

  test("on MySQL a check refusal caught in a callback leaves the transaction usable and the refused row unwritten", async () => {
    const base = await openOnFixture(createMySQL2Driver());
    try {
      const db = base.$extends(
        extension(
          "checked",
          rule({ post: { update: { check: check({ views: { lt: 100 } }) } } })
        )
      );
      const seen = await db.$transaction(async (tx) => {
        const refused = await tx.post
          .update({ where: { id: "p3" }, data: { views: 500 } })
          .catch((error: unknown) => (error as Error).name);
        await tx.post.update({ where: { id: "p1" }, data: { views: 5 } });
        return refused;
      });
      expect(seen).toBe("ForbiddenError");
      expect(
        await base.post.findMany({
          orderBy: { id: "asc" },
          select: { id: true, views: true },
        })
      ).toEqual([
        { id: "p1", views: 5 },
        { id: "p2", views: 0 },
        { id: "p3", views: 0 },
      ]);
    } finally {
      await base.$disconnect();
    }
  });
});
