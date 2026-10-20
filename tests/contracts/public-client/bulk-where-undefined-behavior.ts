import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("bulk_undefined_authors");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    tenantId: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("bulk_undefined_posts");
const schema = { author, post };

const POSTS = [
  { id: "p1", title: "one", tenantId: "t1", authorId: "a1" },
  { id: "p2", title: "two", tenantId: "t1", authorId: "a1" },
  { id: "p3", title: "three", tenantId: "t2", authorId: null },
] as const;

/**
 * Wheres a bulk write may receive, each with an `undefined` somewhere. Which
 * of them are refused is not written here: the test reads it from the
 * database, so the refusal is pinned to the engine's own reading of a where.
 */
const POST_WHERES: Record<string, unknown>[] = [
  { tenantId: undefined },
  { tenantId: undefined, id: undefined },
  { AND: [{ id: undefined }] },
  { AND: { id: undefined } },
  { AND: [], id: undefined },
  { NOT: { id: undefined } },
  { NOT: [{ id: undefined }, { title: undefined }] },
  { NOT: { OR: [{ id: undefined }] } },
  { OR: [{ id: undefined }] },
  { OR: [{ id: undefined }, { id: "p1" }] },
  { OR: [{ id: undefined }, { AND: [] }] },
  { id: undefined, title: "one" },
  { author: { is: { id: undefined } } },
  { author: { isNot: { name: undefined } } },
];
const AUTHOR_WHERES: Record<string, unknown>[] = [
  { posts: { every: { title: undefined } } },
  { posts: { every: { title: undefined }, some: undefined } },
  { posts: { some: { title: undefined } } },
  { posts: { none: { title: undefined } } },
  { OR: [{ posts: { every: { title: undefined } } }] },
  { NOT: { posts: { every: { NOT: { OR: [{ id: undefined }] } } } } },
];

const label = (where: unknown) =>
  JSON.stringify(where, (_key, value) =>
    value === undefined ? "<undefined>" : value
  );

/**
 * A bulk write whose `where` matches every row only because members spelled
 * `undefined` were dropped is refused before any SQL; `where: {}`, an absent
 * `where`, and a where that still states a condition are not.
 */
