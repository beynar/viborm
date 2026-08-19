import { createClient } from "@client/client";
import { QueryEngineError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const polymorphicRelationSchema = (() => {
  const post = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
      comments: s.oneToMany(() => comment).name("commentable"),
    })
    .map("poly_contract_posts");

  const video = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
    })
    .map("poly_contract_videos");

  const comment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      commentable: s
        .polymorphicToOne(
          { post: () => post, video: () => video },
          {
            values: {
              post: "content.post.v1",
              video: "content.video.v1",
            },
          }
        )
        .name("commentable")
        .optional(),
    })
    .map("poly_contract_comments");

  const requiredComment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      subject: s.polymorphicToOne({
        post: () => post,
        video: () => video,
      }),
    })
    .map("poly_contract_required_comments");

  return { post, video, comment, requiredComment };
})();

interface StoredComment {
  readonly id: number | bigint;
  readonly commentable_type: string | null;
  readonly commentable_id: number | bigint | null;
}

function normalizeStoredComment(comment: StoredComment) {
  return {
    id: Number(comment.id),
    commentable_type: comment.commentable_type,
    commentable_id:
      comment.commentable_id === null ? null : Number(comment.commentable_id),
  };
}

export type PolymorphicRelationBehaviorOptions = {
  readonly name: string;
} & BehaviorDatabaseSource;

