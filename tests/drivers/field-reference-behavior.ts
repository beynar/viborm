import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fieldRefSchema } from "../fixtures/field-ref-schema";

const schema = fieldRefSchema;

// Inferred, not annotated: an explicit `VibORMConfig & { schema: … }` would
// widen `C["schema"]` back to the index-signature `Schema`, and `$fields` would
// lose the per-model field names this suite exists to exercise.
const createFieldRefClient = (driver: AnyDriver) =>
  createClient({ schema, driver });

type FieldRefClient = ReturnType<typeof createFieldRefClient>;

const CROSS_MODEL_REFUSAL =
  /Field reference 'user\.name' cannot be used while filtering 'post'/;
const WRONG_TYPE_REFUSAL =
  /Field reference 'post\.views' is of type 'int', but a 'string' operand is required here/;
const HAVING_REFUSAL = /is not supported in 'having'/;
const JSON_FILTER_REFUSAL =
  /Field reference 'post\.payload' is not supported in a JSON filter operand/;
const JSON_DATA_REFUSAL =
  /Field reference 'post\.payload' is not supported in JSON write data/;

export interface FieldReferenceBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Executes real SQL for column-to-column comparisons (Prisma `FieldRef` parity).
 *
 * `views > likes` must compare two columns OF THE SAME ROW. Text-only assertions
 * on generated SQL cannot catch a reference that silently became a bound
 * parameter (every row would match, or none would), so these run against the
 * database on every local dialect.
 */
