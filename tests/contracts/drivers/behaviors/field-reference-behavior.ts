import { defineContract } from "@tests/contracts/contract";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createModelFieldRefs } from "@schema/field-ref";
import type { OperandCtx } from "@validation/primitives/operand";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fieldRefSchema } from "@tests/fixtures/field-ref-schema";

const schema = fieldRefSchema;

const createFieldRefClient = (driver: AnyDriver) =>
  createClient({ schema, driver });

type FieldRefClient = ReturnType<typeof createFieldRefClient>;

/**
 * The operand callback context of each model: `ctx.fields` is keyed to THAT
 * model's scalars, which is what makes `ctx.fields.likes` legal inside a post
 * filter and `ctx.fields.nickname` legal inside a user one.
 */
type PostCtx = OperandCtx<typeof schema.post>;
type UserCtx = OperandCtx<typeof schema.user>;

/**
 * A token belonging to ANOTHER model, held directly.
 *
 * A callback can only ever hand out the current model's fields, so the
 * same-model rule needs a token that was not obtained through one — which is
 * also the proof that the token remains the mechanism and the callback only
 * sugar for reaching it.
 */
const foreignToken = createModelFieldRefs("user", schema.user);

/**
 * Post's own tokens, held directly. The callback is sugar; a stored token is
 * still a valid operand, and the surfaces that REFUSE a reference have to
 * refuse the token itself — a callback would be stopped earlier, by the
 * position's own schema, and would prove nothing about the token guard.
 */
const postToken = createModelFieldRefs("post", schema.post);

const CROSS_MODEL_REFUSAL =
  /Field reference 'user\.name' cannot be used while filtering 'post'/;
const WRONG_TYPE_REFUSAL =
  /Field reference 'post\.views' is of type 'int', but a 'string' operand is required here/;
const HAVING_REFUSAL = /is not supported in 'having'/;
const JSON_FILTER_REFUSAL =
  /Field reference 'post\.payload' is not supported in a JSON filter operand/;
const JSON_DATA_REFUSAL =
  /Field reference 'post\.payload' is not supported in JSON write data/;
