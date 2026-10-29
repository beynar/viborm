import type { AnyDriver } from "@drivers";
import { ClientInitializationError, NotFoundError, QueryError } from "@errors";
import type { Sql } from "@sql";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { defaultOmit } from "@src/client/default-omit-extension";
import { createClient, s } from "@src/index";
import { type OnEvent, on } from "@src/on";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

/**
 * `viborm/on` end to end, through public entry points only, on a real
 * database: every root trigger path, nested writes, transactions committed
 * and rolled back, payload exactness, the zero-cost case and hook failure.
 *
 * Fixture: users u1 (Ada), u2 (Bob); posts p1 (u1), p2 (u1), p3 (u2).
 * `user.passwordHash` exists to show that `defaultOmit()` hides nothing from
 * a hook; `post.deletedAt` carries soft delete.
 */

export function onSchema() {
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
    passwordHash: s.string().default("x"),
    posts: s.toMany(() => post).name("author"),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .name("author")
      .fields("authorId")
      .references("id"),
    deletedAt: s.dateTime().nullable(),
  });
  return { user, post };
}

const ADA = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada",
  passwordHash: "x",
};
const BOB = {
  id: "u2",
  email: "bob@example.com",
  name: "Bob",
  passwordHash: "x",
};
const post = (id: string, authorId: string, views = 0) => ({
  id,
  title: `title ${id}`,
  views,
  authorId,
  deletedAt: null,
});

export async function openOnFixture(
  driver: AnyDriver,
  sync: (base: SchemaClient) => Promise<unknown> = syncLiveSchema
) {
  const base = schemaClient(driver);
  await sync(base);
  await base.user.createMany({ data: [ADA, BOB] });
  await base.post.createMany({
    data: [post("p1", "u1"), post("p2", "u1"), post("p3", "u2")],
  });
  return base;
}

const schemaClient = (driver: AnyDriver) =>
  createClient({ schema: onSchema(), driver });
type SchemaClient = ReturnType<typeof schemaClient>;
type Base = Awaited<ReturnType<typeof openOnFixture>>;

/** One hook call as recorded: its hook, rows and event. */
interface Call {
  readonly hook: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly event: OnEvent;
}

/** Every hook of the fixture, recording into `calls`. */
function recorder() {
  const calls: Call[] = [];
  const hook =
    (name: string) =>
    (rows: readonly Record<string, unknown>[], event: OnEvent) => {
      calls.push({ hook: name, rows: [...rows], event });
    };
  const hooks = {
    user: {
      create: hook("user.create"),
      update: hook("user.update"),
      delete: hook("user.delete"),
    },
    post: {
      create: hook("post.create"),
      update: hook("post.update"),
      delete: hook("post.delete"),
    },
  };
  return { calls, hooks };
}

/** Every SQL text a client sends, through a statement transform. */
function statementLog(base: Base) {
  const texts: string[] = [];
  const client = base.$extends({
    name: "statement-log",
    statement({ statement }: { statement: Sql }) {
      texts.push(statement.toStatement());
      return statement;
    },
  });
  return { client, texts };
}

const byId = (rows: readonly Record<string, unknown>[]) =>
  [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** A cache whose invalidation always fails. */
class FailingCache extends MemoryCache {
  protected override clear(): Promise<void> {
    return Promise.reject(new Error("cache down"));
  }
  protected override delete(): Promise<void> {
    return Promise.reject(new Error("cache down"));
  }
}

export interface OnProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  /** Creates the fixture's tables; `syncLiveSchema` by default. */
  readonly sync?: (base: SchemaClient) => Promise<unknown>;
}