export function runFieldReferenceBehavior({
  driverName,
  createDriver,
}: FieldReferenceBehaviorOptions) {
  describe(`${driverName} field references`, () => {
    let client: FieldRefClient | undefined;

    beforeEach(async () => {
      client = createFieldRefClient(createDriver());
      await push(client, { force: true });
      await client.user.createMany({
        data: [
          { id: "u1", name: "alice", nickname: "alice" },
          { id: "u2", name: "bob", nickname: "robert" },
        ],
      });
      await client.post.createMany({
        data: [
          // views > likes
          {
            id: "hot",
            title: "hot",
            slug: "hot-slug",
            views: 100,
            likes: 5,
            authorId: "u1",
          },
          // views == likes
          {
            id: "even",
            title: "even",
            slug: "even-slug",
            views: 7,
            likes: 7,
            authorId: "u1",
          },
          // views < likes
          {
            id: "beloved",
            title: "beloved",
            slug: "beloved-slug",
            views: 2,
            likes: 40,
            authorId: "u2",
          },
          // the only row whose title and slug hold the same text
          {
            id: "matching",
            title: "same-text",
            slug: "same-text",
            views: 1,
            likes: 1,
            authorId: "u2",
          },
        ],
      });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    const db = (): FieldRefClient => {
      if (!client) throw new Error("client not initialised");
      return client;
    };

    async function postIds(where: Record<string, unknown>) {
      const posts = await db().post.findMany({ where: where as never });
      return posts.map((p) => p.id).sort();
    }

    test("gt compares two columns of the same row", async () => {
      expect(await postIds({ views: { gt: db().$fields.post.likes } })).toEqual(
        ["hot"]
      );
    });

    test("lt compares two columns of the same row", async () => {
      expect(await postIds({ views: { lt: db().$fields.post.likes } })).toEqual(
        ["beloved"]
      );
    });

    test("gte and lte include the equal row", async () => {
      expect(
        await postIds({ views: { gte: db().$fields.post.likes } })
      ).toEqual(["even", "hot", "matching"]);
      expect(
        await postIds({ views: { lte: db().$fields.post.likes } })
      ).toEqual(["beloved", "even", "matching"]);
    });

    test("equals and not compare two columns of the same row", async () => {
      expect(
        await postIds({ views: { equals: db().$fields.post.likes } })
      ).toEqual(["even", "matching"]);
      expect(
        await postIds({ views: { not: db().$fields.post.likes } })
      ).toEqual(["beloved", "hot"]);
    });

    test("a bare reference is the equals shorthand", async () => {
      expect(await postIds({ views: db().$fields.post.likes })).toEqual([
        "even",
        "matching",
      ]);
    });

    test("a reference resolves through .map()ed column names", async () => {
      // `slug` is stored as "slug_column": a reference that emitted the field
      // key instead of the column name would not even parse as SQL.
      expect(
        await postIds({ title: { equals: db().$fields.post.slug } })
      ).toEqual(["matching"]);
    });

    test("string prefix/suffix/substring predicates accept a reference", async () => {
      expect(
        await postIds({ title: { contains: db().$fields.post.slug } })
      ).toEqual(["matching"]);
      expect(
        await postIds({ title: { startsWith: db().$fields.post.slug } })
      ).toEqual(["matching"]);
      expect(
        await postIds({ title: { endsWith: db().$fields.post.slug } })
      ).toEqual(["matching"]);
    });

    test("a reference mixes with literal operands in one filter object", async () => {
      expect(
        await postIds({ views: { gt: db().$fields.post.likes, lt: 1000 } })
      ).toEqual(["hot"]);
      expect(
        await postIds({ views: { gt: db().$fields.post.likes, lt: 50 } })
      ).toEqual([]);
    });

    test("a reference works inside a nested relation where", async () => {
      const users = await db().user.findMany({
        where: {
          posts: { some: { views: { gt: db().$fields.post.likes } } },
        },
      });
      expect(users.map((u) => u.id)).toEqual(["u1"]);
    });

    test("the nested scope's own model is the one a reference must name", async () => {
      // `user.name` vs `user.nickname` — the reference is resolved against the
      // OUTER scope even though a `posts.some` filter sits beside it.
      const users = await db().user.findMany({
        where: {
          name: { equals: db().$fields.user.nickname },
          posts: { some: { views: { gt: 0 } } },
        },
      });
      expect(users.map((u) => u.id)).toEqual(["u1"]);
    });

    test("a reference drives updateMany and deleteMany", async () => {
      const updated = await db().post.updateMany({
        where: { views: { gt: db().$fields.post.likes } },
        data: { title: "trending" },
      });
      expect(updated.count).toBe(1);
      expect(
        (await db().post.findUnique({ where: { id: "hot" } }))?.title
      ).toBe("trending");

      const deleted = await db().post.deleteMany({
        where: { views: { lt: db().$fields.post.likes } },
      });
      expect(deleted.count).toBe(1);
      expect(await db().post.count()).toBe(3);
    });

    test("a cross-model reference is refused before any I/O", async () => {
      await expect(
        db().post.findMany({
          where: { title: { equals: db().$fields.user.name } },
        })
      ).rejects.toThrow(CROSS_MODEL_REFUSAL);
    });

    test("a reference of the wrong scalar type is refused", async () => {
      await expect(
        db().post.findMany({
          where: { title: { equals: db().$fields.post.views as never } },
        })
      ).rejects.toThrow(WRONG_TYPE_REFUSAL);
    });

    test("a reference is refused in in/notIn", async () => {
      await expect(
        db().post.findMany({
          where: { views: { in: [db().$fields.post.likes] as never } },
        })
      ).rejects.toThrow();
    });

    /**
     * `having` is closed to references on purpose (Prisma excludes them too:
     * a HAVING operand is an aggregate over a group, not a column of one row),
     * and the closure has to hold however deeply the reference is buried —
     * scalar `not` nests arbitrarily. This runs on every dialect because the
     * consequence of a leak is dialect-DEPENDENT: Postgres rejects the
     * ungrouped column with a database error, while SQLite and LibSQL accept
     * it and answer with a silently wrong row. The refusal must land before
     * any statement is issued, so all dialects agree.
     */
    test("a reference is refused in `having`, however deeply nested", async () => {
      const ref = () => db().$fields.post.likes;
      for (const having of [
        { views: { gt: ref() } },
        { views: { not: { not: { not: { not: { gt: ref() } } } } } },
        { OR: [{ views: { not: { not: { not: { not: { gt: ref() } } } } } }] },
      ]) {
        await expect(
          db().post.groupBy({ by: ["views"], having: having as never })
        ).rejects.toThrow(HAVING_REFUSAL);
      }

      // The same shape without a reference still groups normally.
      const groups = await db().post.groupBy({
        by: ["views"],
        having: { views: { not: { not: { not: { not: { gt: 7 } } } } } },
      });
      expect(groups.map((g) => g.views).sort((a, b) => a - b)).toEqual([100]);
    });

    /**
     * JSON operands and JSON write data are closed to references, and the
     * closure has to hold against a LIVE database because the failure mode was
     * not an error: a token in a filter serialized to a parameter and matched
     * nothing, and a token in `data` was WRITTEN into the user's column. Both
     * are silent — only a real round-trip shows the difference between "refused"
     * and "accepted and quietly wrong".
     */
    test("a reference is refused in JSON filters and JSON write data", async () => {
      const ref = () => db().$fields.post.payload as never;

      await expect(
        db().post.findMany({ where: { payload: { equals: ref() } } })
      ).rejects.toThrow(JSON_FILTER_REFUSAL);
      await expect(
        db().post.findMany({
          where: { payload: { array_contains: ref() } },
        })
      ).rejects.toThrow(JSON_FILTER_REFUSAL);
      await expect(
        db().post.create({
          data: {
            id: "leak",
            title: "leak",
            slug: "leak",
            payload: ref(),
            authorId: "u1",
          },
        })
      ).rejects.toThrow(JSON_DATA_REFUSAL);
      await expect(
        db().post.update({
          where: { id: "hot" },
          data: { payload: ref() },
        })
      ).rejects.toThrow(JSON_DATA_REFUSAL);

      // Nothing was written by the refused create, and the refused update left
      // the row alone — the refusal lands before any statement is issued.
      expect(await db().post.findUnique({ where: { id: "leak" } })).toBeNull();
      expect(
        (await db().post.findUnique({ where: { id: "hot" } }))?.payload
      ).toBeNull();

      // The complement: ordinary JSON still round-trips, so the closure is
      // about tokens and not about JSON.
      await db().post.update({
        where: { id: "hot" },
        data: { payload: { seen: true } },
      });
      expect(
        (await db().post.findUnique({ where: { id: "hot" } }))?.payload
      ).toEqual({ seen: true });
    });
  });
}
