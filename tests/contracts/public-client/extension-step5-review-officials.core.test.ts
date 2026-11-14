/**
 * Adversarial review of step 5: the official extensions applied in one step,
 * in any position of a chain. Every call is made on chains that differ only
 * by the order of `softDelete` and `permissions`, and their answers must be
 * the same.
 *
 * Runs on in-memory SQLite.
 */

import { defaultOmit } from "@client/default-omit-extension";
import { createClient } from "@drivers/sqlite3";
import { ForbiddenError, VibORMError } from "@errors";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  deletedAt: s.dateTime().nullable(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const note = s.model({ id: s.string().id(), body: s.string() });
const schema = { user, post, note };

type Row = Record<string, unknown>;
type Method = (args?: object) => Promise<unknown>;
type Delegate = Record<string, Method>;
interface Loose {
  user: Delegate;
  post: Delegate;
  note: Delegate;
  $extends(value: unknown): Loose;
  $transaction(run: readonly unknown[]): Promise<unknown>;
  $as(actor: unknown): Loose;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function seeded(): Promise<Loose> {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  await base.user.create({ data: { id: "u1", name: "Ann" } });
  await base.user.create({ data: { id: "u2", name: "Bob" } });
  for (const [id, authorId] of [
    ["a", "u1"],
    ["b", "u1"],
    ["c", "u2"],
  ] as const)
    await base.post.create({ data: { id, title: id, authorId } });
  await base.note.create({ data: { id: "n1", body: "x" } });
  return base;
}

const policy = () =>
  permissions({
    actor: v.object({ userId: v.string() }),
    models: {
      post: {
        read: {},
        create: { authorId: { actor: "userId" } },
        update: { authorId: { actor: "userId" } },
        delete: { authorId: { actor: "userId" } },
      },
      user: { read: {} },
    },
  } as never);
const tombstones = () =>
  softDelete({ models: { post: { deletedAt: "deletedAt" } } } as never);

/** An answer: a value cut to what is compared, or an error's class. */
async function answer(call: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await call();
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        item instanceof Object && "deletedAt" in item
          ? { ...item, deletedAt: item.deletedAt === null ? null : "set" }
          : item
      )
    );
  } catch (error) {
    return { error: (error as Error).constructor.name };
  }
}

async function script(db: Loose, base: Loose): Promise<unknown[]> {
  const u1 = db.$as({ userId: "u1" });
  const u2 = db.$as({ userId: "u2" });
  const list = () =>
    base.post.findMany({
      orderBy: { id: "asc" },
      select: { id: true, deletedAt: true },
    });
  return [
    await answer(() => u1.post.findMany({ orderBy: { id: "asc" } })),
    await answer(() => u1.post.delete({ where: { id: "c" } })),
    await answer(() =>
      u1.post.delete({ where: { id: "a" }, select: { id: true } })
    ),
    await answer(list),
    await answer(() =>
      u1.post.findMany({ deleted: "with", select: { id: true } })
    ),
    await answer(() =>
      u1.post.findMany({ deleted: "only", select: { id: true } })
    ),
    await answer(
      () =>
        u2.post.restore?.({ where: { id: "a" } }) ??
        Promise.reject(new Error("no restore"))
    ),
    await answer(() =>
      u1.user.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          posts: { select: { id: true }, orderBy: { id: "asc" } },
        },
      })
    ),
    await answer(() => u1.post.count({})),
    await answer(() =>
      u1.post.updateMany({ where: {}, data: { title: "mine" } })
    ),
    await answer(list),
    await answer(
      () =>
        u1.post.restore?.({ where: { id: "a" }, select: { id: true } }) ??
        Promise.reject(new Error("no restore"))
    ),
    await answer(
      () =>
        u2.post.purge?.({ where: { id: "b" } }) ??
        Promise.reject(new Error("no purge"))
    ),
    await answer(() =>
      u1.post.delete({ where: { id: "b" }, mode: "hard", select: { id: true } })
    ),
    await answer(list),
    await answer(() =>
      u1.$transaction([
        u1.post.findMany({ select: { id: true } }),
        u1.post.delete({ where: { id: "a" }, select: { id: true } }),
      ])
    ),
    await answer(list),
    await answer(() => u1.note.findMany({})),
  ];
}