export function runPolymorphicRelationBehavior(
  options: PolymorphicRelationBehaviorOptions
): void {
  describe(`${options.name} polymorphic relations`, () => {
    const openDatabase = useBehaviorDatabase(
      polymorphicRelationSchema,
      options
    );
    let database: Awaited<ReturnType<typeof openDatabase>> | undefined;

    beforeEach(async () => {
      database = await openDatabase();
    });

    afterEach(async () => {
      await database?.dispose();
      database = undefined;
    });

    function requireDatabase() {
      if (!database) throw new Error("Behavior database is not initialized");
      return database;
    }

    test("direct writes preserve the generated private storage pair", async () => {
      const { client } = requireDatabase();
      const ident = client.$driver.adapter.identifiers.escape;
      const post = await client.post.create({
        data: { slug: "connected-post", title: "Connected post" },
      });

      const connected = await client.comment.create({
        data: {
          body: "connected",
          commentable: {
            connect: { type: "post", where: { slug: "connected-post" } },
          },
        },
        include: { commentable: true },
      });
      const created = await client.comment.create({
        data: {
          body: "created",
          commentable: {
            create: {
              type: "video",
              data: { slug: "fresh-video", title: "Fresh video" },
            },
          },
        },
        include: { commentable: true },
      });

      expect(connected.commentable).toMatchObject({
        type: "post",
        data: { id: post.id, title: "Connected post" },
      });
      expect(created.commentable).toMatchObject({
        type: "video",
        data: { title: "Fresh video" },
      });

      const stored = await client.$queryRaw<StoredComment>(
        sql`SELECT ${ident("id")}, ${ident("commentable_type")}, ${ident(
          "commentable_id"
        )} FROM ${ident("poly_contract_comments")} ORDER BY ${ident("id")}`
      );
      expect(stored.map(normalizeStoredComment)).toEqual([
        {
          id: connected.id,
          commentable_type: "content.post.v1",
          commentable_id: post.id,
        },
        {
          id: created.id,
          commentable_type: "content.video.v1",
          commentable_id: created.commentable?.data.id,
        },
      ]);

      await client.comment.update({
        where: { id: connected.id },
        data: { commentable: { disconnect: true } },
      });
      const disconnected = await client.$queryRaw<StoredComment>(
        sql`SELECT ${ident("id")}, ${ident("commentable_type")}, ${ident(
          "commentable_id"
        )} FROM ${ident("poly_contract_comments")} WHERE ${ident(
          "id"
        )} = ${connected.id}`
      );
      expect(disconnected.map(normalizeStoredComment)).toEqual([
        {
          id: connected.id,
          commentable_type: null,
          commentable_id: null,
        },
      ]);
    });

    test("inverse create publishes a generated parent identity", async () => {
      const { client } = requireDatabase();
      const ident = client.$driver.adapter.identifiers.escape;
      const created = await client.post.create({
        data: {
          slug: "inverse-parent",
          title: "Inverse parent",
          comments: {
            create: [{ body: "first" }, { body: "second" }],
          },
        },
        include: { comments: { orderBy: { id: "asc" } } },
      });

      expect(created.comments.map(({ body }) => body)).toEqual([
        "first",
        "second",
      ]);
      const stored = await client.$queryRaw<StoredComment>(
        sql`SELECT ${ident("id")}, ${ident("commentable_type")}, ${ident(
          "commentable_id"
        )} FROM ${ident("poly_contract_comments")} ORDER BY ${ident("id")}`
      );
      expect(stored.map(normalizeStoredComment)).toEqual(
        created.comments.map(({ id }) => ({
          id,
          commentable_type: "content.post.v1",
          commentable_id: created.id,
        }))
      );
    });

    test("direct and inverse reads correlate exact variants without N+1", async () => {
      const { client, driver } = requireDatabase();
      const ident = client.$driver.adapter.identifiers.escape;
      const post = await client.post.create({
        data: { id: 41, slug: "same-id-post", title: "Exact target" },
      });
      await client.video.create({
        data: { id: post.id, slug: "same-id-video", title: "Wrong type" },
      });
      const first = await client.comment.create({
        data: {
          body: "first exact post",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const second = await client.comment.create({
        data: {
          body: "second exact post",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      await client.comment.create({
        data: {
          body: "same id, wrong type",
          commentable: { connect: { type: "video", where: { id: post.id } } },
        },
      });
      const caseDecoy = await client.comment.create({
        data: {
          body: "same id, wrong case",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      await client.$executeRaw(
        sql`UPDATE ${ident("poly_contract_comments")} SET ${ident(
          "commentable_type"
        )} = ${"CONTENT.POST.V1"} WHERE ${ident("id")} = ${caseDecoy.id}`
      );

      const queryEvents: Array<{
        readonly model: string | undefined;
        readonly operation: string | undefined;
      }> = [];
      const observed = createClient({
        schema: polymorphicRelationSchema,
        driver,
        instrumentation: {
          logging: {
            query: (event) => {
              queryEvents.push({
                model: event.model,
                operation: event.operation,
              });
            },
          },
        },
      });

      const direct = await observed.comment.findMany({
        where: {
          commentable: {
            type: "post",
            is: { title: { equals: "Exact target" } },
          },
        },
        orderBy: { id: "asc" },
        include: {
          commentable: {
            post: {
              select: {
                title: true,
                comments: {
                  orderBy: { id: "asc" },
                  select: { body: true },
                },
              },
            },
            video: { select: { title: true } },
          },
        },
      });

      expect(direct).toEqual([
        {
          id: first.id,
          body: "first exact post",
          commentable: {
            type: "post",
            data: {
              title: "Exact target",
              comments: [
                { body: "first exact post" },
                { body: "second exact post" },
              ],
            },
          },
        },
        {
          id: second.id,
          body: "second exact post",
          commentable: {
            type: "post",
            data: {
              title: "Exact target",
              comments: [
                { body: "first exact post" },
                { body: "second exact post" },
              ],
            },
          },
        },
      ]);
      const inverse = await observed.post.findUniqueOrThrow({
        where: { id: post.id },
        select: {
          id: true,
          comments: {
            orderBy: { id: "asc" },
            select: { body: true },
          },
          _count: { select: { comments: true } },
        },
      });
      expect(inverse).toEqual({
        id: post.id,
        comments: [{ body: "first exact post" }, { body: "second exact post" }],
        _count: { comments: 2 },
      });
      await expect(
        observed.post.findMany({
          where: {
            comments: {
              some: { body: { equals: "same id, wrong type" } },
            },
          },
        })
      ).resolves.toEqual([]);
      expect(queryEvents).toEqual([
        { model: "comment", operation: "findMany" },
        { model: "post", operation: "findUnique" },
        { model: "post", operation: "findMany" },
      ]);
    });

    test("target-local omit subtracts from polymorphic select", async () => {
      const { client } = requireDatabase();
      const post = await client.post.create({
        data: {
          slug: "projected-post",
          title: "Projected post",
        },
      });
      const video = await client.video.create({
        data: {
          slug: "projected-video",
          title: "Projected video",
        },
      });
      await client.comment.create({
        data: {
          body: "post comment",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      await client.comment.create({
        data: {
          body: "video comment",
          commentable: {
            connect: { type: "video", where: { id: video.id } },
          },
        },
      });

      const comments = await client.comment.findMany({
        orderBy: { id: "asc" },
        select: {
          body: true,
          commentable: {
            post: {
              select: { id: true, slug: true, title: true },
              omit: { slug: true },
            },
            video: {
              select: { id: true, slug: true, title: true },
              omit: { slug: true },
            },
          },
        },
      });

      expect(comments).toEqual([
        {
          body: "post comment",
          commentable: {
            type: "post",
            data: { id: post.id, title: "Projected post" },
          },
        },
        {
          body: "video comment",
          commentable: {
            type: "video",
            data: { id: video.id, title: "Projected video" },
          },
        },
      ]);
    });

    test.runIf(options.name === "pg")(
      "inverse reads use the generated discriminator/id index",
      async () => {
        const { client, driver } = requireDatabase();
        await client.$executeRawUnsafe(
          `INSERT INTO "poly_contract_posts" ("id", "slug", "title")
           SELECT n, 'plan-' || n, 'Plan ' || n
           FROM generate_series(1000, 1199) AS n`
        );
        await client.$executeRawUnsafe(
          `INSERT INTO "poly_contract_comments" ("body", "commentable_type", "commentable_id")
           SELECT 'comment-' || n, 'content.post.v1', 1000 + (n % 200)
           FROM generate_series(1, 4000) AS n`
        );
        await client.$executeRawUnsafe("ANALYZE poly_contract_comments");

        const statements: Array<{ sql: string; params: unknown[] }> = [];
        const observed = createClient({
          schema: polymorphicRelationSchema,
          driver,
          instrumentation: {
            logging: {
              query: (event) => {
                statements.push({
                  sql: event.sql ?? "",
                  params: event.params ?? [],
                });
              },
              includeSql: true,
              includeParams: true,
            },
          },
        });

        const selected = await observed.post.findUniqueOrThrow({
          where: { id: 1000 },
          include: { comments: true },
        });
        expect(selected.comments.length).toBeGreaterThan(0);
        expect(statements).toHaveLength(1);

        const statement = statements[0]!;
        const rows = await client.$queryRawUnsafe<Record<string, string>>(
          `EXPLAIN ${statement.sql}`,
          ...statement.params
        );
        const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
        expect(plan).toContain("poly_contract_comments_commentable_poly_idx");
        expect(plan).not.toContain("Seq Scan on poly_contract_comments");
      }
    );

    test("empty storage is optional but orphaned membership is invalid", async () => {
      const { client } = requireDatabase();
      const ident = client.$driver.adapter.identifiers.escape;
      const empty = await client.comment.create({ data: { body: "empty" } });
      const optionalTarget = await client.post.create({
        data: { slug: "optional-orphan", title: "Optional orphan" },
      });
      const requiredTarget = await client.video.create({
        data: { slug: "required-orphan", title: "Required orphan" },
      });
      const optional = await client.comment.create({
        data: {
          body: "optional orphan",
          commentable: {
            connect: { type: "post", where: { id: optionalTarget.id } },
          },
        },
      });
      const required = await client.requiredComment.create({
        data: {
          body: "required orphan",
          subject: {
            connect: { type: "video", where: { id: requiredTarget.id } },
          },
        },
      });

      await expect(
        client.comment.findUniqueOrThrow({
          where: { id: empty.id },
          include: { commentable: true },
        })
      ).resolves.toMatchObject({ commentable: null });

      await expect(
        client.comment.findMany({
          where: { commentable: { is: null } },
          select: { id: true },
        })
      ).resolves.toContainEqual({ id: empty.id });
      await expect(
        client.comment.findMany({
          where: { commentable: null },
          select: { id: true },
        })
      ).resolves.toContainEqual({ id: empty.id });
      await expect(
        client.comment.findMany({
          where: { commentable: { isNot: null } },
          select: { id: true },
        })
      ).resolves.toContainEqual({ id: optional.id });

      await client.$executeRaw(
        sql`DELETE FROM ${ident("poly_contract_posts")} WHERE ${ident(
          "id"
        )} = ${optionalTarget.id}`
      );
      await client.$executeRaw(
        sql`DELETE FROM ${ident("poly_contract_videos")} WHERE ${ident(
          "id"
        )} = ${requiredTarget.id}`
      );

      const optionalRead = client.comment.findUniqueOrThrow({
        where: { id: optional.id },
        include: { commentable: true },
      });
      await expect(optionalRead).rejects.toBeInstanceOf(QueryEngineError);
      await expect(optionalRead).rejects.toThrow(
        "Polymorphic relation 'commentable' references a missing 'post' record."
      );
      const requiredRead = client.requiredComment.findUniqueOrThrow({
        where: { id: required.id },
        include: { subject: true },
      });
      await expect(requiredRead).rejects.toBeInstanceOf(QueryEngineError);
      await expect(requiredRead).rejects.toThrow(
        "Polymorphic relation 'subject' references a missing 'video' record."
      );
    });
  });
}

export const polymorphicRelationContract = defineContract({
  id: "drivers.polymorphic-relation",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runPolymorphicRelationBehavior,
});