const ENUM_ORDER_REFUSAL =
  /is not supported on an enum field: PostgreSQL orders enum values by their declaration order/;

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
      expect(
        await postIds({ views: { gt: (ctx: PostCtx) => ctx.fields.likes } })
      ).toEqual(["hot"]);
    });

    test("lt compares two columns of the same row", async () => {
      expect(
        await postIds({ views: { lt: (ctx: PostCtx) => ctx.fields.likes } })
      ).toEqual(["beloved"]);
    });

    test("gte and lte include the equal row", async () => {
      expect(
        await postIds({ views: { gte: (ctx: PostCtx) => ctx.fields.likes } })
      ).toEqual(["even", "hot", "matching"]);
      expect(
        await postIds({ views: { lte: (ctx: PostCtx) => ctx.fields.likes } })
      ).toEqual(["beloved", "even", "matching"]);
    });

    test("equals and not compare two columns of the same row", async () => {
      expect(
        await postIds({ views: { equals: (ctx: PostCtx) => ctx.fields.likes } })
      ).toEqual(["even", "matching"]);
      expect(
        await postIds({ views: { not: (ctx: PostCtx) => ctx.fields.likes } })
      ).toEqual(["beloved", "hot"]);
    });

    test("a bare reference is the equals shorthand", async () => {
      expect(
        await postIds({ views: (ctx: PostCtx) => ctx.fields.likes })
      ).toEqual(["even", "matching"]);
    });

    test("a reference resolves through .map()ed column names", async () => {
      // `slug` is stored as "slug_column": a reference that emitted the field
      // key instead of the column name would not even parse as SQL.
      expect(
        await postIds({ title: { equals: (ctx: PostCtx) => ctx.fields.slug } })
      ).toEqual(["matching"]);
    });

    /**
     * The text predicates take a reference TOKEN and nothing else — no SQL
     * fragment, and so no callback either (the callback exists to return one of
     * those two). The line is drawn at the comparison operators, where the
     * builder's operand handling is uniform; see `validation/primitives/operand.ts`.
     */
    test("string prefix/suffix/substring predicates accept a reference", async () => {
      expect(await postIds({ title: { contains: postToken.slug } })).toEqual([
        "matching",
      ]);
      expect(await postIds({ title: { startsWith: postToken.slug } })).toEqual([
        "matching",
      ]);
      expect(await postIds({ title: { endsWith: postToken.slug } })).toEqual([
        "matching",
      ]);
    });

    test("a callback is refused where only the token is accepted", async () => {
      await expect(
        db().post.findMany({
          where: {
            title: { contains: ((ctx: PostCtx) => ctx.fields.slug) as never },
          },
        })
      ).rejects.toThrow();
    });

    /**
     * `mode: "insensitive"` against a REFERENCED column.
     *
     * Two separate things are on trial here, and only a live database settles
     * either of them:
     *
     *  - DEFAULT mode must stay case-SENSITIVE even where the server's own
     *    collation is not. MySQL's default (`utf8mb4_…_ai_ci`) makes
     *    `title = slug` case-insensitive unless the builder wraps the operands,
     *    so the first assertion below is the only thing standing between
     *    "default mode" and "whatever the DBA configured".
     *  - INSENSITIVE mode must fold the referenced column too. Folding only the
     *    filtered side leaves a comparison between folded and unfolded text,
     *    which quietly stops matching — the failure is missing rows, never an
     *    error, so it is invisible to any assertion on generated SQL alone.
     *
     * Extra rows are created inside each test (the fixture is rebuilt per test)
     * so the shared expectations above stay untouched.
     */
    describe("case folding against a referenced column", () => {
      // The token, because this block also drives the TEXT predicates, which
      // take a reference and nothing else.
      const slugRef = () => postToken.slug;

      const addPost = (id: string, title: string, slug: string) =>
        db().post.create({
          data: { id, title, slug, views: 1, likes: 1, authorId: "u1" },
        });

      test("default mode compares case-sensitively, whatever the server collation", async () => {
        await addPost("cased", "Same-Text", "same-text");
        // "matching" holds identical text in both columns; "cased" differs only
        // by case, and must NOT match.
        expect(await postIds({ title: { equals: slugRef() } })).toEqual([
          "matching",
        ]);
        expect(await postIds({ title: { contains: slugRef() } })).toEqual([
          "matching",
        ]);
      });

      test("insensitive mode folds both the filtered and the referenced column", async () => {
        await addPost("cased", "Same-Text", "same-text");
        expect(
          await postIds({
            title: { equals: slugRef(), mode: "insensitive" },
          })
        ).toEqual(["cased", "matching"]);
      });

      test.each([
        "contains",
        "startsWith",
        "endsWith",
      ])("insensitive %s folds the referenced column", async (operator) => {
        // The UPPER case lives in the REFERENCED column, so a builder that
        // folds only the filtered side finds nothing here.
        await addPost("shout", "echo", "ECHO");
        expect(
          await postIds({
            title: { [operator]: slugRef(), mode: "insensitive" },
          })
        ).toEqual(["matching", "shout"]);
      });

      test("insensitive `not` complements the folded comparison", async () => {
        await addPost("cased", "Same-Text", "same-text");
        expect(
          await postIds({ title: { not: slugRef(), mode: "insensitive" } })
        ).toEqual(["beloved", "even", "hot"]);
      });

      test("insensitive mode folds ASCII only", async () => {
        // Portable insensitive mode is an ASCII A-Z fold, deliberately not the
        // provider's Unicode-aware collation: 'É' and 'é' stay distinct on
        // every dialect, including MySQL, whose accent-insensitive default
        // collation would otherwise call them equal.
        await addPost("accented", "École", "école");
        expect(
          await postIds({ title: { equals: slugRef(), mode: "insensitive" } })
        ).toEqual(["matching"]);
      });
    });

    /**
     * Enum references, which used to be the one type that answered DIFFERENTLY
     * per provider instead of answering or refusing everywhere.
     *
     * `status` and `reviewStatus` are separate PostgreSQL enum types, so
     * `status = reviewStatus` had no operator there and the query died with
     * 42883 — while SQLite and LibSQL, which store the values as text, returned
     * rows. Accepted, typed and documented on one dialect, a hard error on
     * another: exactly the silent divergence the portability rule forbids.
     * Both sides now go through text, so all three answer the same question.
     */
    describe("enum references", () => {
      const reviewRef = () => (ctx: PostCtx) => ctx.fields.reviewStatus;

      /** One row where the two enum columns agree; every seeded row differs. */
      const addAgreeingPost = () =>
        db().post.create({
          data: {
            id: "agreed",
            title: "agreed",
            slug: "agreed-slug",
            status: "review",
            reviewStatus: "review",
            authorId: "u1",
          },
        });

      test("equals compares two enum columns of the same row", async () => {
        await addAgreeingPost();
        expect(await postIds({ status: { equals: reviewRef() } })).toEqual([
          "agreed",
        ]);
      });

      test("not complements it", async () => {
        await addAgreeingPost();
        expect(await postIds({ status: { not: reviewRef() } })).toEqual([
          "beloved",
          "even",
          "hot",
          "matching",
        ]);
      });

      test("a bare enum reference is the equals shorthand", async () => {
        await addAgreeingPost();
        expect(await postIds({ status: reviewRef() })).toEqual(["agreed"]);
      });

      test("the reference resolves through the .map()ed column name", async () => {
        // `reviewStatus` is stored as "review_status": emitting the field key
        // would not parse as SQL on any dialect.
        await addAgreeingPost();
        expect(
          await postIds({ status: { not: { not: reviewRef() } } })
        ).toEqual(["agreed"]);
      });

      /**
       * Ordered comparison is refused on EVERY dialect rather than answered
       * differently on each: PostgreSQL orders an enum by declaration order,
       * MySQL and SQLite compare the text. There is no portable answer, so
       * there is no answer — and the refusal says why.
       */
      test.each([
        "lt",
        "lte",
        "gt",
        "gte",
      ])("%s on an enum is refused with the portability reason", async (op) => {
        await expect(
          db().post.findMany({
            where: { status: { [op]: reviewRef() } } as never,
          })
        ).rejects.toThrow(ENUM_ORDER_REFUSAL);
        // A literal operand is refused identically — the refusal is about the
        // operator on an enum, not about references.
        await expect(
          db().post.findMany({
            where: { status: { [op]: "review" } } as never,
          })
        ).rejects.toThrow(ENUM_ORDER_REFUSAL);
      });

      test("literal enum filters are untouched", async () => {
        await addAgreeingPost();
        expect(await postIds({ status: "draft" })).toEqual([
          "beloved",
          "even",
          "hot",
          "matching",
        ]);
        expect(await postIds({ status: { in: ["review"] } })).toEqual([
          "agreed",
        ]);
      });
    });

    test("a reference mixes with literal operands in one filter object", async () => {
      expect(
        await postIds({
          views: { gt: (ctx: PostCtx) => ctx.fields.likes, lt: 1000 },
        })
      ).toEqual(["hot"]);
      expect(
        await postIds({
          views: { gt: (ctx: PostCtx) => ctx.fields.likes, lt: 50 },
        })
      ).toEqual([]);
    });

    test("a reference works inside a nested relation where", async () => {
      const users = await db().user.findMany({
        where: {
          posts: {
            some: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
          },
        },
      });
      expect(users.map((u) => u.id)).toEqual(["u1"]);
    });

    test("the nested scope's own model is the one a reference must name", async () => {
      // `user.name` vs `user.nickname` — the reference is resolved against the
      // OUTER scope even though a `posts.some` filter sits beside it.
      const users = await db().user.findMany({
        where: {
          name: { equals: (ctx: UserCtx) => ctx.fields.nickname },
          posts: { some: { views: { gt: 0 } } },
        },
      });
      expect(users.map((u) => u.id)).toEqual(["u1"]);
    });

    test("a reference drives updateMany and deleteMany", async () => {
      const updated = await db().post.updateMany({
        where: { views: { gt: (ctx: PostCtx) => ctx.fields.likes } },
        data: { title: "trending" },
      });
      expect(updated.count).toBe(1);
      expect(
        (await db().post.findUnique({ where: { id: "hot" } }))?.title
      ).toBe("trending");

      const deleted = await db().post.deleteMany({
        where: { views: { lt: (ctx: PostCtx) => ctx.fields.likes } },
      });
      expect(deleted.count).toBe(1);
      expect(await db().post.count()).toBe(3);
    });

    test("a cross-model reference is refused before any I/O", async () => {
      await expect(
        db().post.findMany({
          where: { title: { equals: foreignToken.name as never } },
        })
      ).rejects.toThrow(CROSS_MODEL_REFUSAL);
    });

    test("a reference of the wrong scalar type is refused", async () => {
      await expect(
        db().post.findMany({
          where: {
            title: { equals: ((ctx: PostCtx) => ctx.fields.views) as never },
          },
        })
      ).rejects.toThrow(WRONG_TYPE_REFUSAL);
    });

    test("a reference is refused in in/notIn", async () => {
      await expect(
        db().post.findMany({
          where: { views: { in: [postToken.likes] as never } },
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
      const ref = () => (ctx: PostCtx) => ctx.fields.likes;
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
      const ref = () => postToken.payload as never;

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

    /**
     * SQL fragments as comparison operands (W8-A Unit 2).
     *
     * A fragment is the escape hatch: its TEXT is the caller's dialect
     * responsibility, exactly like `$queryRaw`, and it is outside the
     * portability promise the rest of the filter language keeps. That
     * responsibility falls on this suite too, because it runs on every leg —
     * so every identifier inside a fragment here is escaped through the
     * ADAPTER OF THE DRIVER UNDER TEST (`ident`), never spelled with a
     * hard-coded quote character. MySQL's default `sql_mode` has no
     * `ANSI_QUOTES`: `"likes"` there is the string literal 'likes', which
     * would not fail loudly but answer a different question
     * (`views > 'likes' * 2` is `views > 0`), and `FROM "fieldref_posts"` is
     * a parse error. Only shapes that mean the same thing on all three local
     * dialects once their identifiers are quoted are asserted here; a
     * dialect-specific fragment is the caller's business.
     *
     * What a live database settles and generated SQL cannot: that the fragment
     * really is spliced as an EXPRESSION (a bound parameter would compare the
     * text of the fragment, matching nothing) and that its interpolations
     * really are bound (a concatenated one would either error or, worse, run).
     */
    describe("SQL fragment operands", () => {
      /** An identifier quoted for the dialect the current leg is running on. */
      const ident = (name: string) =>
        db().$driver.adapter.identifiers.escape(name);

      test("an arithmetic expression compares against the row", async () => {
        // views > likes * 2 — true only for "hot" (100 > 10).
        expect(
          await postIds({
            views: { gt: (ctx: PostCtx) => ctx.sql`${ident("likes")} * ${2}` },
          })
        ).toEqual(["hot"]);
      });

      test("a scalar subquery compares against the whole table", async () => {
        // views >= the maximum views in the table — only "hot" (100).
        expect(
          await postIds({
            views: {
              gte: (ctx: PostCtx) =>
                ctx.sql`SELECT MAX(${ident("views")}) FROM ${ident(
                  "fieldref_posts"
                )}`,
            },
          })
        ).toEqual(["hot"]);
      });

      test("an interpolated value rides as a bound parameter", async () => {
        // The value is a STRING that would be a syntax error if it were
        // concatenated into the statement instead of bound.
        const hostile = "'); DROP TABLE fieldref_posts; --";
        expect(
          await postIds({
            title: { equals: (ctx: PostCtx) => ctx.sql`${hostile}` },
          })
        ).toEqual([]);
        // The table is still there, with every row.
        expect(await db().post.count()).toBe(4);
      });

      test("a fragment, a reference and a literal mix in one filter", async () => {
        expect(
          await postIds({
            views: {
              gt: (ctx: PostCtx) => ctx.fields.likes,
              gte: (ctx: PostCtx) => ctx.sql`${10}`,
              lt: 1000,
            },
          })
        ).toEqual(["hot"]);
      });

      test("a fragment drives updateMany and deleteMany", async () => {
        const updated = await db().post.updateMany({
          where: {
            views: { gt: (ctx: PostCtx) => ctx.sql`${ident("likes")} * ${2}` },
          },
          data: { title: "trending" },
        });
        expect(updated.count).toBe(1);

        const deleted = await db().post.deleteMany({
          where: {
            views: { lt: (ctx: PostCtx) => ctx.sql`${ident("likes")} - ${1}` },
          },
        });
        expect(deleted.count).toBe(1);
        expect(await db().post.count()).toBe(3);
      });

      test("a fragment survives both execution substrates", async () => {
        const where = {
          views: { gt: (ctx: PostCtx) => ctx.sql`${ident("likes")} * ${2}` },
        } as never;

        // The array form prepares a batch; the callback form runs in a
        // transaction. Both must resolve the callback at construction and
        // compile the same fragment.
        const [batched] = (await db().$transaction([
          db().post.findMany({ where }),
        ])) as [{ id: string }[]];
        expect(batched.map((p) => p.id)).toEqual(["hot"]);

        const inTransaction = await db().$transaction(async (tx) =>
          tx.post.findMany({ where })
        );
        expect(inTransaction.map((p) => p.id)).toEqual(["hot"]);
      });

      test("a fragment is refused where a reference is", async () => {
        await expect(
          db().post.groupBy({
            by: ["views"],
            having: {
              views: { gt: ((ctx: PostCtx) => ctx.sql`${1}`) as never },
            },
          })
        ).rejects.toThrow(HAVING_REFUSAL);
      });
    });
  });
}

export const fieldReferenceContract = defineContract({
  id: "drivers.field-reference",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runFieldReferenceBehavior,
});
