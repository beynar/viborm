import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NotFoundError } from "@errors";
import { s } from "@schema";
import { defineExtension } from "@src/index";
import {
  audit,
  optimisticLock,
  tenancy,
} from "@tests/fixtures/extension-recipes";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * Fields an extension writes (extension-capabilities plan v4 §2.2, witnesses
 * §6 "Data" and "Composition"), through public entry points, on a real
 * database: the guide's audit (§1.2), tenancy (§1.1) and optimistic lock
 * (§1.3) recipes (`tests/fixtures/extension-recipes.ts`).
 *
 * Every place the engine writes one occurrence's data writes the stamp,
 * unless the caller's own data there writes the field, whose value then
 * stands (owner ruling, 2026-10-02):
 * creates (root create, both `createMany` forms, `upsert`'s create arm on
 * both routes, nested `create`, `createMany`, `connectOrCreate` and `upsert`)
 * and updates (root update, both `updateMany` forms, `upsert`'s update arm
 * on both routes, nested `update`, `updateMany` and `upsert`, the members a
 * series captures) and every tombstone. A `connect` that only moves a foreign
 * key writes no stamp, as it moves no `updatedAt`. `base` is the same
 * database without the extensions: it reads the rows back.
 *
 * Fixture: posts, comments (optional foreign key to a post) and tags (a
 * junction with posts), each with `createdBy`, `updatedBy` and `deletedAt`;
 * posts also `version` (default 0) and `source`. The stamped fields are
 * nullable here; a required one is `stamped-required-behavior.ts`'s.
 */

export function dataSchema() {
  const post = s.model({
    id: s.int().id(),
    title: s.string(),
    createdBy: s.string().nullable(),
    updatedBy: s.string().nullable(),
    source: s.string().nullable(),
    tenantId: s.string().nullable(),
    version: s.int().default(0),
    deletedAt: s.dateTime().nullable(),
    comments: s.toMany(() => comment),
    tags: s.toMany(() => tag),
  });
  const comment = s.model({
    id: s.int().id(),
    body: s.string(),
    postId: s.int().nullable(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
    createdBy: s.string().nullable(),
    updatedBy: s.string().nullable(),
    tenantId: s.string().nullable(),
    deletedAt: s.dateTime().nullable(),
  });
  const tag = s.model({
    id: s.int().id(),
    name: s.string(),
    createdBy: s.string().nullable(),
    updatedBy: s.string().nullable(),
    tenantId: s.string().nullable(),
    deletedAt: s.dateTime().nullable(),
    posts: s.toMany(() => post),
  });
  return { post, comment, tag };
}

const MODELS = ["post", "comment", "tag"] as const;
const UPDATE_STATEMENT = /^\s*UPDATE\b/i;
const DELETE_STATEMENT = /^\s*DELETE\b/i;

/** A soft delete without row modes: it only turns deletes into updates. */
const softDelete = defineExtension({
  name: "test.softDelete",
  controls: { mode: { oneOf: ["soft", "hard"] } },
  deletion: {
    removeWhen: { mode: "hard" },
    models: {
      post: { at: "deletedAt" },
      comment: { at: "deletedAt" },
      tag: { at: "deletedAt" },
    },
  },
});

/** A second extension on posts: `source` from an optional control, and `createdBy`. */
const origin = defineExtension({
  name: "origin",
  controls: { device: { schema: v.string(), on: "writes" } },
  data: {
    models: {
      post: {
        create: { source: { control: "device" }, createdBy: "system" },
      },
    },
  },
});

/** The empty database, its audited client and a statement log. */
export async function openDataFixture(driver: AnyDriver) {
  const statements: string[] = [];
  const base = createClient({ schema: dataSchema(), driver });
  await syncLiveSchema(base);
  const logged = base.$extends({
    name: "test.statements",
    statement: (statement) => {
      statements.push(statement.statement.toStatement("?"));
      return statement.statement;
    },
  });
  const db = logged.$extends(softDelete).$extends(audit(MODELS));
  return { base, db, logged, statements };
}

export type DataFixture = Awaited<ReturnType<typeof openDataFixture>>;

const byId = { orderBy: { id: "asc" } } as const;
const ids = (rows: readonly { readonly id: number }[]) =>
  rows.map((row) => row.id);
const stamps = { id: true, createdBy: true, updatedBy: true } as const;

export interface DataProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}

