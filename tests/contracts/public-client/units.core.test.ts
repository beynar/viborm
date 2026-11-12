/**
 * `retry`, `route` and `transaction`: the points where an extension decides
 * how a call's unit is sent, through public entry points only.
 */

import type { Sql } from "@sql";
import { sql, type WrittenWatch } from "@src/index";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
import { afterEach, describe, expect, test } from "vitest";
import { openOnFixture } from "./on-behavior";

type Base = Awaited<ReturnType<typeof openOnFixture>>;

/** A statement transform that fails the first `times` statements matching `text`. */
function failing(text: string, times = 1) {
  let left = times;
  return {
    name: "failing",
    statement({ statement }: { statement: Sql }) {
      if (left > 0 && statement.toStatement().includes(text)) {
        left -= 1;
        throw new Error("connection lost");
      }
      return statement;
    },
  };
}

describe("retry, route, transaction", () => {
  const opened: Base[] = [];
  afterEach(async () => {
    for (const base of opened.splice(0)) await base.$disconnect();
  });
  async function open() {
    const base = await openOnFixture(createInMemorySQLite3Driver());
    opened.push(base);
    return base;
  }

  test("retry: a read that failed is made again where a handler says so, told the error, the attempt and the call", async () => {
    const base = await open();
    const asked: unknown[] = [];
    const db = base.$extends(failing("SELECT", 2)).$extends({
      name: "resilient",
      retry(error, attempt, call) {
        asked.push([(error as Error).message, attempt, call]);
        return attempt < 3;
      },
    });
    const users = await db.user.findMany({ where: { id: "u1" } });
    expect(users.map((user) => user.id)).toEqual(["u1"]);
    expect(asked).toEqual([
      [
        expect.stringContaining("statement handler"),
        1,
        { model: "user", operation: "findMany" },
      ],
      [
        expect.stringContaining("statement handler"),
        2,
        { model: "user", operation: "findMany" },
      ],
    ]);
  });

  test("retry: a handler that says no leaves the failure as it is", async () => {
    const base = await open();
    const db = base.$extends(failing("SELECT")).$extends({
      name: "resilient",
      retry: () => false,
    });
    const error = (await failure(db.user.findMany())) as Error;
    expect(error.message).toContain("statement handler");
  });

  test("retry: a write whose own transaction was undone is made again, and written once", async () => {
    const base = await open();
    const db = base.$extends(failing("INSERT")).$extends({
      name: "resilient",
      retry: (_error, attempt) => attempt < 2,
    });
    // A nested write is sent in a transaction of its own.
    await db.user.update({
      where: { id: "u1" },
      data: { name: "Again", posts: { create: { id: "p9", title: "new" } } },
    });
    expect(
      await base.user.findUniqueOrThrow({
        where: { id: "u1" },
        select: { name: true, posts: { select: { id: true } } },
      })
    ).toEqual({
      name: "Again",
      posts: [{ id: "p1" }, { id: "p2" }, { id: "p9" }],
    });
  });

  test("retry: a write sent as one statement outside a transaction is not asked, since nothing proves it undone", async () => {
    const base = await open();
    let asked = 0;
    const db = base.$extends(failing("UPDATE")).$extends({
      name: "resilient",
      retry() {
        asked += 1;
        return true;
      },
    });
    await failure(
      db.post.update({ where: { id: "p1" }, data: { views: { increment: 1 } } })
    );
    expect(asked).toBe(0);
  });

  test("retry: a call inside a transaction is never asked", async () => {
    const base = await open();
    let asked = 0;
    const db = base.$extends(failing("SELECT")).$extends({
      name: "resilient",
      retry() {
        asked += 1;
        return true;
      },
    });
    await failure(db.$transaction((tx) => tx.user.findMany()));
    expect(asked).toBe(0);
  });

  test("retry: a write that committed is never asked, whatever fails after it", async () => {
    const base = await open();
    let asked = 0;
    const db = base
      .$extends({
        name: "broken",
        written: (): WrittenWatch => ({
          wants: () => false,
          rows: () => undefined,
          settled() {
            throw new Error("after commit");
          },
        }),
      })
      .$extends({
        name: "resilient",
        retry() {
          asked += 1;
          return true;
        },
      });
    await failure(
      db.post.update({ where: { id: "p1" }, data: { views: { increment: 1 } } })
    );
    expect(asked).toBe(0);
    expect(
      (await base.post.findUniqueOrThrow({ where: { id: "p1" } })).views
    ).toBe(1);
  });

  test("route: a read outside a transaction goes to the driver a handler names; a write and a read in a transaction do not", async () => {
    const base = await open();
    const replica = await openOnFixture(createInMemorySQLite3Driver());
    opened.push(replica);
    await replica.user.update({
      where: { id: "u1" },
      data: { name: "On the replica" },
    });
    const asked: unknown[] = [];
    const db = base.$extends({
      name: "replicas",
      route(read) {
        asked.push([read.model, read.operation, read.args]);
        return read.model === "user" ? replica.$driver : undefined;
      },
    });
    const name = async (client: {
      user: Pick<typeof db.user, "findUniqueOrThrow">;
    }) => (await client.user.findUniqueOrThrow({ where: { id: "u1" } })).name;

    expect(await name(db)).toBe("On the replica");
    expect(asked).toEqual([
      ["user", "findUniqueOrThrow", { where: { id: "u1" } }],
    ]);
    // A model no handler routes is read where it is.
    expect((await db.post.findMany()).length).toBe(3);
    // A write is never routed, and writes the client's own database.
    await db.user.update({ where: { id: "u1" }, data: { name: "Primary" } });
    expect(await name(base)).toBe("Primary");
    expect(await name(db)).toBe("On the replica");
    // Inside a transaction, a read is the transaction's.
    expect(await db.$transaction((tx) => name(tx))).toBe("Primary");
  });

  test("transaction: its statements run first in each transaction the client opens, a write's own included, and not in a savepoint", async () => {
    const base = await open();
    const texts: string[] = [];
    const db = base
      .$extends({
        name: "session",
        async transaction(run) {
          const rows = await run(sql`SELECT 41 + 1 AS opened`);
          texts.push(`opened ${rows[0]!.opened}`);
        },
      })
      .$extends({
        name: "log",
        statement({ statement }: { statement: Sql }) {
          texts.push(statement.toStatement().split(" ")[0]!);
          return statement;
        },
      });

    await db.$transaction(async (tx) => {
      await tx.user.findMany();
      // A savepoint opens no transaction.
      await tx.$transaction((inner) => inner.post.findMany());
    });
    expect(texts.filter((text) => text.startsWith("opened"))).toEqual([
      "opened 42",
    ]);
    expect(texts.indexOf("opened 42")).toBeLessThan(
      texts.lastIndexOf("SELECT")
    );

    texts.length = 0;
    // A nested write is sent in a transaction of its own.
    await db.user.update({
      where: { id: "u1" },
      data: { posts: { create: { id: "p9", title: "new" } } },
    });
    expect(texts.filter((text) => text.startsWith("opened"))).toEqual([
      "opened 42",
    ]);
  });

  test("transaction: what it throws fails the transaction before its body runs", async () => {
    const base = await open();
    let ran = false;
    const db = base.$extends({
      name: "session",
      transaction() {
        throw new Error("no session");
      },
    });
    const error = (await failure(
      db.$transaction(async (tx) => {
        ran = true;
        await tx.user.findMany();
      })
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(ran).toBe(false);
  });

  test("each point must be a function", async () => {
    const base = await open();
    for (const point of ["retry", "route", "transaction"])
      expect(() =>
        base.$extends({ name: "bad", [point]: true } as never)
      ).toThrow(`Extension "bad" ${point} must be a function.`);
  });
});