export function runBulkWhereUndefinedBehavior({
  name: provider,
  createDriver,
}: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}) {
  describe(`${provider}: bulk writes refuse a where emptied by undefined`, () => {
    const clients: { $disconnect(): Promise<void> }[] = [];
    afterEach(async () => {
      for (const client of clients.splice(0)) await client.$disconnect();
    });

    const open = async () => {
      const driver = createDriver();
      const statements: string[] = [];
      const observed = driver as unknown as {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
      const execute = observed.execute.bind(driver);
      observed.execute = (...args: unknown[]) => {
        statements.push(args[1] as string);
        return execute(...args);
      };
      const db = createClient({ schema, driver });
      clients.push(db);
      await syncLiveSchema(db);
      await db.author.createMany({
        data: [
          { id: "a1", name: "Ada" },
          { id: "a2", name: "Bo" },
        ],
      });
      await db.post.createMany({ data: [...POSTS] });
      statements.length = 0;
      return { db, statements };
    };

    test(`${provider}: deleteMany and updateMany with only undefined members are refused, naming the operation and the keys`, async () => {
      const { db, statements } = await open();
      const tenantId: string | undefined = undefined;

      const deleted = db.post.deleteMany({ where: { tenantId } });
      await expect(deleted).rejects.toBeInstanceOf(ValidationError);
      await expect(deleted).rejects.toMatchObject({ code: "V4001" });
      await expect(deleted).rejects.toThrow(
        "deleteMany would delete every row: its where names only undefined values (tenantId)"
      );
      await expect(
        db.post.updateMany({
          where: { tenantId, AND: [{ id: undefined }] },
          data: { title: "x" },
        })
      ).rejects.toThrow(
        "updateMany would update every row: its where names only undefined values (tenantId, AND[0].id)"
      );
      await expect(
        db.post.deleteMany({ where: { tenantId }, limit: 1 })
      ).rejects.toThrow(ValidationError);
      await expect(
        db.post.deleteMany({ where: { tenantId }, select: { id: true } })
      ).rejects.toThrow(ValidationError);

      expect(statements).toEqual([]);
      expect(await db.post.count()).toBe(3);
      expect(
        (await db.post.findMany({ orderBy: { id: "asc" } })).map((p) => p.title)
      ).toEqual(["one", "two", "three"]);
    });

    test(`${provider}: an explicit every-row where is still every row`, async () => {
      const { db } = await open();
      expect(
        await db.post.updateMany({ where: {}, data: { title: "x" } })
      ).toEqual({ count: 3 });
      expect(
        await db.post.updateMany({ where: { AND: [] }, data: { title: "y" } })
      ).toEqual({ count: 3 });
      expect(await db.post.updateMany({ data: { title: "z" } })).toEqual({
        count: 3,
      });
      // Every row whatever the undefined member meant: it is not the cause.
      expect(
        await db.post.updateMany({
          where: { OR: [{ NOT: { OR: [] } }, { id: undefined }] },
          data: { title: "w" },
        })
      ).toEqual({ count: 3 });
      expect(await db.post.deleteMany({ where: undefined })).toEqual({
        count: 3,
      });
    });

    test(`${provider}: a where is refused exactly when dropping its undefined members makes it match every row`, async () => {
      const { db } = await open();
      const cases = [
        ...POST_WHERES.map((where) => ({ model: "post" as const, where })),
        ...AUTHOR_WHERES.map((where) => ({ model: "author" as const, where })),
      ];
      const observed: string[] = [];
      for (const { model, where } of cases) {
        const delegate = model === "post" ? db.post : db.author;
        const total = await (delegate.count as () => Promise<number>)();
        const matched = (
          await (delegate.findMany as (args: unknown) => Promise<unknown[]>)({
            where,
          })
        ).length;
        const refused = await (
          delegate.updateMany as (args: unknown) => Promise<unknown>
        )({
          where,
          data: model === "post" ? { tenantId: "t9" } : { name: "same" },
        }).then(
          () => false,
          (error: unknown) => {
            if (error instanceof ValidationError) return true;
            throw error;
          }
        );
        // Every where in the corpus has an undefined member and states a
        // real condition once it is counted, so "matches every row" is the
        // collapse.
        observed.push(`${model} ${label(where)} matched ${matched}/${total}`);
        expect(
          refused,
          `${model} ${label(where)}: matched ${matched} of ${total}`
        ).toBe(matched === total);
      }
      // The corpus exercises both arms on this seed.
      expect(
        observed.filter((line) => line.includes("matched 3/3")).length
      ).toBeGreaterThan(3);
      expect(observed.some((line) => line.includes("matched 0/"))).toBe(true);
    });

    test(`${provider}: a filter object whose operations are all undefined is refused before any bulk write`, async () => {
      const { db, statements } = await open();
      // Not this lane's guard: a scalar filter states an operation and a
      // relation filter a quantifier, on every operation
      // (`requireFilterOperation`, `requireRelationQuantifier`). The bulk
      // refusal relies on it, so it is pinned here on the bulk verbs.
      const postWheres: Record<string, unknown>[] = [
        { tenantId: { equals: undefined } },
        { id: { in: undefined } },
        { tenantId: { not: undefined } },
        { tenantId: { not: { equals: undefined } } },
        { tenantId: {} },
        { title: { contains: undefined, mode: "insensitive" } },
        { title: { mode: "insensitive" } },
        { author: { is: undefined } },
        { author: { isNot: undefined } },
        { AND: [{ tenantId: { equals: undefined } }] },
      ];
      for (const where of postWheres) {
        for (const write of [
          () => db.post.deleteMany({ where } as never),
          () => db.post.updateMany({ where, data: { title: "x" } } as never),
        ]) {
          await expect(write(), label(where)).rejects.toBeInstanceOf(
            ValidationError
          );
        }
      }
      for (const where of [
        { posts: { some: undefined } },
        { posts: { every: undefined, none: undefined } },
      ]) {
        await expect(
          db.author.deleteMany({ where } as never),
          label(where)
        ).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(
        db.author.update({
          where: { id: "a1" },
          data: { posts: { deleteMany: { tenantId: { equals: undefined } } } },
        } as never)
      ).rejects.toBeInstanceOf(ValidationError);
      expect(statements).toEqual([]);
      expect(await db.post.count()).toBe(3);
      expect(await db.author.count()).toBe(2);
    });

    test(`${provider}: nested deleteMany and updateMany are refused the same way, scoped to the related rows`, async () => {
      const { db, statements } = await open();
      await expect(
        db.author.update({
          where: { id: "a1" },
          data: { posts: { deleteMany: { title: undefined } } },
        })
      ).rejects.toThrow(
        "posts.deleteMany: This nested deleteMany would delete every related row: its where names only undefined values (title)"
      );
      await expect(
        db.author.update({
          where: { id: "a1" },
          data: {
            posts: { deleteMany: [{ id: "p1" }, { NOT: { id: undefined } }] },
          },
        })
      ).rejects.toThrow("posts.deleteMany.1: This nested deleteMany");
      await expect(
        db.author.update({
          where: { id: "a1" },
          data: {
            posts: {
              updateMany: {
                where: { tenantId: undefined },
                data: { title: "x" },
              },
            },
          },
        })
      ).rejects.toThrow(
        "posts.updateMany.where: This nested updateMany would update every related row"
      );
      expect(statements).toEqual([]);
      expect(await db.post.count()).toBe(3);

      await db.author.update({
        where: { id: "a1" },
        data: {
          posts: {
            updateMany: { where: {}, data: { title: "mine" } },
            deleteMany: { id: "p1", title: undefined },
          },
        },
      });
      expect(
        await db.post.findMany({
          select: { id: true, title: true },
          orderBy: { id: "asc" },
        })
      ).toEqual([
        { id: "p2", title: "mine" },
        { id: "p3", title: "three" },
      ]);
      await db.author.update({
        where: { id: "a1" },
        data: { posts: { deleteMany: {} } },
      });
      expect(
        (await db.post.findMany({ select: { id: true } })).map((p) => p.id)
      ).toEqual(["p3"]);
    });
  });
}
