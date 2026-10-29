import type { AnyDriver } from "@drivers";
import { ClientInitializationError, NotFoundError, QueryError } from "@errors";
import type { Sql } from "@sql";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { defaultOmit } from "@src/client/default-omit-extension";
import { createClient, Decimal, defineExtension, s } from "@src/index";
import { type OnEvent, on } from "@src/on";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test, vi } from "vitest";

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
    avatar: s.blob().nullable(),
    posts: s.toMany(() => post).name("author"),
    edited: s.toMany(() => post).name("editor"),
  });
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    views: s.int().default(0),
    price: s.decimal({ precision: 10, scale: 2 }).nullable(),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .name("author")
      .fields("authorId")
      .references("id"),
    editorId: s.string().nullable(),
    editor: s
      .toOne(() => user)
      .name("editor")
      .fields("editorId")
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
  avatar: null,
};
const BOB = {
  id: "u2",
  email: "bob@example.com",
  name: "Bob",
  passwordHash: "x",
  avatar: null,
};
const post = (id: string, authorId: string, views = 0) => ({
  id,
  title: `title ${id}`,
  views,
  price: null,
  authorId,
  editorId: null,
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
                avatar: null,
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
                avatar: null,
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

      test("nested writes call the nested model's hooks with its rows, the root call's event", async () => {
        const { db, calls } = await open();
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
        expect(
          calls.map((call) => [
            call.hook,
            call.rows.map((row) => row.id),
            call.event.model,
            call.event.operation,
          ])
        ).toEqual([
          ["post.update", ["p1"], "post", "update"],
          ["user.update", ["u1"], "post", "update"],
          ["user.create", ["u5"], "user", "create"],
          ["post.create", ["p9"], "user", "create"],
        ]);
        expect(calls[1]!.rows).toEqual([{ ...ADA, name: "Ada L." }]);
        expect(calls[3]!.rows).toEqual([
          { ...post("p9", "u5"), title: "nine" },
        ]);
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

      test("a failing hook never fails its write: onError receives a QueryError that says it committed", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const cause = new Error("sync is down");
        const reported: [QueryError, OnEvent][] = [];
        const db = base.$extends(
          on(
            {
              post: {
                update: () => {
                  throw cause;
                },
              },
            },
            {
              onError: (error, event) => {
                reported.push([error, event]);
              },
            }
          )
        );
        expect(
          await db.post.update({
            where: { id: "p1" },
            data: { views: 2 },
            select: { views: true },
          })
        ).toEqual({ views: 2 });
        expect(reported).toHaveLength(1);
        const [error, event] = reported[0]!;
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
        expect(error.message).toContain("post.update");
        expect(event).toMatchObject({ model: "post", operation: "update" });
      });

      test("without onError a failing hook goes to console.error; an onError that throws does too; the write resolves", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const logged: unknown[][] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
          logged.push(args);
        });
        try {
          const failing = {
            post: {
              delete: () => {
                // biome-ignore lint/style/useThrowOnlyError: a hook that throws a non-Error is the case under test.
                throw "offline";
              },
            },
          };
          await base.$extends(on(failing)).post.delete({ where: { id: "p3" } });
          expect(logged).toHaveLength(1);
          expect(logged[0]![0]).toBeInstanceOf(QueryError);
          expect((logged[0]![0] as QueryError).cause).toEqual(
            new Error("offline")
          );
          const broken = new Error("reporter down");
          await base
            .$extends(
              on(failing, {
                onError: () => {
                  throw broken;
                },
              })
            )
            .post.delete({ where: { id: "p2" } });
          expect(logged).toHaveLength(2);
          expect(logged[1]![1]).toBe(broken);
        } finally {
          spy.mockRestore();
        }
        expect(await base.post.count()).toBe(1);
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
      test("a hook failing after a transaction commits never fails the transaction", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        if (!base.$driver.supportsTransactions) return;
        const reported: QueryError[] = [];
        const db = base.$extends(
          on(
            {
              post: {
                update: () => {
                  throw new Error("down");
                },
              },
            },
            {
              onError: (error) => {
                reported.push(error);
              },
            }
          )
        );
        expect(
          await db.$transaction(async (tx) => {
            await tx.post.update({ where: { id: "p1" }, data: { views: 9 } });
            await tx.post.update({ where: { id: "p2" }, data: { views: 9 } });
            return "done";
          })
        ).toBe("done");
        expect(reported.map((error) => error.meta)).toMatchObject([
          { method: "on", commitCertainty: "committed" },
          { method: "on", commitCertainty: "committed" },
        ]);
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

    describe("nested writes", () => {
      // Groups in the order the engine wrote them, compared by hook name.
      const hooksOf = (calls: Call[]) =>
        calls
          .map((call) => [call.hook, byId(call.rows)] as const)
          .sort(([left], [right]) => left.localeCompare(right));

      test("nested create, createMany, update and upsert: each row as its write left it", async () => {
        const { db, calls } = await open();
        await db.user.update({
          where: { id: "u1" },
          data: {
            posts: {
              create: [{ id: "p7", title: "seven" }],
              createMany: { data: [{ id: "p8", title: "eight" }] },
              update: { where: { id: "p1" }, data: { views: 11 } },
              upsert: [
                {
                  where: { id: "p2" },
                  create: { id: "p2", title: "never" },
                  update: { views: 22 },
                },
                {
                  where: { id: "p9" },
                  create: { id: "p9", title: "nine" },
                  update: { views: 99 },
                },
              ],
            },
          },
        });
        const created = calls.filter((call) => call.hook === "post.create");
        const updated = calls.filter((call) => call.hook === "post.update");
        expect(created).toHaveLength(1);
        expect(updated).toHaveLength(1);
        expect(byId(created[0]!.rows)).toEqual([
          { ...post("p7", "u1"), title: "seven" },
          { ...post("p8", "u1"), title: "eight" },
          { ...post("p9", "u1"), title: "nine" },
        ]);
        expect(byId(updated[0]!.rows)).toEqual([
          post("p1", "u1", 11),
          post("p2", "u1", 22),
        ]);
        expect(calls.find((call) => call.hook === "user.update")!.rows).toEqual(
          [ADA]
        );
      });

      test("connect, connectOrCreate, disconnect and set: the rows whose foreign key moved", async () => {
        const { db, calls } = await open();
        await db.user.update({
          where: { id: "u1" },
          data: {
            posts: {
              connect: [{ id: "p3" }],
              connectOrCreate: {
                where: { id: "p6" },
                create: { id: "p6", title: "six" },
              },
            },
            edited: { connect: [{ id: "p1" }, { id: "p2" }] },
          },
        });
        expect(hooksOf(calls)).toEqual([
          ["post.create", [{ ...post("p6", "u1"), title: "six" }]],
          [
            "post.update",
            [
              { ...post("p1", "u1"), editorId: "u1" },
              { ...post("p2", "u1"), editorId: "u1" },
              post("p3", "u1"),
            ],
          ],
          ["user.update", [ADA]],
        ]);
        calls.length = 0;
        await db.user.update({
          where: { id: "u2" },
          data: {
            posts: {
              connectOrCreate: {
                where: { id: "p6" },
                create: { id: "p6", title: "never" },
              },
            },
          },
        });
        expect(
          calls
            .filter((call) => call.hook.startsWith("post."))
            .map((call) => [call.hook, byId(call.rows)])
        ).toEqual([["post.update", [{ ...post("p6", "u2"), title: "six" }]]]);
        calls.length = 0;
        await db.user.update({
          where: { id: "u1" },
          data: { edited: { disconnect: [{ id: "p1" }] } },
        });
        await db.user.update({
          where: { id: "u1" },
          data: { edited: { set: [] } },
        });
        expect(
          calls
            .filter((call) => call.hook === "post.update")
            .map((call) => byId(call.rows))
        ).toEqual([[post("p1", "u1")], [post("p2", "u1")]]);
      });

      test("nested delete and deleteMany: the rows as they were before; updateMany: after", async () => {
        const { db, calls } = await open();
        await db.user.update({
          where: { id: "u1" },
          data: {
            posts: {
              updateMany: { where: { id: "p2" }, data: { views: 5 } },
              delete: [{ id: "p1" }],
            },
          },
        });
        await db.user.update({
          where: { id: "u2" },
          data: { posts: { deleteMany: { authorId: "u2" } } },
        });
        expect(hooksOf(calls)).toEqual([
          ["post.delete", [post("p1", "u1")]],
          ["post.delete", [post("p3", "u2")]],
          ["post.update", [post("p2", "u1", 5)]],
          ["user.update", [ADA]],
          ["user.update", [BOB]],
        ]);
      });

      test("a nested soft delete is an update of the marker", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = softDelete({ models: { post: { deletedAt: "deletedAt" } } })(
          base
        ).$extends(on(hooks));
        await db.user.update({
          where: { id: "u2" },
          data: { posts: { delete: [{ id: "p3" }] } },
        });
        const updated = calls.find((call) => call.hook === "post.update")!;
        expect(updated.rows.map((row) => row.id)).toEqual(["p3"]);
        expect(updated.rows[0]!.deletedAt).toBeInstanceOf(Date);
        expect(calls.some((call) => call.hook === "post.delete")).toBe(false);
      });

      test("only the nested models a hook names are read: a root no hook names stays as it was", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const plain = statementLog(base);
        const hooked = statementLog(base);
        const seen: string[] = [];
        const db = hooked.client.$extends(
          on({
            post: {
              create: (rows) => {
                seen.push(...rows.map((row) => String(row.id)));
              },
            },
          })
        ) as typeof plain.client;
        const write = (client: typeof plain.client, id: string) =>
          client.user.update({
            where: { id: "u1" },
            data: {
              name: id,
              posts: { update: { where: { id: "p1" }, data: { views: 3 } } },
            },
          });
        await write(plain.client, "a");
        await write(db, "b");
        expect(hooked.texts).toEqual(plain.texts);
        await db.user.update({
          where: { id: "u1" },
          data: { posts: { create: [{ id: "p7", title: "seven" }] } },
        });
        expect(seen).toEqual(["p7"]);
      });

      test("inside a rolled back transaction, nested rows call no hook; in $transaction([...]) they do after the commit", async () => {
        const { base, db, calls } = await open();
        if (base.$driver.supportsTransactions) {
          await failure(
            db.$transaction(async (tx) => {
              await tx.user.update({
                where: { id: "u1" },
                data: {
                  posts: {
                    update: { where: { id: "p1" }, data: { views: 1 } },
                  },
                },
              });
              throw new Error("roll back");
            })
          );
          expect(calls).toEqual([]);
        }
        // A batch-only driver batches no nested write in an array, hooks or
        // not (`TransactionError`, as without `on()`).
        if (!base.$driver.supportsTransactions) return;
        await db.$transaction([
          db.user.update({
            where: { id: "u2" },
            data: { posts: { create: [{ id: "p7", title: "seven" }] } },
          }),
        ]);
        expect(hooksOf(calls)).toEqual([
          ["post.create", [{ ...post("p7", "u2"), title: "seven" }]],
          ["user.update", [BOB]],
        ]);
      });
    });

    describe("adversarial review", () => {
      test("an upsert inside $transaction([...]) calls its arm's hook on every driver", async () => {
        const { db, calls } = await open();
        await db.$transaction([
          db.user.upsert({
            where: { id: "u9" },
            create: { id: "u9", email: "nine@example.com", name: "Nine" },
            update: { name: "never" },
          }),
          db.user.upsert({
            where: { id: "u1" },
            create: { id: "u1", email: "never@example.com", name: "never" },
            update: { name: "Ada L." },
          }),
        ]);
        expect(
          calls.map((call) => [call.hook, call.rows.map((row) => row.id)])
        ).toEqual([
          ["user.create", ["u9"]],
          ["user.update", ["u1"]],
        ]);
      });

      test("another extension's query handler sees the call's own value, never the hook's whole rows", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const seen: unknown[] = [];
        const { calls, hooks } = recorder();
        const noting = defineExtension({
          name: "noting",
          async query({ proceed }) {
            const value = await proceed();
            seen.push(structuredClone(value));
            return value;
          },
        });
        for (const db of [
          base.$extends(on(hooks)).$extends(noting),
          base.$extends(noting).$extends(on(hooks)),
        ]) {
          seen.length = 0;
          await db.post.updateMany({
            where: { authorId: "u1" },
            data: { views: 3 },
          });
          await db.user.update({
            where: { id: "u2" },
            data: { name: "Bobby" },
            select: { id: true },
          });
          expect(seen).toEqual([{ count: 2 }, { id: "u2" }]);
        }
        expect(calls.map((call) => call.hook)).toEqual([
          "post.update",
          "user.update",
          "post.update",
          "user.update",
        ]);
      });

      test("in $transaction([...]), one member's failing hook neither fails the array nor keeps the next member's from running", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const ran: string[] = [];
        const reported: QueryError[] = [];
        const db = base.$extends(
          on(
            {
              post: {
                update: (rows) => {
                  ran.push(String(rows[0]!.id));
                  if (rows[0]!.id === "p1") throw new Error("p1 down");
                },
              },
            },
            {
              onError: (error) => {
                reported.push(error);
              },
            }
          )
        );
        await db.$transaction([
          db.post.update({ where: { id: "p1" }, data: { views: 1 } }),
          db.post.update({ where: { id: "p2" }, data: { views: 2 } }),
        ]);
        expect(ran).toEqual(["p1", "p2"]);
        expect(reported).toHaveLength(1);
      });

      test("a hook's rows and event are copies: neither the caller nor the hook changes the other's", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        if (!base.$driver.supportsTransactions) return;
        const received: Record<string, unknown>[] = [];
        let eventArgs: Record<string, unknown> | undefined;
        const db = base.$extends(
          on({
            post: {
              update: (rows, event) => {
                received.push(...rows);
                eventArgs = event.args as Record<string, unknown>;
                (event.args as { data: { views: number } }).data.views = 999;
              },
            },
          })
        );
        const args = {
          where: { id: "p1" },
          data: { views: 5, deletedAt: new Date("2026-01-01T00:00:00.000Z") },
        };
        await db.$transaction(async (tx) => {
          const row = await tx.post.update(args);
          row.deletedAt?.setUTCFullYear(1999);
          args.where.id = "changed";
        });
        expect(args.data.views).toBe(5);
        expect((received[0]!.deletedAt as Date).toISOString()).toBe(
          "2026-01-01T00:00:00.000Z"
        );
        expect(eventArgs).toMatchObject({ where: { id: "p1" } });
      });

      test("concurrent upserts of one new key a hook concerns all succeed: one create, the rest updates", async () => {
        const { db, calls } = await open();
        const upsert = (name: string) =>
          db.user.upsert({
            where: { id: "u7" },
            create: { id: "u7", email: "seven@example.com", name },
            update: { name },
          });
        const settled = await Promise.allSettled([
          upsert("a"),
          upsert("b"),
          upsert("c"),
        ]);
        expect(settled.map((each) => each.status)).toEqual([
          "fulfilled",
          "fulfilled",
          "fulfilled",
        ]);
        expect(calls.map((call) => call.hook).sort()).toEqual([
          "user.create",
          "user.update",
          "user.update",
        ]);
      });

      test("bytes in a hook's rows are its own copy", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const received: Record<string, unknown>[] = [];
        const db = base.$extends(
          on({
            user: {
              update: (rows) => {
                received.push(...rows);
              },
              delete: undefined,
            },
            post: undefined,
          })
        );
        const updated = await db.user.update({
          where: { id: "u1" },
          data: { avatar: new Uint8Array([1, 2, 3]) },
        });
        updated.avatar![0] = 9;
        expect([...(received[0]!.avatar as Uint8Array)]).toEqual([1, 2, 3]);
      });

      test("a Decimal in a hook's rows and event.args is the same immutable value", async () => {
        const { db, calls } = await open();
        const price = new Decimal("1.50");
        await db.post.update({ where: { id: "p1" }, data: { price } });
        const row = calls[0]!.rows[0]!;
        expect(row.price).toBeInstanceOf(Decimal);
        expect(String(row.price)).toBe("1.5");
        expect(
          (calls[0]!.event.args as { data: { price: Decimal } }).data.price
        ).toBe(price);
      });

      test("an empty upsert update writes nothing, a data stamp included, and calls no hook", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const db = base
          .$extends({
            name: "stamp",
            data: { models: { user: { update: { name: "stamped" } } } },
          })
          .$extends(on(hooks));
        await db.user.upsert({
          where: { id: "u1" },
          create: { id: "u1", email: "never@example.com", name: "never" },
          update: {},
        });
        expect(calls).toEqual([]);
        expect(
          (await base.user.findUniqueOrThrow({ where: { id: "u1" } })).name
        ).toBe("Ada");
      });

      test("an upsert whose update writes nothing calls no hook on the row it found", async () => {
        const { db, calls } = await open();
        await db.user.upsert({
          where: { id: "u1" },
          create: { id: "u1", email: "never@example.com", name: "never" },
          update: {},
        });
        expect(calls).toEqual([]);
      });

      test("a handler that throws after a committed write does not lose the hook", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const { calls, hooks } = recorder();
        const late = new Error("after proceed");
        const db = base.$extends(on(hooks)).$extends(
          defineExtension({
            name: "late",
            async query({ proceed }) {
              await proceed();
              throw late;
            },
          })
        );
        expect(
          await failure(
            db.post.update({ where: { id: "p1" }, data: { views: 42 } })
          )
        ).toBe(late);
        expect(calls.map((call) => call.hook)).toEqual(["post.update"]);
      });

      test("onError that is no function is refused at once", () => {
        expect(() =>
          on({}, { onError: "log" as unknown as () => undefined })
        ).toThrow(ClientInitializationError);
      });

      test("the official name is reserved, and a second on() is refused under any name", async () => {
        const { base, db } = await open();
        expect(() =>
          base.$extends({
            name: "viborm.on",
            statement: (s: { statement: Sql }) => s.statement,
          })
        ).toThrow(ClientInitializationError);
        const second = on({ user: { update: () => undefined } }) as unknown as (
          b: object
        ) => unknown;
        let definition: { name: string; query: unknown } | undefined;
        second({
          $schema: base.$schema,
          $extends: (value: { name: string; query: unknown }) => {
            definition = value;
          },
        });
        expect(() =>
          db.$extends({ ...definition!, name: "renamed" } as never)
        ).toThrow(ClientInitializationError);
      });

      test("zero cost in a failed $transaction([...]) of writes no hook concerns: the same error as without on()", async () => {
        const base = await openOnFixture(
          provider.createDriver(),
          provider.sync
        );
        opened.push(base);
        const db = base.$extends(on({ user: { delete: () => undefined } }));
        const run = (client: typeof base) =>
          failure(
            client.$transaction([
              client.post.update({ where: { id: "p1" }, data: { views: 9 } }),
              client.post.update({ where: { id: "none" }, data: { views: 9 } }),
            ])
          );
        const plain = (await run(base)) as NotFoundError;
        const hooked = (await run(db as typeof base)) as NotFoundError;
        expect(hooked).toBeInstanceOf(NotFoundError);
        expect({ ...hooked.meta, correlationId: undefined }).toEqual({
          ...plain.meta,
          correlationId: undefined,
        });
      });

      test("a declaration naming an unknown model or hook, or a hook that is no function, is refused when applied", async () => {
        const { base } = await open();
        // Untyped JavaScript: the declaration's own types refuse all three.
        const loose = on as unknown as (hooks: object) => (b: Base) => Base;
        for (const hooks of [
          { usr: { update: () => undefined } },
          { user: { updated: () => undefined } },
          { user: { update: "sync" } },
        ])
          expect(() => base.$extends(loose(hooks))).toThrow(
            ClientInitializationError
          );
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
          avatar: null,
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

      test("cache: the write invalidates, then its hooks run; the cache's failure keeps its own boundary", async () => {
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

        // Both failing: the cache's failure fails the write, as without `on`;
        // the hook's goes to onError.
        const reported: QueryError[] = [];
        const both = base
          .$extends(cache({ driver: new FailingCache() }))
          .$extends(
            on(
              {
                post: {
                  update: () => {
                    throw new Error("hook down");
                  },
                },
              },
              {
                onError: (error) => {
                  reported.push(error);
                },
              }
            )
          );
        const error = await failure(
          both.post.update({ where: { id: "p2" }, data: { views: 1 } })
        );
        expect((error as Error).name).toBe("CacheConfigurationError");
        expect(reported).toHaveLength(1);
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
