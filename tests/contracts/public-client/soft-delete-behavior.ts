import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import type { AnyDriver } from "@src/drivers";
import {
  createClient,
  ForeignKeyError,
  NotFoundError,
  s,
  UniqueConstraintError,
} from "@src/index";
import { softDelete } from "@src/soft-delete";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * `viborm/soft-delete` end to end (extension-capabilities plan v3.1 §1.1):
 * the plan's use block, run through public entry points only, on a real
 * database.
 *
 * The client is §1.1's: `post` is managed (`deletedAt`, actor in
 * `deletedById`), `user` and `comment` are not. `base` is the same database
 * without the extension; its answers are the negative control beside each
 * soft-delete answer.
 *
 * Fixture (hand-computed oracles below; CUTOFF = 2026-06-01): users u1, u2,
 * u3. Posts (author, createdAt, parent, deletedAt): p1 (u1, 2025-01, -, live);
 * p2 (u1, 2025-02, p1, live); p3 (u2, 2025-03, -, 2026-01); p4 (u2, 2026-07,
 * p1, 2026-08); p5 (u2, 2026-07, p4, live); p6 (u2, 2026-07, -, live), which
 * comment c1 references through a RESTRICT foreign key; p7 (u3, 2025-04, -,
 * 2025-05). Live: p1, p2, p5, p6. Tombstones: p3, p4, p7. Post `pN` has
 * slug `slug-pN`, unique among live posts (a partial unique index).
 */

export const ACTOR = "admin-1";
export const CUTOFF = new Date("2026-06-01T00:00:00.000Z");
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export function softDeleteSchema() {
  const user = s.model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post).name("author"),
  });
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      slug: s.string(),
      createdAt: s.dateTime(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .name("author")
        .fields("authorId")
        .references("id"),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => post)
        .name("thread")
        .fields("parentId")
        .references("id"),
      replies: s.toMany(() => post).name("thread"),
      comments: s.toMany(() => comment),
      deletedAt: s.dateTime().nullable(),
      deletedById: s.string().nullable(),
    })
    // The partial-unique recipe: a slug is unique among live posts only.
    .index(["slug"], { unique: true, where: '"deletedAt" IS NULL' });
  const comment = s.model({
    id: s.string().id(),
    body: s.string(),
    postId: s.string(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id")
      .onDelete("restrict"),
  });
  return { user, post, comment };
}

/** §1.1's configuration: `post` managed, the actor bound to this client. */
export const USE_CONFIG = {
  models: { post: { deletedAt: "deletedAt", deletedBy: "deletedById" } },
  actor: ACTOR,
} as const;

/** The seeded database and its base client. */
export async function openSoftDeleteFixture(driver: AnyDriver) {
  const base = createClient({ schema: softDeleteSchema(), driver });
  await syncLiveSchema(base);
  for (const id of ["u1", "u2", "u3"])
    await base.user.create({ data: { id, name: id } });
  for (const [id, authorId, createdAt, parentId, deletedAt] of [
    ["p1", "u1", "2025-01-01", null, null],
    ["p2", "u1", "2025-02-01", "p1", null],
    ["p3", "u2", "2025-03-01", null, "2026-01-01"],
    ["p4", "u2", "2026-07-01", "p1", "2026-08-01"],
    ["p5", "u2", "2026-07-02", "p4", null],
    ["p6", "u2", "2026-07-03", null, null],
    ["p7", "u3", "2025-04-01", null, "2025-05-01"],
  ] as const)
    await base.post.create({
      data: {
        id,
        authorId,
        parentId,
        title: `title ${id}`,
        slug: `slug-${id}`,
        createdAt: day(createdAt),
        deletedAt: deletedAt === null ? null : day(deletedAt),
      },
    });
  await base.comment.create({ data: { id: "c1", body: "hi", postId: "p6" } });
  return base;
}

export type SoftDeleteBase = Awaited<ReturnType<typeof openSoftDeleteFixture>>;

export const ids = (rows: readonly { readonly id: string }[]) =>
  rows.map((row) => row.id);

export async function failure(pending: PromiseLike<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

/** The seeded database, its base client and §1.1's client over it. */
export async function openSoftDeleteClients(driver: AnyDriver) {
  const base = await openSoftDeleteFixture(driver);
  return { base, db: softDelete(USE_CONFIG)(base) };
}

export interface SoftDeleteProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}