export function runOnBehavior(provider: OnProvider): void {
  describe(`${provider.name}: viborm/on`, () => {
    const opened: Base[] = [];
    afterEach(async () => {
      for (const base of opened.splice(0)) await base.$disconnect();
    });
    async function open() {
      const base = await openOnFixture(provider.createDriver(), provider.sync);
      opened.push(base);
      const { calls, hooks } = recorder();
      return { base, calls, db: base.$extends(on(hooks)) };
    }

    describe("root writes", () => {
      test("create: the created row, whole, after the write; the caller's value as asked", async () => {
        const { db, calls } = await open();
        const created = await db.user.create({
          data: { id: "u3", email: "cy@example.com", name: "Cy" },
          select: { id: true },
        });
        expect(created).toEqual({ id: "u3" });
        expect(calls).toEqual([
          {
            hook: "user.create",
            rows: [
              {
                id: "u3",
                email: "cy@example.com",
                name: "Cy",
                passwordHash: "x",
              },
            ],
            event: {
              model: "user",
              operation: "create",
              args: {
                data: { id: "u3", email: "cy@example.com", name: "Cy" },
                select: { id: true },
              },
              certainty: "committed",
            },
          },
        ]);
      });

      test("createMany: every created row; the caller still receives the count", async () => {
        const { db, calls } = await open();
        expect(
          await db.post.createMany({
            data: [post("p4", "u2", 4), post("p5", "u2", 5)],
          })
        ).toEqual({ count: 2 });
        expect(calls.map((call) => call.hook)).toEqual(["post.create"]);
        expect(byId(calls[0]!.rows)).toEqual([
          post("p4", "u2", 4),
          post("p5", "u2", 5),
        ]);
        expect(calls[0]!.event.operation).toBe("createMany");
      });

      test("createMany with skipDuplicates: only the rows it inserted", async () => {
        const { db, calls } = await open();
        expect(
          await db.post.createMany({
            data: [post("p1", "u2", 9), post("p6", "u2", 6)],
            skipDuplicates: true,
          })
        ).toEqual({ count: 1 });
        expect(calls[0]!.rows).toEqual([post("p6", "u2", 6)]);
      });

      test("update: the row as the write left it; an include and a select ride along", async () => {
        const { db, calls } = await open();
        const updated = await db.post.update({
          where: { id: "p1" },
          data: { views: { increment: 3 } },
          select: { title: true, author: { select: { name: true } } },
        });
        expect(updated).toEqual({ title: "title p1", author: { name: "Ada" } });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.hook).toBe("post.update");
        expect(calls[0]!.rows).toEqual([post("p1", "u1", 3)]);
      });

      test("updateMany: exactly the rows it matched, after the write", async () => {
        const { db, calls } = await open();
        expect(
          await db.post.updateMany({
            where: { authorId: "u1" },
            data: { views: 7 },
          })
        ).toEqual({ count: 2 });
        expect(byId(calls[0]!.rows)).toEqual([
          post("p1", "u1", 7),
          post("p2", "u1", 7),
        ]);
      });

      test("updateMany matching nothing calls no hook", async () => {
        const { db, calls } = await open();
        expect(
          await db.post.updateMany({
            where: { id: "none" },
            data: { views: 1 },
          })
        ).toEqual({ count: 0 });
        expect(calls).toEqual([]);
      });

      test("updateMany with a select returns the caller's projection, the hook whole rows", async () => {
        const { db, calls } = await open();
        const rows = await db.post.updateMany({
          where: { authorId: "u2" },
          data: { title: "t" },
          select: { id: true },
        });
        expect(rows).toEqual([{ id: "p3" }]);
        expect(calls[0]!.rows).toEqual([{ ...post("p3", "u2"), title: "t" }]);
      });

      test("upsert: the create arm calls create, the update arm update", async () => {
        const { db, calls } = await open();
        await db.user.upsert({
          where: { id: "u9" },
          create: { id: "u9", email: "nine@example.com", name: "Nine" },
          update: { name: "never" },
        });
        await db.user.upsert({
          where: { id: "u1" },
          create: { id: "u1", email: "never@example.com", name: "never" },
          update: { name: "Ada L." },
          select: { id: true },
        });
        expect(calls.map((call) => [call.hook, call.rows])).toEqual([
          [
            "user.create",
            [
              {
                id: "u9",
                email: "nine@example.com",
                name: "Nine",
                passwordHash: "x",
              },
            ],
          ],
          ["user.update", [{ ...ADA, name: "Ada L." }]],
        ]);
        expect(calls.map((call) => call.event.operation)).toEqual([
          "upsert",
          "upsert",
        ]);
      });

      test("an upsert whose condition skips the update writes nothing and calls no hook", async () => {
        const { db, calls } = await open();
        const unchanged = await db.post.upsert({
          where: { id: "p1" },
          create: { id: "p1", title: "never", authorId: "u1" },
          update: { views: 5 },
          setWhere: { views: 99 },
          select: { views: true },
        });
        expect(unchanged).toEqual({ views: 0 });
        expect(calls).toEqual([]);
      });

      test("delete and deleteMany: the rows as they were before", async () => {
        const { db, calls } = await open();
        expect(
          await db.post.delete({ where: { id: "p3" }, select: { id: true } })
        ).toEqual({ id: "p3" });
        expect(await db.post.deleteMany({ where: { authorId: "u1" } })).toEqual(
          { count: 2 }
        );
        expect(calls.map((call) => call.hook)).toEqual([
          "post.delete",
          "post.delete",
        ]);
        expect(calls[0]!.rows).toEqual([post("p3", "u2")]);
        expect(byId(calls[1]!.rows)).toEqual([
          post("p1", "u1"),
          post("p2", "u1"),
        ]);
      });

      test("connect through the called row's own foreign key: that row's update, with the new key", async () => {
        const { db, calls } = await open();
        await db.post.update({
          where: { id: "p3" },
          data: { author: { connect: { id: "u1" } } },
        });
        expect(calls.map((call) => [call.hook, call.rows])).toEqual([
          ["post.update", [post("p3", "u1")]],
        ]);
      });

      test("a nested write calls the root row's hook, never the nested model's", async () => {
        const { db, base, calls } = await open();
        await db.post.update({
          where: { id: "p1" },
          data: { title: "t", author: { update: { name: "Ada L." } } },
        });
        await db.user.create({
          data: {
            id: "u5",
            email: "five@example.com",
            name: "Five",
            posts: { create: [{ id: "p9", title: "nine" }] },
          },
        });
        expect(calls.map((call) => call.hook)).toEqual([
          "post.update",
          "user.create",
        ]);
        expect(calls[0]!.rows).toEqual([{ ...post("p1", "u1"), title: "t" }]);
        // The nested rows were written all the same.
        expect(
          await base.user.findUniqueOrThrow({
            where: { id: "u1" },
            select: { name: true },
          })
        ).toEqual({ name: "Ada L." });
        expect(
          await base.post.findUniqueOrThrow({
            where: { id: "p9" },
            select: { authorId: true },
          })
        ).toEqual({ authorId: "u5" });
      });

      test("a write that fails calls no hook", async () => {
        const { db, calls } = await open();
        expect(
          await failure(
            db.post.update({ where: { id: "none" }, data: { views: 1 } })
          )
        ).toBeInstanceOf(NotFoundError);
        expect(calls).toEqual([]);
      });
    });

    describe("execution", () => {
      test("VibORM awaits the hook's promise before the write resolves", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const order: string[] = [];
        const db = base.$extends(
          on({
            post: {
              update: async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                order.push("hook");
              },
            },
          })
        );
        await db.post.update({ where: { id: "p1" }, data: { views: 1 } });
        order.push("resolved");
        expect(order).toEqual(["hook", "resolved"]);
      });

      test("a failing hook rejects the write with a QueryError that says it committed; the row stays", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const cause = new Error("sync is down");
        const db = base.$extends(
          on({
            post: {
              update: () => {
                throw cause;
              },
            },
          })
        );
        const error = await failure(
          db.post.update({ where: { id: "p1" }, data: { views: 2 } })
        );
        expect(error).toBeInstanceOf(QueryError);
        expect(error).toMatchObject({
          cause,
          meta: {
            method: "on",
            model: "post",
            operation: "update",
            commitCertainty: "committed",
          },
        });
        expect((error as Error).message).toContain("post.update");
        expect(
          (
            await base.post.findUniqueOrThrow({
              where: { id: "p1" },
              select: { views: true },
            })
          ).views
        ).toBe(2);
      });

      test("a hook that throws something other than an Error still says the write committed", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const db = base.$extends(
          on({
            post: {
              delete: () => {
                // biome-ignore lint/style/useThrowOnlyError: a hook that throws a non-Error is the case under test.
                throw "offline";
              },
            },
          })
        );
        const error = await failure(db.post.delete({ where: { id: "p3" } }));
        expect(error).toBeInstanceOf(QueryError);
        expect((error as QueryError).cause).toEqual(new Error("offline"));
        expect((error as QueryError).meta.commitCertainty).toBe("committed");
        expect(await base.post.count()).toBe(2);
      });

      test("what a hook costs: an upsert keeps its one statement where the adapter marks an inserted row; without RETURNING a bulk write reads its rows in one statement", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const plain = statementLog(base);
        const hooked = statementLog(base);
        const { calls, hooks } = recorder();
        const db = hooked.client.$extends(on(hooks)) as typeof plain.client;
        const count = async (
          log: { texts: string[] },
          write: () => Promise<unknown>
        ) => {
          const before = log.texts.length;
          await write();
          return log.texts.length - before;
        };
        const adapter = base.$driver.adapter;
        const upsert = (client: typeof plain.client, id: string) =>
          client.post.upsert({
            where: { id },
            create: { id, title: "t", authorId: "u1" },
            update: { views: 1 },
          });
        const upserts = [
          await count(hooked, () => upsert(db, "p1")),
          await count(hooked, () => upsert(db, "p7")),
        ];
        expect(calls.map((call) => call.hook)).toEqual([
          "post.update",
          "post.create",
        ]);
        if (
          adapter.mutations.upserted !== undefined &&
          adapter.capabilities.supportsTargetedUpsert
        )
          expect(upserts).toEqual([
            await count(plain, () => upsert(plain.client, "p1")),
            await count(plain, () => upsert(plain.client, "p8")),
          ]);
        if (adapter.capabilities.supportsReturning) return;
        // MySQL's shape: N rows with known keys are one INSERT and one read;
        // a delete locks and reads its rows in one statement, then deletes.
        expect(
          await count(hooked, () =>
            db.post.createMany({
              data: [post("m1", "u2"), post("m2", "u2"), post("m3", "u2")],
            })
          )
        ).toBe(2);
        expect(
          await count(hooked, () =>
            db.post.deleteMany({ where: { authorId: "u2" } })
          )
        ).toBe(2);
        expect(
          await count(plain, () =>
            plain.client.post.delete({
              where: { id: "p2" },
              select: { id: true, title: true },
            })
          )
        ).toBe(2);
      });

      test("zero cost: a write no hook concerns sends exactly the statements it sends without the extension", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const plain = statementLog(base);
        const hooked = statementLog(base);
        const db = hooked.client.$extends(
          on({ user: { update: () => undefined } })
        );
        const writes = (client: typeof plain.client) => [
          () => client.post.update({ where: { id: "p1" }, data: { views: 1 } }),
          () =>
            client.post.updateMany({
              where: { authorId: "u1" },
              data: { views: 2 },
            }),
          () => client.post.createMany({ data: [post("p8", "u1")] }),
          () => client.post.deleteMany({ where: { id: "p8" } }),
          () =>
            client.user.create({
              data: { id: "u8", email: "e8@example.com", name: "E" },
            }),
          () => client.user.deleteMany({ where: { id: "u8" } }),
        ];
        for (const write of writes(plain.client)) await write();
        for (const write of writes(db as typeof plain.client)) await write();
        expect(hooked.texts).toEqual(plain.texts);
      });
    });

    describe("application", () => {
      test("one client carries one on(): a second is refused", async () => {
        const { db } = await open();
        expect(() => db.$extends(on({ user: {} }))).toThrow(
          ClientInitializationError
        );
      });

      test("applied per request, each client's hooks close over their own values", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const seen: string[] = [];
        const hooks = (request: string) =>
          on({
            post: {
              update: (rows) => {
                seen.push(`${request}:${rows[0]!.id}`);
              },
            },
          });
        await Promise.all([
          base
            .$extends(hooks("a"))
            .post.update({ where: { id: "p1" }, data: { views: 1 } }),
          base
            .$extends(hooks("b"))
            .post.update({ where: { id: "p2" }, data: { views: 1 } }),
        ]);
        expect(seen.sort()).toEqual(["a:p1", "b:p2"]);
      });

      test("a hook sees the writes of a chain observed by another extension", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        let units = 0;
        const db = base
          .$extends({
            name: "observer",
            observe: () => {
              units += 1;
            },
          })
          .$extends(on(hooks));
        await db.post.update({ where: { id: "p1" }, data: { views: 1 } });
        expect(units).toBeGreaterThan(0);
        expect(calls.map((call) => call.hook)).toEqual(["post.update"]);
      });
    });

    describe("transactions", () => {
      test("a hook failing after a transaction commits rejects the transaction; its writes stay", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        if (!base.$driver.supportsTransactions) return;
        const db = base.$extends(
          on({
            post: {
              update: () => {
                throw new Error("down");
              },
            },
          })
        );
        const error = await failure(
          db.$transaction(async (tx) => {
            await tx.post.update({ where: { id: "p1" }, data: { views: 9 } });
          })
        );
        expect(error).toBeInstanceOf(QueryError);
        expect(error).toMatchObject({
          meta: { method: "on", commitCertainty: "committed" },
        });
        expect(
          (
            await base.post.findUniqueOrThrow({
              where: { id: "p1" },
              select: { views: true },
            })
          ).views
        ).toBe(9);
      });

      test("$transaction([...]) runs one member's hooks after another's", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const order: string[] = [];
        const db = base.$extends(
          on({
            post: {
              update: async (rows) => {
                order.push(`start ${rows[0]!.id}`);
                await new Promise((resolve) => setTimeout(resolve, 5));
                order.push(`end ${rows[0]!.id}`);
              },
            },
          })
        );
        await db.$transaction([
          db.post.update({ where: { id: "p1" }, data: { views: 1 } }),
          db.post.update({ where: { id: "p2" }, data: { views: 1 } }),
        ]);
        expect(order).toEqual(["start p1", "end p1", "start p2", "end p2"]);
      });

      test("inside a callback transaction, hooks wait for the commit", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const order: string[] = [];
        const db = base.$extends(
          on({
            post: {
              update: () => {
                order.push("hook");
              },
            },
          })
        );
        if (!base.$driver.supportsTransactions) return;
        await db.$transaction(async (tx) => {
          await tx.post.update({ where: { id: "p1" }, data: { views: 1 } });
          order.push("written");
          await tx.post.update({ where: { id: "p2" }, data: { views: 2 } });
          order.push("body done");
        });
        order.push("transaction resolved");
        expect(order).toEqual([
          "written",
          "body done",
          "hook",
          "hook",
          "transaction resolved",
        ]);
      });

      test("a rolled back transaction calls no hook", async () => {
        const { base, db, calls } = await open();
        if (!base.$driver.supportsTransactions) return;
        const boom = new Error("roll back");
        expect(
          await failure(
            db.$transaction(async (tx) => {
              await tx.post.update({ where: { id: "p1" }, data: { views: 1 } });
              throw boom;
            })
          )
        ).toBe(boom);
        expect(calls).toEqual([]);
      });

      test("a rolled back savepoint drops its writes' hooks and keeps the outer ones", async () => {
        const { base, db, calls } = await open();
        if (!base.$driver.supportsTransactions) return;
        await db.$transaction(async (tx) => {
          await tx.post.update({ where: { id: "p1" }, data: { views: 1 } });
          await failure(
            tx.$transaction(async (inner) => {
              await inner.post.update({
                where: { id: "p2" },
                data: { views: 2 },
              });
              throw new Error("inner");
            })
          );
          await tx.$transaction(async (inner) => {
            await inner.post.update({
              where: { id: "p3" },
              data: { views: 3 },
            });
          });
          expect(calls).toEqual([]);
        });
        expect(calls.map((call) => call.rows.map((row) => row.id))).toEqual([
          ["p1"],
          ["p3"],
        ]);
      });

      test("$transaction([...]): every member's hook after the commit, in order", async () => {
        const { db, calls } = await open();
        const [updated, count] = await db.$transaction([
          db.post.update({
            where: { id: "p1" },
            data: { views: 5 },
            select: { id: true },
          }),
          db.post.deleteMany({ where: { id: "p3" } }),
        ]);
        expect(updated).toEqual({ id: "p1" });
        expect(count).toEqual({ count: 1 });
        expect(calls.map((call) => [call.hook, call.rows])).toEqual([
          ["post.update", [post("p1", "u1", 5)]],
          ["post.delete", [post("p3", "u2")]],
        ]);
      });
    });

    describe("interplay", () => {
      test("defaultOmit hides a field from the caller, never from the hook", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = base
          .$extends(
            defaultOmit<ReturnType<typeof onSchema>>()({
              user: { passwordHash: true },
            })
          )
          .$extends(on(hooks));
        const updated = await db.user.update({
          where: { id: "u1" },
          data: { name: "Ada L." },
        });
        expect(updated).toEqual({
          id: "u1",
          email: "ada@example.com",
          name: "Ada L.",
        });
        expect(calls[0]!.rows).toEqual([{ ...ADA, name: "Ada L." }]);
      });

      test("computed result fields reach the caller, never the hook", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = base.$extends(on(hooks)).$extends({
          name: "names",
          result: {
            user: {
              label: {
                needs: { name: true, email: true },
                compute: (user) => `${user.name} <${user.email}>`,
              },
            },
          },
        });
        const updated = await db.user.update({
          where: { id: "u2" },
          data: { name: "Bobby" },
          select: { label: true },
        });
        expect(updated).toEqual({ label: "Bobby <bob@example.com>" });
        expect(calls[0]!.rows).toEqual([{ ...BOB, name: "Bobby" }]);
      });

      test("cache: the write invalidates, then its hooks run; both failures are kept", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = base
          .$extends(cache({ driver: new MemoryCache() }))
          .$extends(on(hooks));
        const cached = await db.$withCache().post.findUniqueOrThrow({
          where: { id: "p1" },
          select: { views: true },
        });
        expect(cached.views).toBe(0);
        await db.post.update({ where: { id: "p1" }, data: { views: 4 } });
        expect(calls.map((call) => call.hook)).toEqual(["post.update"]);
        expect(
          (
            await db.$withCache().post.findUniqueOrThrow({
              where: { id: "p1" },
              select: { views: true },
            })
          ).views
        ).toBe(4);

        // The cache's failure alone, after a hook that succeeded.
        const invalidating = base
          .$extends(cache({ driver: new FailingCache() }))
          .$extends(on(hooks));
        const alone = await failure(
          invalidating.post.update({ where: { id: "p3" }, data: { views: 1 } })
        );
        expect(alone).not.toBeInstanceOf(AggregateError);
        expect((alone as Error).name).toBe("CacheConfigurationError");
        expect(calls.map((call) => call.hook)).toEqual([
          "post.update",
          "post.update",
        ]);

        const failingDriver = new FailingCache();
        const both = base.$extends(cache({ driver: failingDriver })).$extends(
          on({
            post: {
              update: () => {
                throw new Error("hook down");
              },
            },
          })
        );
        const error = await failure(
          both.post.update({ where: { id: "p2" }, data: { views: 1 } })
        );
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toHaveLength(2);
      });

      test("soft delete: a delete is an update of the marker; a hard delete is a delete", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = softDelete({ models: { post: { deletedAt: "deletedAt" } } })(
          base
        ).$extends(on(hooks));
        await db.post.delete({ where: { id: "p1" } });
        await db.post.deleteMany({ where: { id: "p2" } });
        await db.post.delete({ where: { id: "p3" }, mode: "hard" });
        expect(calls.map((call) => call.hook)).toEqual([
          "post.update",
          "post.update",
          "post.delete",
        ]);
        expect(calls[0]!.rows[0]!.deletedAt).toBeInstanceOf(Date);
        expect(calls[1]!.rows.map((row) => row.id)).toEqual(["p2"]);
        expect(calls[1]!.rows[0]!.deletedAt).toBeInstanceOf(Date);
        expect(calls[2]!.rows).toEqual([post("p3", "u2")]);
        expect(calls.map((call) => call.event.operation)).toEqual([
          "delete",
          "deleteMany",
          "delete",
        ]);
      });

      test("a deletion that always tombstones is an update", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = base
          .$extends({
            name: "archive",
            deletion: { models: { post: { at: "deletedAt" } } },
          })
          .$extends(on(hooks));
        await db.post.delete({ where: { id: "p1" } });
        expect(calls.map((call) => call.hook)).toEqual(["post.update"]);
        expect(calls[0]!.rows[0]!.deletedAt).toBeInstanceOf(Date);
      });

      test("permissions: a permitted write calls its hook, a refused one does not", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = permissions({
          actor: v.object({ userId: v.string() }),
          models: {
            post: {
              read: true,
              update: { authorId: { actor: "userId" } },
            },
          },
        })(base).$extends(on(hooks));
        const ada = db.$as({ userId: "u1" });
        await ada.post.update({ where: { id: "p1" }, data: { views: 1 } });
        expect(
          await failure(
            ada.post.update({ where: { id: "p3" }, data: { views: 1 } })
          )
        ).toBeInstanceOf(NotFoundError);
        expect(
          await ada.post.updateMany({ where: {}, data: { views: 4 } })
        ).toEqual({ count: 2 });
        expect(calls.map((call) => call.rows.map((row) => row.id))).toEqual([
          ["p1"],
          ["p1", "p2"],
        ]);
      });
    });
  });
}