export function runExtensionDataBehavior(provider: DataProvider): void {
  describe(`${provider.name}: fields an extension writes`, () => {
    let context: DataFixture;

    beforeEach(async () => {
      context = await openDataFixture(provider.createDriver());
    });
    afterEach(async () => {
      await context.base.$disconnect();
    });

    /** Each row's [id, createdBy, updatedBy], read without the extensions. */
    const stamped = async (model: "post" | "comment" | "tag") => {
      const { base } = context;
      const read = { ...byId, select: stamps };
      const rows = await {
        post: () => base.post.findMany(read),
        comment: () => base.comment.findMany(read),
        tag: () => base.tag.findMany(read),
      }[model]();
      return rows.map((row) => [row.id, row.createdBy, row.updatedBy]);
    };

    test("every create writes the create stamp: root, both createMany forms, upsert's create arm on both routes, nested create, createMany, connectOrCreate and upsert", async () => {
      const { db } = context;
      await db.post.create({ data: { id: 1, title: "a" }, actor: "ann" });
      await db.post.create({
        data: {
          id: 2,
          title: "b",
          comments: {
            create: [{ id: 10, body: "x" }],
            createMany: { data: [{ id: 11, body: "y" }] },
            connectOrCreate: [
              { where: { id: 12 }, create: { id: 12, body: "z" } },
            ],
          },
        },
        actor: "bob",
      });
      await db.post.createMany({
        data: [
          { id: 3, title: "c" },
          { id: 4, title: "d" },
        ],
        actor: "cy",
      });
      await db.post.createMany({
        data: [
          { id: 5, title: "e", tags: { create: [{ id: 30, name: "t" }] } },
        ],
        actor: "dee",
      });
      await db.post.upsert({
        where: { id: 6 },
        create: { id: 6, title: "f" },
        update: { title: "never" },
        actor: "fay",
      });
      await db.$transaction([
        db.post.upsert({
          where: { id: 7 },
          create: { id: 7, title: "g" },
          update: { title: "never" },
          actor: "gus",
        }),
      ]);
      await db.post.update({
        where: { id: 1 },
        data: {
          comments: {
            upsert: [
              {
                where: { id: 13 },
                create: { id: 13, body: "w" },
                update: { body: "never" },
              },
            ],
          },
        },
        actor: "eve",
      });
      expect(await stamped("post")).toEqual([
        [1, "ann", "eve"],
        [2, "bob", null],
        [3, "cy", null],
        [4, "cy", null],
        [5, "dee", null],
        [6, "fay", null],
        [7, "gus", null],
      ]);
      expect(await stamped("comment")).toEqual([
        [10, "bob", null],
        [11, "bob", null],
        [12, "bob", null],
        [13, "eve", null],
      ]);
      expect(await stamped("tag")).toEqual([[30, "dee", null]]);
    });

    test("every update writes the update stamp: root, both updateMany forms, upsert's update arm on both routes, nested update, updateMany and upsert, and captured members", async () => {
      const { base, db } = context;
      for (const id of [1, 2, 3, 4, 5, 6, 7])
        await base.post.create({ data: { id, title: `p${id}` } });
      for (const [id, postId] of [
        [10, 2],
        [11, 2],
        [13, 1],
      ] as const)
        await base.comment.create({ data: { id, postId, body: `c${id}` } });
      await base.tag.create({
        data: { id: 30, name: "t", posts: { connect: [{ id: 5 }] } },
      });
      await db.post.update({
        where: { id: 1 },
        data: { title: "a" },
        actor: "hal",
      });
      await db.post.update({
        where: { id: 2 },
        data: {
          title: "b",
          comments: {
            update: [{ where: { id: 10 }, data: { body: "x" } }],
            updateMany: [{ where: { id: 11 }, data: { body: "y" } }],
          },
        },
        actor: "ivy",
      });
      await db.post.updateMany({
        where: { id: { in: [3, 4] } },
        data: { title: "m" },
        actor: "jo",
      });
      // A relation-bearing updateMany captures its rows: each member is
      // admitted again, with the stamp.
      await db.post.updateMany({
        where: { id: 5 },
        data: {
          title: "n",
          tags: { updateMany: [{ where: {}, data: { name: "u" } }] },
        },
        actor: "kim",
      });
      await db.post.upsert({
        where: { id: 6 },
        create: { id: 6, title: "never" },
        update: { title: "f" },
        actor: "lee",
      });
      await db.$transaction([
        db.post.upsert({
          where: { id: 7 },
          create: { id: 7, title: "never" },
          update: { title: "g" },
          actor: "max",
        }),
      ]);
      await db.post.update({
        where: { id: 1 },
        data: {
          comments: {
            upsert: [
              {
                where: { id: 13 },
                create: { id: 13, body: "never" },
                update: { body: "w" },
              },
            ],
          },
        },
        actor: "eve",
      });
      expect(await stamped("post")).toEqual([
        [1, null, "eve"],
        [2, null, "ivy"],
        [3, null, "jo"],
        [4, null, "jo"],
        [5, null, "kim"],
        [6, null, "lee"],
        [7, null, "max"],
      ]);
      expect(await stamped("comment")).toEqual([
        [10, null, "ivy"],
        [11, null, "ivy"],
        [13, null, "eve"],
      ]);
      expect(await stamped("tag")).toEqual([[30, null, "kim"]]);
    });

    test("a connect that only moves a foreign key writes no stamp", async () => {
      const { base, db } = context;
      await base.post.create({ data: { id: 1, title: "a" } });
      await base.comment.create({ data: { id: 10, body: "x" } });
      await db.post.update({
        where: { id: 1 },
        data: { comments: { connect: [{ id: 10 }] } },
        actor: "ann",
      });
      expect(
        await base.comment.findUniqueOrThrow({ where: { id: 10 } })
      ).toMatchObject({ postId: 1, updatedBy: null });
      expect(await stamped("post")).toEqual([[1, null, "ann"]]);
    });

    test("every tombstone writes the update stamp: root delete and deleteMany, nested delete, deleteMany and a captured member; a physical delete writes nothing", async () => {
      const { base, db, statements } = context;
      for (const id of [1, 2, 3, 4])
        await base.post.create({ data: { id, title: `p${id}` } });
      for (const id of [10, 11])
        await base.comment.create({ data: { id, postId: 2, body: "c" } });
      await base.tag.create({
        data: { id: 30, name: "t", posts: { connect: [{ id: 2 }] } },
      });
      await db.post.delete({ where: { id: 3 }, actor: "ned" });
      await db.post.deleteMany({ where: { id: 4 }, actor: "ola" });
      await db.post.update({
        where: { id: 2 },
        data: {
          comments: { delete: [{ id: 10 }], deleteMany: [{ id: 11 }] },
          tags: { deleteMany: [{}] },
        },
        actor: "pam",
      });
      const tombstones = await base.post.findMany({
        ...byId,
        where: { deletedAt: { not: null } },
        select: stamps,
      });
      expect(tombstones).toEqual([
        { id: 3, createdBy: null, updatedBy: "ned" },
        { id: 4, createdBy: null, updatedBy: "ola" },
      ]);
      expect(await stamped("comment")).toEqual([
        [10, null, "pam"],
        [11, null, "pam"],
      ]);
      expect(await stamped("tag")).toEqual([[30, null, "pam"]]);
      statements.length = 0;
      await db.post.delete({ where: { id: 1 }, actor: "quinn", mode: "hard" });
      expect(await base.post.findUnique({ where: { id: 1 } })).toBeNull();
      expect(statements.filter((sql) => UPDATE_STATEMENT.test(sql))).toEqual(
        []
      );
      expect(
        statements.filter((sql) => DELETE_STATEMENT.test(sql))
      ).toHaveLength(1);
    });

    test("a caller who writes a stamped field keeps its value at every create site; a row that leaves it out, or writes it undefined, takes the stamp", async () => {
      const { db } = context;
      await db.post.create({
        data: { id: 1, title: "a", createdBy: "c1" },
        actor: "ann",
      });
      await db.post.create({
        data: { id: 2, title: "b", createdBy: undefined },
        actor: "ann",
      });
      await db.post.create({
        data: {
          id: 8,
          title: "h",
          comments: {
            create: [
              { id: 10, body: "x", createdBy: "c10" },
              { id: 14, body: "v" },
            ],
            createMany: {
              data: [
                { id: 11, body: "y", createdBy: "c11" },
                { id: 15, body: "u" },
              ],
            },
            connectOrCreate: [
              {
                where: { id: 12 },
                create: { id: 12, body: "z", createdBy: "c12" },
              },
            ],
          },
        },
        actor: "bob",
      });
      await db.post.createMany({
        data: [
          { id: 3, title: "c", createdBy: "c3" },
          { id: 4, title: "d" },
        ],
        actor: "cy",
      });
      await db.post.createMany({
        data: [
          {
            id: 5,
            title: "e",
            createdBy: "c5",
            tags: {
              create: [
                { id: 30, name: "t", createdBy: "c30" },
                { id: 31, name: "s" },
              ],
            },
          },
        ],
        actor: "dee",
      });
      await db.post.upsert({
        where: { id: 6 },
        create: { id: 6, title: "f", createdBy: "c6" },
        update: { title: "never" },
        actor: "fay",
      });
      await db.$transaction([
        db.post.upsert({
          where: { id: 7 },
          create: { id: 7, title: "g", createdBy: "c7" },
          update: { title: "never" },
          actor: "gus",
        }),
      ]);
      await db.post.update({
        where: { id: 1 },
        data: {
          comments: {
            upsert: [
              {
                where: { id: 13 },
                create: { id: 13, body: "w", createdBy: "c13" },
                update: { body: "never" },
              },
            ],
          },
        },
        actor: "eve",
      });
      expect(await stamped("post")).toEqual([
        [1, "c1", "eve"],
        [2, "ann", null],
        [3, "c3", null],
        [4, "cy", null],
        [5, "c5", null],
        [6, "c6", null],
        [7, "c7", null],
        [8, "bob", null],
      ]);
      expect(await stamped("comment")).toEqual([
        [10, "c10", null],
        [11, "c11", null],
        [12, "c12", null],
        [13, "c13", null],
        [14, "bob", null],
        [15, "bob", null],
      ]);
      expect(await stamped("tag")).toEqual([
        [30, "c30", null],
        [31, "dee", null],
      ]);
    });

    test("a caller who writes a stamped field keeps its value at every update site, captured members too; an update that leaves it out takes the stamp", async () => {
      const { base, db } = context;
      for (const id of [1, 2, 3, 4, 5, 6, 7])
        await base.post.create({ data: { id, title: `p${id}` } });
      for (const [id, postId] of [
        [10, 2],
        [11, 2],
        [13, 4],
      ] as const)
        await base.comment.create({ data: { id, postId, body: `c${id}` } });
      await base.tag.create({
        data: { id: 30, name: "t", posts: { connect: [{ id: 5 }] } },
      });
      await db.post.update({
        where: { id: 1 },
        data: { title: "a", updatedBy: "u1" },
        actor: "hal",
      });
      await db.post.update({
        where: { id: 2 },
        data: {
          title: "b",
          comments: {
            update: [
              { where: { id: 10 }, data: { body: "x", updatedBy: "u10" } },
            ],
            updateMany: [{ where: { id: 11 }, data: { body: "y" } }],
          },
        },
        actor: "ivy",
      });
      await db.post.updateMany({
        where: { id: { in: [3, 4] } },
        data: { title: "m", updatedBy: "u34" },
        actor: "jo",
      });
      // Each captured member is admitted again: its own value stands, and
      // the tag it nests takes the stamp.
      await db.post.updateMany({
        where: { id: 5 },
        data: {
          title: "n",
          updatedBy: "u5",
          tags: { updateMany: [{ where: {}, data: { name: "u" } }] },
        },
        actor: "kim",
      });
      await db.post.upsert({
        where: { id: 6 },
        create: { id: 6, title: "never" },
        update: { title: "f", updatedBy: "u6" },
        actor: "lee",
      });
      await db.$transaction([
        db.post.upsert({
          where: { id: 7 },
          create: { id: 7, title: "never" },
          update: { title: "g", updatedBy: "u7" },
          actor: "max",
        }),
      ]);
      await db.post.update({
        where: { id: 4 },
        data: {
          comments: {
            upsert: [
              {
                where: { id: 13 },
                create: { id: 13, body: "never" },
                update: { body: "w", updatedBy: "u13" },
              },
            ],
          },
        },
        actor: "eve",
      });
      expect(await stamped("post")).toEqual([
        [1, null, "u1"],
        [2, null, "ivy"],
        [3, null, "u34"],
        [4, null, "eve"],
        [5, null, "u5"],
        [6, null, "u6"],
        [7, null, "u7"],
      ]);
      expect(await stamped("comment")).toEqual([
        [10, null, "u10"],
        [11, null, "ivy"],
        [13, null, "u13"],
      ]);
      expect(await stamped("tag")).toEqual([[30, null, "kim"]]);
      // A field audit writes only on create is the caller's on an update.
      await db.post.update({
        where: { id: 1 },
        data: { createdBy: "fixed" },
        actor: "bob",
      });
      expect((await stamped("post"))[0]).toEqual([1, "fixed", "bob"]);
    });

    test("two extensions on one model: both write their fields, the later one wins a field both write, its control absent too; the caller wins over both", async () => {
      const { base, logged } = context;
      const later = logged.$extends(audit(MODELS)).$extends(origin);
      await later.post.create({
        data: { id: 1, title: "a" },
        actor: "ann",
        device: "cli",
      });
      // A field naming a control the call did not pass is not written.
      await later.post.create({ data: { id: 2, title: "b" }, actor: "ann" });
      const earlier = logged.$extends(origin).$extends(audit(MODELS));
      await earlier.post.create({
        data: { id: 3, title: "c" },
        actor: "bob",
        device: "web",
      });
      expect(
        await base.post.findMany({
          ...byId,
          select: { id: true, createdBy: true, source: true },
        })
      ).toEqual([
        { id: 1, createdBy: "system", source: "cli" },
        { id: 2, createdBy: "system", source: null },
        { id: 3, createdBy: "bob", source: "web" },
      ]);
      // The caller wins over both, its value written whether the call
      // passes the control or not.
      await later.post.create({
        data: { id: 4, title: "d", createdBy: "x", source: "me" },
        actor: "ann",
        device: "cli",
      });
      await later.post.create({
        data: { id: 8, title: "h", source: "me" },
        actor: "ann",
      });
      // The later extension owns `source` even on a call without its
      // control: the earlier constant is not written then.
      const imported = defineExtension({
        name: "imported",
        data: { models: { post: { create: { source: "import" } } } },
      });
      const replaced = logged.$extends(imported).$extends(origin);
      await replaced.post.create({ data: { id: 5, title: "e" } });
      await replaced.post.create({
        data: { id: 6, title: "f" },
        device: "cli",
      });
      await logged
        .$extends(imported)
        .post.create({ data: { id: 7, title: "g" } });
      expect(
        await base.post.findMany({
          ...byId,
          where: { id: { gte: 4 } },
          select: { id: true, source: true },
        })
      ).toEqual([
        { id: 4, source: "me" },
        { id: 5, source: null },
        { id: 6, source: "cli" },
        { id: 7, source: "import" },
        { id: 8, source: "me" },
      ]);
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 4 } })).createdBy
      ).toBe("x");
    });

    test("tenancy writes the call's tenant on every create that leaves it out; a caller who writes another tenant writes into it", async () => {
      const { base, logged } = context;
      const db = logged.$extends(tenancy(MODELS));
      await db.post.create({
        data: {
          id: 1,
          title: "a",
          comments: { create: [{ id: 10, body: "x" }] },
        },
        tenant: "acme",
      });
      await db.post.createMany({
        data: [{ id: 2, title: "b" }],
        tenant: "globex",
      });
      expect(
        await base.post.findMany({
          ...byId,
          select: { id: true, tenantId: true },
        })
      ).toEqual([
        { id: 1, tenantId: "acme" },
        { id: 2, tenantId: "globex" },
      ]);
      expect(
        (await base.comment.findUniqueOrThrow({ where: { id: 10 } })).tenantId
      ).toBe("acme");
      expect(ids(await db.post.findMany({ ...byId, tenant: "acme" }))).toEqual([
        1,
      ]);
      // Writes are not enforced: a caller who writes tenantId writes into
      // that tenant, on a create and on an update; reads stay the tenant's.
      expect(
        await db.post.create({
          data: { id: 3, title: "c", tenantId: "globex" },
          tenant: "acme",
          select: { tenantId: true },
        })
      ).toEqual({ tenantId: "globex" });
      expect(
        await db.post.update({
          where: { id: 1 },
          data: { tenantId: "globex" },
          tenant: "acme",
          select: { tenantId: true },
        })
      ).toEqual({ tenantId: "globex" });
      expect(
        await base.post.findMany({
          ...byId,
          select: { id: true, tenantId: true },
        })
      ).toEqual([
        { id: 1, tenantId: "globex" },
        { id: 2, tenantId: "globex" },
        { id: 3, tenantId: "globex" },
      ]);
      expect(await db.post.findMany({ tenant: "acme" })).toEqual([]);
    });

    test("the optimistic lock: an update increments the version through the update schema; a moved version is NotFound", async () => {
      const { base, logged } = context;
      const db = logged.$extends(optimisticLock(["post"]));
      for (const id of [1, 2])
        await base.post.create({ data: { id, title: `p${id}` } });
      const version = async (id: number) =>
        (await base.post.findUniqueOrThrow({ where: { id } })).version;
      expect(
        await db.post.update({
          where: { id: 1 },
          data: { title: "a" },
          expectedVersion: 0,
          select: { version: true },
        })
      ).toEqual({ version: 1 });
      const moved = await failure(
        db.post.update({
          where: { id: 1 },
          data: { title: "stale" },
          expectedVersion: 0,
        })
      );
      expect(moved).toBeInstanceOf(NotFoundError);
      expect(
        (await base.post.findUniqueOrThrow({ where: { id: 1 } })).title
      ).toBe("a");
      // Without an expected version nothing is checked; the stamp still
      // increments, on every row an updateMany takes.
      await db.post.update({ where: { id: 1 }, data: { title: "b" } });
      expect(await version(1)).toBe(2);
      expect(await db.post.updateMany({ data: { title: "c" } })).toEqual({
        count: 2,
      });
      expect([await version(1), await version(2)]).toEqual([3, 1]);
      expect(
        await db.post.update({
          where: { id: 2 },
          data: { title: "d" },
          expectedVersion: 0,
          versionCheck: "unchecked",
          select: { version: true },
        })
      ).toEqual({ version: 2 });
      // A version the caller writes wins over the increment; the check
      // still reads the expected one.
      expect(
        await db.post.update({
          where: { id: 2 },
          data: { title: "e", version: 10 },
          expectedVersion: 2,
          select: { version: true },
        })
      ).toEqual({ version: 10 });
      expect(
        await failure(db.post.delete({ where: { id: 2 }, expectedVersion: 2 }))
      ).toBeInstanceOf(NotFoundError);
      await db.post.delete({ where: { id: 2 }, expectedVersion: 10 });
      expect(await base.post.findUnique({ where: { id: 2 } })).toBeNull();
    });
  });
}
