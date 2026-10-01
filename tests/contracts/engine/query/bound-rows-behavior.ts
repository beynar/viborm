import type { CacheEntry } from "@cache";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  NestedWriteError,
  NotFoundError,
  UniqueConstraintError,
  ValidationError,
} from "@errors";
import { s } from "@schema";
import { tenancy } from "@tests/fixtures/extension-recipes";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * Rows bound to the call (extension-capabilities plan v4 §2.1, witnesses §6
 * "Bound rows"): the guide's tenancy recipe (§1.1, `tests/fixtures/
 * extension-recipes.ts`), through public entry points, on a real database.
 * Its rows predicates name the `tenant` control; each call's value is put in
 * before the engine sees the predicate, and its `data` writes `tenantId` on
 * every create, so `tenantId` is nullable here: the call's data is checked
 * before the extension writes it. `base` is the same database without the
 * extension: its answers are the negative control beside each tenant's.
 *
 * Fixture (hand-computed oracles below). Posts (tenant, title, parent):
 * 1 (acme, a, -), 2 (acme, b, 1), 3 (globex, c, -), 4 (acme, d, 3),
 * 5 (globex, e, 1). Comments (tenant, post): 10 (acme, 1), 11 (globex, 3),
 * 12 (globex, 1), 13 (acme, 3), 14 (acme, 2), 15 (globex, 4),
 * 16 (globex, 4). Tags (tenant): 20 acme links post 1; 21 globex links posts
 * 1 and 3. Every relation crosses tenants somewhere, so a related domain that
 * is not applied changes an answer.
 */

export function boundRowsSchema() {
  const post = s.model({
    id: s.int().id(),
    tenantId: s.string().nullable(),
    title: s.string(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => post)
      .fields("parentId")
      .references("id")
      .name("thread"),
    replies: s.toMany(() => post).name("thread"),
    comments: s.toMany(() => comment),
    tags: s.toMany(() => tag),
  });
  const comment = s.model({
    id: s.int().id(),
    tenantId: s.string().nullable(),
    body: s.string(),
    postId: s.int(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  });
  const tag = s.model({
    id: s.int().id(),
    tenantId: s.string().nullable(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  return { post, comment, tag };
}

const MODELS = ["post", "comment", "tag"] as const;

/** The seeded database and its tenancy client. */
export async function openBoundRowsFixture(driver: AnyDriver) {
  const base = createClient({ schema: boundRowsSchema(), driver });
  await syncLiveSchema(base);
  for (const [id, tenantId, title, parentId] of [
    [1, "acme", "a", null],
    [2, "acme", "b", 1],
    [3, "globex", "c", null],
    [4, "acme", "d", 3],
    [5, "globex", "e", 1],
  ] as const)
    await base.post.create({ data: { id, tenantId, title, parentId } });
  for (const [id, tenantId, postId] of [
    [10, "acme", 1],
    [11, "globex", 3],
    [12, "globex", 1],
    [13, "acme", 3],
    [14, "acme", 2],
    [15, "globex", 4],
    [16, "globex", 4],
  ] as const)
    await base.comment.create({
      data: { id, tenantId, postId, body: `c${id}` },
    });
  await base.tag.create({
    data: {
      id: 20,
      tenantId: "acme",
      name: "x",
      posts: { connect: [{ id: 1 }] },
    },
  });
  await base.tag.create({
    data: {
      id: 21,
      tenantId: "globex",
      name: "y",
      posts: { connect: [{ id: 1 }, { id: 3 }] },
    },
  });
  return { base, db: base.$extends(tenancy(MODELS)) };
}

export type BoundRowsFixture = Awaited<ReturnType<typeof openBoundRowsFixture>>;

export const ids = (rows: readonly { readonly id: number }[]) =>
  rows.map((row) => row.id);

const byId = { orderBy: { id: "asc" } } as const;

/** A memory cache that records every key it stores. */
class KeyRecordingCache extends MemoryCache {
  readonly keys: string[] = [];

  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.keys.push(key);
    await super.set(key, storageTtl, entry);
  }
}

export interface BoundRowsProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}

export function runBoundRowsBehavior(provider: BoundRowsProvider): void {
  describe(`${provider.name}: rows bound to the call`, () => {
    let context: BoundRowsFixture;

    beforeEach(async () => {
      context = await openBoundRowsFixture(provider.createDriver());
    });
    afterEach(async () => {
      await context.base.$disconnect();
    });

    test("each tenant's root reads see its own rows; `all` sees every row; no tenant is refused", async () => {
      const { base, db } = context;
      expect(ids(await db.post.findMany({ ...byId, tenant: "acme" }))).toEqual([
        1, 2, 4,
      ]);
      expect(
        ids(await db.post.findMany({ ...byId, tenant: "globex" }))
      ).toEqual([3, 5]);
      expect(
        ids(await db.post.findMany({ ...byId, tenant: "acme", scope: "all" }))
      ).toEqual([1, 2, 3, 4, 5]);
      expect(ids(await base.post.findMany(byId))).toEqual([1, 2, 3, 4, 5]);
      expect(
        await db.post.findUnique({ where: { id: 3 }, tenant: "acme" })
      ).toBeNull();
      expect(
        await failure(
          db.post.findUniqueOrThrow({ where: { id: 3 }, tenant: "acme" })
        )
      ).toBeInstanceOf(NotFoundError);
      expect(
        await db.post.findFirst({ where: { title: "c" }, tenant: "acme" })
      ).toBeNull();
      expect(await db.post.count({ tenant: "acme" })).toBe(3);
      expect(await db.post.exist({ where: { id: 3 }, tenant: "acme" })).toBe(
        false
      );
      expect(
        (await db.post.aggregate({ _max: { id: true }, tenant: "acme" }))._max
          .id
      ).toBe(4);
      expect(
        (await db.post.aggregate({ _max: { id: true }, tenant: "globex" }))._max
          .id
      ).toBe(5);
      const refused = await failure(db.post.findMany());
      expect(refused).toBeInstanceOf(ValidationError);
      expect((refused as ValidationError).issues).toEqual([
        { path: "tenant", message: 'Control "tenant" is required' },
      ]);
    });

    test("relations read the tenant's related rows: includes, to-one, quantifiers, counts and _count order", async () => {
      const { base, db } = context;
      const withComments = {
        where: { id: 1 },
        include: {
          comments: { orderBy: { id: "asc" } },
          tags: { orderBy: { id: "asc" } },
        },
      } as const;
      const acme = await db.post.findUniqueOrThrow({
        ...withComments,
        tenant: "acme",
      });
      expect([ids(acme.comments), ids(acme.tags)]).toEqual([[10], [20]]);
      const physical = await base.post.findUniqueOrThrow(withComments);
      expect([ids(physical.comments), ids(physical.tags)]).toEqual([
        [10, 12],
        [20, 21],
      ]);
      // Comment 13 is acme's; its post is globex's: a hidden target is null.
      const comments = await db.comment.findMany({
        ...byId,
        include: { post: { select: { id: true } } },
        tenant: "acme",
      });
      expect(comments.map((row) => [row.id, row.post?.id ?? null])).toEqual([
        [10, 1],
        [13, null],
        [14, 2],
      ]);
      // Ordering by a to-one relation reads the tenant's target: comment
      // 13's post is globex's, so it sorts as a comment without one.
      const acmeComments = await db.comment.findMany({
        orderBy: [
          { post: { title: { sort: "desc", nulls: "last" } } },
          { id: "asc" },
        ],
        tenant: "acme",
      });
      expect(ids(acmeComments)).toEqual([14, 10, 13]);
      const unbound = await base.comment.findMany({
        where: { tenantId: "acme" },
        orderBy: [
          { post: { title: { sort: "desc", nulls: "last" } } },
          { id: "asc" },
        ],
      });
      expect(ids(unbound)).toEqual([13, 14, 10]);
      const posts = async (where: object) =>
        ids(await db.post.findMany({ ...byId, where, tenant: "acme" }));
      expect(await posts({ comments: { some: {} } })).toEqual([1, 2]);
      expect(await posts({ comments: { none: {} } })).toEqual([4]);
      expect(await posts({ comments: { every: { body: "c10" } } })).toEqual([
        1, 4,
      ]);
      expect(
        ids(
          await base.post.findMany({
            ...byId,
            where: { tenantId: "acme", comments: { every: { body: "c10" } } },
          })
        )
      ).toEqual([]);
      const counted = await db.post.findMany({
        ...byId,
        select: { id: true, _count: { select: { comments: true } } },
        tenant: "acme",
      });
      expect(counted.map((row) => [row.id, row._count.comments])).toEqual([
        [1, 1],
        [2, 1],
        [4, 0],
      ]);
      expect(
        ids(
          await db.post.findMany({
            orderBy: [{ comments: { _count: "desc" } }, { id: "asc" }],
            tenant: "acme",
          })
        )
      ).toEqual([1, 2, 4]);
      expect(
        ids(
          await base.post.findMany({
            orderBy: [{ comments: { _count: "desc" } }, { id: "asc" }],
            where: { tenantId: "acme" },
          })
        )
      ).toEqual([1, 4, 2]);
    });

    test("a page is cut from the tenant's rows, and a recursion stops at another tenant's row", async () => {
      const { base, db } = context;
      const page = (cursor: number) =>
        ({
          cursor: { id: cursor },
          take: 2,
          orderBy: { id: "asc" },
          tenant: "acme",
        }) as const;
      expect(ids(await db.post.findMany(page(2)))).toEqual([2, 4]);
      // Another tenant's anchor is a missing one.
      expect(ids(await db.post.findMany(page(3)))).toEqual([]);
      const thread = {
        where: { id: 1 },
        select: {
          id: true,
          replies: {
            recurse: { depth: 3 },
            orderBy: { id: "asc" },
            select: { id: true },
          },
        },
      } as const;
      expect(await db.post.findUnique({ ...thread, tenant: "acme" })).toEqual({
        id: 1,
        replies: [{ id: 2, replies: [] }],
      });
      expect(await base.post.findUnique(thread)).toEqual({
        id: 1,
        replies: [
          { id: 2, replies: [] },
          { id: 5, replies: [] },
        ],
      });
    });

    test("nested writes cannot reach another tenant's rows: connect, set, update and delete find no target", async () => {
      const { base, db } = context;
      const onPostOne = (data: object) =>
        failure(db.post.update({ where: { id: 1 }, data, tenant: "acme" }));
      expect(
        await onPostOne({ comments: { connect: [{ id: 11 }] } })
      ).toBeInstanceOf(NestedWriteError);
      expect(await onPostOne({ tags: { set: [{ id: 21 }] } })).toBeInstanceOf(
        NestedWriteError
      );
      expect(
        await onPostOne({
          comments: { update: [{ where: { id: 12 }, data: { body: "x" } }] },
        })
      ).toBeInstanceOf(NestedWriteError);
      expect(
        await onPostOne({ comments: { delete: [{ id: 12 }] } })
      ).toBeInstanceOf(NestedWriteError);
      const physical = await base.comment.findMany({
        where: { id: { in: [11, 12] } },
        ...byId,
      });
      expect(physical.map((row) => [row.id, row.postId, row.body])).toEqual([
        [11, 3, "c11"],
        [12, 1, "c12"],
      ]);
      const tags = await base.post.findUniqueOrThrow({
        where: { id: 1 },
        include: { tags: { orderBy: { id: "asc" } } },
      });
      expect(ids(tags.tags)).toEqual([20, 21]);
      // The tenant's own rows are reached.
      await db.post.update({
        where: { id: 2 },
        data: { comments: { connect: [{ id: 10 }] } },
        tenant: "acme",
      });
      expect(
        (await base.comment.findUniqueOrThrow({ where: { id: 10 } })).postId
      ).toBe(2);
    });

    test("root writes take the tenant's rows: another tenant's key is not found, and an upsert converges only within the tenant and its create arm is the tenant's", async () => {
      const { base, db } = context;
      expect(
        await failure(
          db.post.update({
            where: { id: 3 },
            data: { title: "taken" },
            tenant: "acme",
          })
        )
      ).toBeInstanceOf(NotFoundError);
      expect(
        await failure(db.post.delete({ where: { id: 3 }, tenant: "acme" }))
      ).toBeInstanceOf(NotFoundError);
      expect(
        await db.post.updateMany({ data: { title: "z" }, tenant: "acme" })
      ).toEqual({ count: 3 });
      expect(
        await db.comment.deleteMany({ where: { postId: 3 }, tenant: "acme" })
      ).toEqual({ count: 1 });
      const upsert = (id: number, tenant: string) =>
        db.post.upsert({
          where: { id },
          create: { id, title: "new" },
          update: { title: "upserted" },
          select: { id: true, title: true },
          tenant,
        });
      expect(await upsert(1, "acme")).toEqual({ id: 1, title: "upserted" });
      // Globex's key is no acme candidate: the create arm meets it.
      expect(await failure(upsert(3, "acme"))).toBeInstanceOf(
        UniqueConstraintError
      );
      expect(await upsert(6, "globex")).toEqual({ id: 6, title: "new" });
      const physical = await base.post.findMany({
        ...byId,
        select: { id: true, title: true },
      });
      expect(physical).toEqual([
        { id: 1, title: "upserted" },
        { id: 2, title: "z" },
        { id: 3, title: "c" },
        { id: 4, title: "z" },
        { id: 5, title: "e" },
        { id: 6, title: "new" },
      ]);
      expect(ids(await base.comment.findMany(byId))).toEqual([
        10, 11, 12, 14, 15, 16,
      ]);
      // The create arm took the call's tenant from the recipe's `data`.
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 6 } })).tenantId
      ).toBe("globex");
    });

    test("an array transaction binds each member to its own tenant; another tenant's key rolls every member back", async () => {
      const { base, db } = context;
      expect(
        await db.$transaction([
          db.post.findMany({ ...byId, select: { id: true }, tenant: "acme" }),
          db.post.findMany({ ...byId, select: { id: true }, tenant: "globex" }),
          db.post.count({ tenant: "acme" }),
        ])
      ).toEqual([[{ id: 1 }, { id: 2 }, { id: 4 }], [{ id: 3 }, { id: 5 }], 3]);
      const refused = await failure(
        db.$transaction([
          db.post.update({
            where: { id: 1 },
            data: { title: "first" },
            tenant: "acme",
          }),
          db.post.update({
            where: { id: 1 },
            data: { title: "second" },
            tenant: "globex",
          }),
        ])
      );
      expect(refused).toBeInstanceOf(NotFoundError);
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 1 } })).title
      ).toBe("a");
    });

    test("the cache: two tenants never share an entry; one tenant on two clients of one configuration does", async () => {
      const { base } = context;
      const recorder = new KeyRecordingCache();
      const client = () =>
        base
          .$extends(cache({ driver: recorder, version: "v" }))
          .$extends(tenancy(MODELS));
      const first = client().$withCache({ ttl: 60_000 });
      const second = client().$withCache({ ttl: 60_000 });
      const read = { ...byId, select: { id: true } } as const;
      expect(await first.post.findMany({ ...read, tenant: "acme" })).toEqual([
        { id: 1 },
        { id: 2 },
        { id: 4 },
      ]);
      expect(await first.post.findMany({ ...read, tenant: "globex" })).toEqual([
        { id: 3 },
        { id: 5 },
      ]);
      // The second client reads the first one's acme entry: no new key.
      await base.post.update({
        where: { id: 2 },
        data: { tenantId: "globex" },
      });
      expect(await second.post.findMany({ ...read, tenant: "acme" })).toEqual([
        { id: 1 },
        { id: 2 },
        { id: 4 },
      ]);
      expect(recorder.keys).toHaveLength(2);
      expect(new Set(recorder.keys).size).toBe(2);
    });
  });
}