export function runSoftDeleteBehavior(provider: SoftDeleteProvider): void {
  describe(`${provider.name}: viborm/soft-delete, the §1.1 use block`, () => {
    let base: SoftDeleteBase;
    let db: Awaited<ReturnType<typeof openSoftDeleteClients>>["db"];

    beforeEach(async () => {
      ({ base, db } = await openSoftDeleteClients(provider.createDriver()));
    });
    afterEach(async () => {
      await base.$disconnect();
    });

    const byId = { orderBy: { id: "asc" } } as const;
    const physical = async (id: string) =>
      base.post.findUnique({
        where: { id },
        select: { id: true, deletedAt: true, deletedById: true },
      });

    test("reads show live posts, in includes too; `deleted` opens the recycle bin", async () => {
      const users = await db.user.findMany({
        ...byId,
        include: { posts: byId },
      });
      expect(users.map((user) => [user.id, ids(user.posts)])).toEqual([
        ["u1", ["p1", "p2"]],
        ["u2", ["p5", "p6"]],
        ["u3", []],
      ]);
      const everything = await base.user.findMany({
        ...byId,
        include: { posts: byId },
      });
      expect(everything.map((user) => [user.id, ids(user.posts)])).toEqual([
        ["u1", ["p1", "p2"]],
        ["u2", ["p3", "p4", "p5", "p6"]],
        ["u3", ["p7"]],
      ]);
      expect(ids(await db.post.findMany(byId))).toEqual([
        "p1",
        "p2",
        "p5",
        "p6",
      ]);
      expect(ids(await db.post.findMany({ ...byId, deleted: "only" }))).toEqual(
        ["p3", "p4", "p7"]
      );
      expect(ids(await db.post.findMany({ ...byId, deleted: "with" }))).toEqual(
        ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]
      );
      expect(await db.post.findUnique({ where: { id: "p3" } })).toBeNull();
      // Filtering on the marker without `deleted` finds nothing: the live
      // default is conjoined with the caller's filter.
      expect(
        await db.post.findMany({ where: { deletedAt: { not: null } } })
      ).toEqual([]);
      // `restore` exists on the configured models only.
      expect(typeof db.post.restore).toBe("function");
      expect(typeof db.post.restoreMany).toBe("function");
      expect("restore" in db.user).toBe(false);
    });

    test("delete tombstones the post, writes the actor and returns the post-image; a repeat is NotFound", async () => {
      const deleted = await db.post.delete({ where: { id: "p2" } });
      expect(deleted).toMatchObject({
        id: "p2",
        title: "title p2",
        deletedById: ACTOR,
      });
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      expect(await physical("p2")).toEqual({
        id: "p2",
        deletedAt: deleted.deletedAt,
        deletedById: ACTOR,
      });
      expect(ids(await db.post.findMany(byId))).toEqual(["p1", "p5", "p6"]);
      const repeat = await failure(db.post.delete({ where: { id: "p2" } }));
      expect(repeat).toBeInstanceOf(NotFoundError);
      expect((repeat as NotFoundError).meta).toMatchObject({
        model: "post",
        operation: "delete",
      });
    });

    test("restore brings a post back, narrowed by its select; a repeat is NotFound", async () => {
      await db.post.delete({ where: { id: "p2" } });
      const restored = await db.post.restore({
        where: { id: "p2" },
        select: { id: true },
      });
      expect(restored).toEqual({ id: "p2" });
      expect(await physical("p2")).toEqual({
        id: "p2",
        deletedAt: null,
        deletedById: null,
      });
      expect(ids(await db.post.findMany(byId))).toEqual([
        "p1",
        "p2",
        "p5",
        "p6",
      ]);
      // A live post is not in the recycle bin: restoring it again is NotFound.
      expect(
        await failure(db.post.restore({ where: { id: "p2" } }))
      ).toBeInstanceOf(NotFoundError);
      // `include` narrows too, and the relation reads the live default.
      const withAuthor = await db.post.restore({
        where: { id: "p3" },
        include: { author: true },
      });
      expect(withAuthor).toMatchObject({
        id: "p3",
        deletedAt: null,
        author: { id: "u2" },
      });
    });

    test("restoreMany restores tombstones only: live rows in its range are neither counted nor written", async () => {
      // Every u2 post carries an actor, live ones included.
      await base.post.updateMany({
        where: { authorId: "u2" },
        data: { deletedById: "x" },
      });
      expect(await db.post.restoreMany({ where: { authorId: "u2" } })).toEqual({
        count: 2,
      });
      expect(await physical("p3")).toEqual({
        id: "p3",
        deletedAt: null,
        deletedById: null,
      });
      expect(await physical("p4")).toMatchObject({ deletedById: null });
      expect(await physical("p5")).toEqual({
        id: "p5",
        deletedAt: null,
        deletedById: "x",
      });
      expect(await physical("p6")).toMatchObject({ deletedById: "x" });
      // A range holding live rows only restores nothing.
      await base.post.update({
        where: { id: "p1" },
        data: { deletedById: "x" },
      });
      expect(await db.post.restoreMany({ where: { authorId: "u1" } })).toEqual({
        count: 0,
      });
      expect(await physical("p1")).toMatchObject({ deletedById: "x" });
    });

    test('related posts read live under `deleted: "only"` and all under `deleted: "with"`', async () => {
      const shape = {
        ...byId,
        select: {
          id: true,
          replies: { ...byId, select: { id: true } },
          author: {
            select: { id: true, posts: { ...byId, select: { id: true } } },
          },
        },
      } as const;
      const view = (
        rows: readonly {
          readonly id: string;
          readonly replies: readonly { readonly id: string }[];
          readonly author: {
            readonly posts: readonly { readonly id: string }[];
          };
        }[]
      ) => rows.map((row) => [row.id, ids(row.replies), ids(row.author.posts)]);
      // The bin's posts show their live related rows: p4's live reply p5,
      // and their authors' live posts, not the tombstones beside them.
      expect(
        view(await db.post.findMany({ ...shape, deleted: "only" }))
      ).toEqual([
        ["p3", [], ["p5", "p6"]],
        ["p4", ["p5"], ["p5", "p6"]],
        ["p7", [], []],
      ]);
      // `with` reads every post, related ones included.
      const all = view(await db.post.findMany({ ...shape, deleted: "with" }));
      expect(all[0]).toEqual(["p1", ["p2", "p4"], ["p1", "p2"]]);
      expect(all[2]).toEqual(["p3", [], ["p3", "p4", "p5", "p6"]]);
      expect(all[6]).toEqual(["p7", [], ["p7"]]);
    });

    test("a nested delete is soft; one call's tombstones share one instant, which restoreMany selects", async () => {
      await db.user.update({
        where: { id: "u1" },
        data: { posts: { delete: { id: "p2" } } },
      });
      expect(await physical("p2")).toMatchObject({ deletedById: ACTOR });
      expect((await physical("p2"))?.deletedAt).toBeInstanceOf(Date);
      expect(ids(await db.post.findMany(byId))).toEqual(["p1", "p5", "p6"]);
      await db.post.restore({ where: { id: "p2" } });

      await db.user.update({
        where: { id: "u1" },
        data: { posts: { deleteMany: {} } },
      });
      const tombstones = await base.post.findMany({
        where: { authorId: "u1" },
        ...byId,
      });
      expect(ids(tombstones)).toEqual(["p1", "p2"]);
      const [first, second] = tombstones.map((row) => row.deletedAt);
      expect(first).toBeInstanceOf(Date);
      expect(second).toEqual(first);
      expect(
        await db.post.restoreMany({
          where: { authorId: "u1", deletedAt: first },
        })
      ).toEqual({ count: 2 });
      expect(ids(await db.post.findMany(byId))).toEqual([
        "p1",
        "p2",
        "p5",
        "p6",
      ]);
    });

    test("a live comment through a restricting key refuses the soft delete", async () => {
      const refused = await failure(db.post.delete({ where: { id: "p6" } }));
      expect(refused).toBeInstanceOf(ForeignKeyError);
      expect(await physical("p6")).toEqual({
        id: "p6",
        deletedAt: null,
        deletedById: null,
      });
      await base.comment.delete({ where: { id: "c1" } });
      await db.post.delete({ where: { id: "p6" } });
      expect(await physical("p6")).toMatchObject({ deletedById: ACTOR });
    });

    test('a purge says `deleted: "only"` and `mode: "hard"`: it removes old tombstones and nothing else', async () => {
      expect(
        await db.post.deleteMany({
          where: { deletedAt: { lt: CUTOFF } },
          deleted: "only",
          mode: "hard",
        })
      ).toEqual({ count: 2 });
      expect(ids(await base.post.findMany(byId))).toEqual([
        "p1",
        "p2",
        "p4",
        "p5",
        "p6",
      ]);
      // A single hard delete of a tombstone.
      await db.post.delete({
        where: { id: "p4" },
        deleted: "only",
        mode: "hard",
      });
      expect(await physical("p4")).toBeNull();
    });

    test('the purge hazards (ruling 8): `mode: "hard"` keeps the live default', async () => {
      // Without `deleted: "only"`, a purge filtered on the marker deletes
      // nothing: live rows have no marker.
      expect(
        await db.post.deleteMany({
          where: { deletedAt: { lt: CUTOFF } },
          mode: "hard",
        })
      ).toEqual({ count: 0 });
      // Filtered on `createdAt` instead, it deletes old LIVE posts and keeps
      // the old tombstones.
      expect(
        await db.post.deleteMany({
          where: { createdAt: { lt: CUTOFF } },
          mode: "hard",
        })
      ).toEqual({ count: 2 });
      expect(ids(await base.post.findMany(byId))).toEqual([
        "p3",
        "p4",
        "p5",
        "p6",
        "p7",
      ]);
    });

    test("quantifiers, relation counts, counts and aggregates see live posts", async () => {
      const users = async (rows: PromiseLike<{ readonly id: string }[]>) =>
        ids(await rows);
      const some = { where: { posts: { some: {} } }, ...byId } as const;
      const recent = {
        where: { posts: { every: { createdAt: { gt: CUTOFF } } } },
        ...byId,
      } as const;
      expect(await users(db.user.findMany(some))).toEqual(["u1", "u2"]);
      expect(await users(base.user.findMany(some))).toEqual(["u1", "u2", "u3"]);
      expect(
        await users(db.user.findMany({ where: { posts: { none: {} } } }))
      ).toEqual(["u3"]);
      expect(await users(db.user.findMany(recent))).toEqual(["u2", "u3"]);
      expect(await users(base.user.findMany(recent))).toEqual([]);
      const counted = await db.user.findMany({
        ...byId,
        select: { id: true, _count: { select: { posts: true } } },
      });
      expect(counted.map((row) => [row.id, row._count.posts])).toEqual([
        ["u1", 2],
        ["u2", 2],
        ["u3", 0],
      ]);
      expect(await db.post.count()).toBe(4);
      expect(await db.post.count({ deleted: "only" })).toBe(3);
      expect(await base.post.count()).toBe(7);
      expect(
        (await db.post.aggregate({ _count: { _all: true } }))._count
      ).toEqual({ _all: 4 });
      const grouped = await db.post.groupBy({
        by: ["authorId"],
        _count: { _all: true },
        orderBy: { authorId: "asc" },
      });
      expect(grouped.map((row) => [row.authorId, row._count._all])).toEqual([
        ["u1", 2],
        ["u2", 2],
      ]);
    });

    test("a cursor on a tombstone is a missing anchor: an empty page", async () => {
      const page = (cursor: string) =>
        ({ cursor: { id: cursor }, take: 2, ...byId }) as const;
      expect(ids(await db.post.findMany(page("p2")))).toEqual(["p2", "p5"]);
      expect(ids(await db.post.findMany(page("p4")))).toEqual([]);
      expect(
        ids(await db.post.findMany({ ...page("p4"), deleted: "with" }))
      ).toEqual(["p4", "p5"]);
      expect(ids(await base.post.findMany(page("p4")))).toEqual(["p4", "p5"]);
    });

    test("a recursive read of replies cuts the thread below a tombstone", async () => {
      const thread = {
        where: { id: "p1" },
        select: {
          id: true,
          replies: { recurse: { depth: 3 }, ...byId, select: { id: true } },
        },
      } as const;
      expect(await db.post.findUnique(thread)).toEqual({
        id: "p1",
        replies: [{ id: "p2", replies: [] }],
      });
      expect(await base.post.findUnique(thread)).toEqual({
        id: "p1",
        replies: [
          { id: "p2", replies: [] },
          { id: "p4", replies: [{ id: "p5", replies: [] }] },
        ],
      });
    });

    test("a to-one relation to a tombstone reads null, upward recursion stops there, and a restore brings it back", async () => {
      const ancestry = {
        where: { id: "p5" },
        select: {
          id: true,
          parent: { recurse: { depth: 3 }, select: { id: true } },
        },
      } as const;
      // p5's parent p4 is a tombstone; p4's parent is p1.
      expect(await db.post.findUnique(ancestry)).toEqual({
        id: "p5",
        parent: null,
      });
      expect(await base.post.findUnique(ancestry)).toEqual({
        id: "p5",
        parent: { id: "p4", parent: { id: "p1", parent: null } },
      });
      const reply = await db.post.findUniqueOrThrow({
        where: { id: "p5" },
        include: { parent: { select: { id: true } } },
      });
      expect(reply.parent).toBeNull();
      const childrenOfP4 = {
        where: { parent: { is: { title: "title p4" } } },
        select: { id: true },
      } as const;
      expect(await db.post.findMany(childrenOfP4)).toEqual([]);
      expect(await base.post.findMany(childrenOfP4)).toEqual([{ id: "p5" }]);
      await db.post.restore({ where: { id: "p4" } });
      expect(await db.post.findUnique(ancestry)).toEqual({
        id: "p5",
        parent: { id: "p4", parent: { id: "p1", parent: null } },
      });
    });

    test("the partial-unique recipe: a tombstone frees its slug; restoring into a live duplicate is refused and rolls back", async () => {
      await db.post.delete({ where: { id: "p2" } });
      const again = {
        id: "p8",
        title: "again",
        slug: "slug-p2",
        createdAt: CUTOFF,
        authorId: "u1",
      };
      await db.post.create({ data: again });
      expect(
        await failure(
          db.$transaction(async (tx) => {
            await tx.post.restore({ where: { id: "p3" } });
            await tx.post.restore({ where: { id: "p2" } });
          })
        )
      ).toBeInstanceOf(UniqueConstraintError);
      expect(await physical("p2")).toMatchObject({ deletedById: ACTOR });
      expect((await physical("p3"))?.deletedAt).toEqual(day("2026-01-01"));
    });

    test("a callback transaction rolls a soft delete back", async () => {
      const rollback = new Error("rollback");
      expect(
        await failure(
          db.$transaction(async (tx) => {
            await tx.post.delete({ where: { id: "p2" } });
            expect(
              await tx.post.findUnique({ where: { id: "p2" } })
            ).toBeNull();
            throw rollback;
          })
        )
      ).toBe(rollback);
      expect(await physical("p2")).toEqual({
        id: "p2",
        deletedAt: null,
        deletedById: null,
      });
    });

    test("the cache is keyed per mode and invalidated by a soft delete, in both extension orders", async () => {
      const official = () => cache({ driver: new MemoryCache(), version: "v" });
      for (const cached of [
        softDelete(USE_CONFIG)(base.$extends(official())),
        softDelete(USE_CONFIG)(base).$extends(official()),
      ]) {
        const reader = cached.$withCache({ ttl: 60_000 });
        const live = () =>
          reader.post.findMany({ ...byId, select: { id: true } });
        const bin = () =>
          reader.post.findMany({
            ...byId,
            select: { id: true },
            deleted: "only",
          });
        const authors = () =>
          reader.user.findMany({
            ...byId,
            select: { id: true, posts: { ...byId, select: { id: true } } },
          });
        expect(ids(await live())).toEqual(["p1", "p2", "p5", "p6"]);
        expect(ids(await bin())).toEqual(["p3", "p4", "p7"]);
        expect((await authors())[0]?.posts).toEqual([
          { id: "p1" },
          { id: "p2" },
        ]);
        await cached.post.delete({
          where: { id: "p2" },
          cache: { autoInvalidate: true },
        });
        // The post entries were invalidated: both modes read again.
        expect(ids(await live())).toEqual(["p1", "p5", "p6"]);
        expect(ids(await bin())).toEqual(["p2", "p3", "p4", "p7"]);
        // A user entry is another model's, as after a hard delete: stale.
        expect((await authors())[0]?.posts).toEqual([
          { id: "p1" },
          { id: "p2" },
        ]);
        await base.post.update({
          where: { id: "p2" },
          data: { deletedAt: null, deletedById: null },
        });
      }
    });

    test("the actor is bound per derived client", async () => {
      const other = softDelete({ ...USE_CONFIG, actor: "admin-2" })(base);
      await db.post.delete({ where: { id: "p1" } });
      await other.post.delete({ where: { id: "p2" } });
      expect(await physical("p1")).toMatchObject({ deletedById: ACTOR });
      expect(await physical("p2")).toMatchObject({ deletedById: "admin-2" });
    });
  });
}