describe("softDelete and permissions, in either order", () => {
  test("the same calls answer the same whichever is applied first", async () => {
    const first = await seeded();
    const softFirst = await script(
      first.$extends(tombstones()).$extends(policy()),
      first
    );
    const second = await seeded();
    const policyFirst = await script(
      second.$extends(policy()).$extends(tombstones()),
      second
    );
    expect(policyFirst).toEqual(softFirst);
    // What the answers are, on the order the docs show.
    expect(softFirst[1]).toEqual({ error: expect.stringMatching(/Error$/) });
    expect(softFirst[3]).toEqual([
      { id: "a", deletedAt: "set" },
      { id: "b", deletedAt: null },
      { id: "c", deletedAt: null },
    ]);
    expect(softFirst[softFirst.length - 1]).toEqual({
      error: "ForbiddenError",
    });
  });
});

describe("permissions: D3, the refusal before validation", () => {
  test("a create on a model without create is refused; a malformed one too, as ForbiddenError", async () => {
    const base = await seeded();
    const db = base
      .$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: { post: { read: {} }, user: { read: {} } },
        } as never)
      )
      .$as({ userId: "u1" });
    expect(
      await answer(() =>
        db.post.create({ data: { id: "z", title: "z", authorId: "u1" } })
      )
    ).toEqual({ error: "ForbiddenError" });
    expect(await answer(() => db.post.create({ data: { nope: 1 } }))).toEqual({
      error: "ForbiddenError",
    });
    expect(
      await answer(() => db.note.findMany({ where: { nope: 1 } }))
    ).toEqual({ error: "ForbiddenError" });
  });

  test("a call on a model outside the policy is refused even when an earlier extension's first moment would patch it", async () => {
    const base = await seeded();
    const db = base.$extends(policy()).$as({ userId: "u1" });
    const error = await db.note.findMany({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toBeInstanceOf(VibORMError);
  });
});

describe("permissions: an `as` mode a model does not declare", () => {
  test("is refused before validation, as ForbiddenError, and reaches no row", async () => {
    const base = await seeded();
    const db = base.$extends(policy()).$as({ userId: "u1" });
    // `post` declares `update`, `user` does not: one `as` name space.
    expect(
      await answer(() =>
        db.post.findMany({ as: "update", select: { id: true } })
      )
    ).toEqual([{ id: "a" }, { id: "b" }]);
    expect(await answer(() => db.user.findMany({ as: "update" }))).toEqual({
      error: "ForbiddenError",
    });
    expect(
      await answer(() => db.user.findMany({ as: "update", where: { nope: 1 } }))
    ).toEqual({ error: "ForbiddenError" });
  });
});

describe("permissions: an update that writes the field its rule reads", () => {
  test("is allowed when the row it leaves still holds the rule, refused when it does not", async () => {
    const base = await seeded();
    const u1 = base.$extends(policy()).$as({ userId: "u1" });
    expect(
      await answer(() =>
        u1.post.update({
          where: { id: "a" },
          data: { authorId: "u1", title: "same author" },
          select: { title: true },
        })
      )
    ).toEqual({ title: "same author" });
    expect(
      await answer(() =>
        u1.post.update({ where: { id: "a" }, data: { authorId: "u2" } })
      )
    ).toEqual({ error: "ForbiddenError" });
  });
});

describe("defaultOmit", () => {
  test("several defaultOmit() on one chain add up per model, as the docs say", async () => {
    const base = await seeded();
    const client = base
      .$extends(defaultOmit({ post: { title: true } } as never))
      .$extends(defaultOmit({ post: { deletedAt: true } } as never));
    const row = (await client.post.findFirst({ where: { id: "a" } })) as Row;
    expect(Object.keys(row).sort()).toEqual(["authorId", "id"]);
  });
});

export type { Row };
