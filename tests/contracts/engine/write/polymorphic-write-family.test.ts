import type { BatchQuery, QueryResult } from "@drivers";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { QueryEngineError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
  type PGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const polymorphicWriteSchema = (() => {
  const board = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      entries: s.oneToMany(() => comment).name("boardEntry"),
      posts: s.oneToMany(() => post).name("boardPost"),
    })
    .map("poly_write_boards");

  const post = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
      boardId: s.int().nullable(),
      board: s
        .manyToOne(() => board)
        .fields("boardId")
        .references("id")
        .optional()
        .name("boardPost"),
      comments: s.oneToMany(() => comment).name("commentable"),
    })
    .unique(["slug", "title"])
    .map("poly_write_posts");

  const video = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
    })
    .map("poly_write_videos");

  const comment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      boardId: s.int().nullable(),
      board: s
        .manyToOne(() => board)
        .fields("boardId")
        .references("id")
        .optional()
        .name("boardEntry"),
      commentable: s
        .polymorphic(
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
    .map("poly_write_comments");

  const requiredComment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      subject: s.polymorphic(
        { post: () => post, video: () => video },
        {
          values: {
            post: "required.post.v1",
            video: "required.video.v1",
          },
        }
      ),
    })
    .map("poly_write_required_comments");

  return { board, post, video, comment, requiredComment };
})();

type PolymorphicWriteFamily = PGliteSchemaFamily<
  typeof polymorphicWriteSchema
>;

interface StoredComment {
  readonly id: number;
  readonly commentable_type: string | null;
  readonly commentable_id: number | null;
}

class BeforePolymorphicBatchDriver extends BatchOnlyPGliteDriver {
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(database: PGlite, beforeBatch: () => Promise<void>) {
    super({ client: database });
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    if (hook && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await hook();
    }
    return super.executeBatch<T>(client, queries);
  }
}

async function storedComments(
  family: PolymorphicWriteFamily
): Promise<StoredComment[]> {
  return family.client.$queryRawUnsafe<StoredComment>(
    'SELECT "id", "commentable_type", "commentable_id" FROM "poly_write_comments" ORDER BY "id"'
  );
}

function executeRequiredCommentUpsert(
  family: PolymorphicWriteFamily,
  args: Record<string, unknown>
): Promise<unknown> {
  const schemas = createSchemaRegistry(polymorphicWriteSchema);
  const engine = new QueryEngine(
    family.driver,
    createModelRegistry(polymorphicWriteSchema, schemas)
  );
  return new OperationExecutor(engine).execute(
    new UpsertOperation(engine, polymorphicWriteSchema.requiredComment, args),
    createOperationExecutionContext(
      "requiredComment",
      "upsert",
      engine.instrumentation
    )
  );
}

function executeCommentCreateAfterPlanning(
  family: PolymorphicWriteFamily,
  beforeBatch: () => Promise<void>,
  args: Record<string, unknown>
): Promise<unknown> {
  const schemas = createSchemaRegistry(polymorphicWriteSchema);
  const engine = new QueryEngine(
    new BeforePolymorphicBatchDriver(family.database, beforeBatch),
    createModelRegistry(polymorphicWriteSchema, schemas)
  );
  return new OperationExecutor(engine).execute(
    new CreateOperation(engine, polymorphicWriteSchema.comment, args),
    createOperationExecutionContext(
      "comment",
      "create",
      engine.instrumentation
    )
  );
}

function executeCommentUpdateAfterPlanning(
  family: PolymorphicWriteFamily,
  beforeBatch: () => Promise<void>,
  args: Record<string, unknown>
): Promise<unknown> {
  const schemas = createSchemaRegistry(polymorphicWriteSchema);
  const engine = new QueryEngine(
    new BeforePolymorphicBatchDriver(family.database, beforeBatch),
    createModelRegistry(polymorphicWriteSchema, schemas)
  );
  return new OperationExecutor(engine).execute(
    new UpdateOperation(engine, polymorphicWriteSchema.comment, args),
    createOperationExecutionContext(
      "comment",
      "update",
      engine.instrumentation
    )
  );
}

function executePostUpdateAfterPlanning(
  family: PolymorphicWriteFamily,
  beforeBatch: () => Promise<void>,
  args: Record<string, unknown>
): Promise<unknown> {
  const schemas = createSchemaRegistry(polymorphicWriteSchema);
  const engine = new QueryEngine(
    new BeforePolymorphicBatchDriver(family.database, beforeBatch),
    createModelRegistry(polymorphicWriteSchema, schemas)
  );
  return new OperationExecutor(engine).execute(
    new UpdateOperation(engine, polymorphicWriteSchema.post, args),
    createOperationExecutionContext("post", "update", engine.instrumentation)
  );
}

function registerPolymorphicWriteBehavior(
  name: string,
  mode: "transaction" | "atomicBatch"
): void {
  describe(`polymorphic writes (${name})`, () => {
    const getFamily = usePGliteSchemaFamily(polymorphicWriteSchema, mode);

    test("direct create connects an existing target and creates a fresh target", async () => {
      const { client, ...family } = getFamily();
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
        include: {
          commentable: {
            post: { select: { id: true, title: true } },
            video: { select: { id: true, title: true } },
          },
        },
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

      expect(connected).toMatchObject({
        body: "connected",
        commentable: {
          type: "post",
          data: { id: post.id, title: "Connected post" },
        },
      });
      expect(created).toMatchObject({
        body: "created",
        commentable: {
          type: "video",
          data: { slug: "fresh-video", title: "Fresh video" },
        },
      });
      expect(typeof created.commentable?.data).toBe("object");

      const rows = await storedComments({ client, ...family });
      expect(rows).toEqual([
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
    });

    test("an ordinary nested owner can connect its polymorphic relation", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { slug: "nested-owner-target", title: "Nested owner target" },
      });

      const board = await client.board.create({
        data: {
          name: "ordinary owner",
          entries: {
            create: {
              body: "nested direct owner",
              commentable: {
                connect: {
                  type: "post",
                  where: { slug: "nested-owner-target" },
                },
              },
            },
          },
        },
      });

      await expect(
        client.comment.findMany({
          where: { boardId: board.id },
          include: { commentable: true },
        })
      ).resolves.toMatchObject([
        {
          body: "nested direct owner",
          commentable: { type: "post", data: { id: post.id } },
        },
      ]);
    });

    test("direct connect resolves a compound unique selector to the target id", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { slug: "compound-target", title: "Compound target" },
      });

      const comment = await client.comment.create({
        data: {
          body: "compound connect",
          commentable: {
            connect: {
              type: "post",
              where: {
                slug_title: {
                  slug: "compound-target",
                  title: "Compound target",
                },
              },
            },
          },
        },
        include: { commentable: true },
      });

      expect(comment.commentable).toMatchObject({
        type: "post",
        data: { id: post.id },
      });
    });

    test("a polymorphic target create compiles its ordinary relation subtree", async () => {
      const { client } = getFamily();

      const comment = await client.comment.create({
        data: {
          body: "relation-bearing target",
          commentable: {
            create: {
              type: "post",
              data: {
                slug: "target-with-subtree",
                title: "Target with subtree",
                board: { create: { name: "nested target board" } },
              },
            },
          },
        },
        include: { commentable: true },
      });

      await expect(
        client.post.findUniqueOrThrow({
          where: { slug: "target-with-subtree" },
          include: { board: true },
        })
      ).resolves.toMatchObject({
        id: comment.commentable?.data.id,
        board: { name: "nested target board" },
      });
    });

    test("direct update atomically switches and disconnects the private pair", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { slug: "switch-post", title: "Post" },
      });
      const video = await client.video.create({
        data: { slug: "switch-video", title: "Video" },
      });
      const comment = await client.comment.create({ data: { body: "switch" } });

      const linkedPost = await client.comment.update({
        where: { id: comment.id },
        data: {
          commentable: {
            connect: { type: "post", where: { slug: "switch-post" } },
          },
        },
        include: { commentable: true },
      });
      expect(linkedPost.commentable).toMatchObject({
        type: "post",
        data: { id: post.id },
      });

      const linkedVideo = await client.comment.update({
        where: { id: comment.id },
        data: {
          commentable: {
            connect: { type: "video", where: { slug: "switch-video" } },
          },
        },
        include: { commentable: true },
      });
      expect(linkedVideo.commentable).toMatchObject({
        type: "video",
        data: { id: video.id },
      });

      const disconnected = await client.comment.update({
        where: { id: comment.id },
        data: { commentable: { disconnect: true } },
        include: { commentable: true },
      });
      expect(disconnected.commentable).toBeNull();
      expect(await storedComments(family)).toEqual([
        {
          id: comment.id,
          commentable_type: null,
          commentable_id: null,
        },
      ]);
    });

    test("top-level upsert compiles polymorphic create and update arms", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { slug: "upsert-post", title: "Post" },
      });
      const video = await client.video.create({
        data: { slug: "upsert-video", title: "Video" },
      });

      const inserted = await client.comment.upsert({
        where: { id: 501 },
        create: {
          id: 501,
          body: "inserted",
          commentable: {
            connect: { type: "post", where: { slug: "upsert-post" } },
          },
        },
        update: {
          body: "unexpected update",
          commentable: { disconnect: true },
        },
        include: { commentable: true },
      });
      expect(inserted).toMatchObject({
        id: 501,
        body: "inserted",
        commentable: { type: "post", data: { id: post.id } },
      });

      const updated = await client.comment.upsert({
        where: { id: 501 },
        create: {
          id: 501,
          body: "unexpected create",
          commentable: {
            connect: { type: "post", where: { slug: "upsert-post" } },
          },
        },
        update: {
          body: "updated",
          commentable: {
            connect: { type: "video", where: { slug: "upsert-video" } },
          },
        },
        include: { commentable: true },
      });
      expect(updated).toMatchObject({
        id: 501,
        body: "updated",
        commentable: { type: "video", data: { id: video.id } },
      });
    });

    test("a missing direct connect fails without inserting its owner", async () => {
      const { client } = getFamily();

      await expect(
        client.comment.create({
          data: {
            body: "must not survive",
            commentable: {
              connect: { type: "post", where: { slug: "missing" } },
            },
          },
        })
      ).rejects.toThrow(
        "Cannot connect relation 'commentable': target record was not found."
      );
      expect(await client.comment.findMany()).toEqual([]);
    });

    if (mode === "atomicBatch") {
      test("a direct create does not follow a selector to its replacement row", async () => {
        const family = getFamily();
        const original = await family.client.post.create({
          data: { id: 610, slug: "moving-selector", title: "Original" },
        });
        const replacement = await family.client.post.create({
          data: { id: 611, slug: "replacement", title: "Replacement" },
        });

        await expect(
          executeCommentCreateAfterPlanning(
            family,
            async () => {
              await family.client.post.update({
                where: { id: original.id },
                data: { slug: "moved-away" },
              });
              await family.client.post.update({
                where: { id: replacement.id },
                data: { slug: "moving-selector" },
              });
            },
            {
              data: {
                id: 612,
                body: "must not follow",
                commentable: {
                  connect: {
                    type: "post",
                    where: { slug: "moving-selector" },
                  },
                },
              },
            }
          )
        ).rejects.toThrow(
          "Cannot connect relation 'commentable': target record was not found."
        );
        await expect(
          family.client.comment.findUnique({ where: { id: 612 } })
        ).resolves.toBeNull();
      });

      test("a direct update fails closed when its captured target is deleted", async () => {
        const family = getFamily();
        const target = await family.client.post.create({
          data: { id: 620, slug: "deleted-target", title: "Target" },
        });
        const owner = await family.client.comment.create({
          data: { id: 621, body: "unchanged" },
        });

        await expect(
          executeCommentUpdateAfterPlanning(
            family,
            async () => {
              await family.client.post.delete({ where: { id: target.id } });
            },
            {
              where: { id: owner.id },
              data: {
                commentable: {
                  connect: {
                    type: "post",
                    where: { slug: "deleted-target" },
                  },
                },
              },
            }
          )
        ).rejects.toThrow(
          "Cannot connect relation 'commentable': target record was not found."
        );
        await expect(storedComments(family)).resolves.toEqual([
          {
            id: owner.id,
            commentable_type: null,
            commentable_id: null,
          },
        ]);
      });

      test("inverse create fails closed when its captured parent is deleted", async () => {
        const family = getFamily();
        const parent = await family.client.post.create({
          data: { id: 630, slug: "deleted-parent", title: "Deleted parent" },
        });

        await expect(
          executePostUpdateAfterPlanning(
            family,
            async () => {
              await family.client.post.delete({ where: { id: parent.id } });
            },
            {
              where: { id: parent.id },
              data: {
                comments: { create: { body: "must not survive" } },
              },
            }
          )
        ).rejects.toThrow("No post record found for update");
        await expect(
          family.client.comment.findMany({
            where: { body: "must not survive" },
          })
        ).resolves.toEqual([]);
      });
    }

    test("a failed owner insert rolls back its freshly created polymorphic target", async () => {
      const { client } = getFamily();
      await client.comment.create({ data: { id: 650, body: "occupied" } });

      await expect(
        client.comment.create({
          data: {
            id: 650,
            body: "must roll back",
            commentable: {
              create: {
                type: "video",
                data: { slug: "rolled-back-target", title: "Rolled back" },
              },
            },
          },
        })
      ).rejects.toThrow();
      await expect(
        client.video.findMany({ where: { slug: "rolled-back-target" } })
      ).resolves.toEqual([]);
      await expect(
        client.comment.findUniqueOrThrow({ where: { id: 650 } })
      ).resolves.toMatchObject({ body: "occupied" });
    });

    test("upsert validates a required polymorphic create arm before either branch", async () => {
      const family = getFamily();
      const { client } = family;
      await expect(
        Promise.resolve().then(() =>
          executeRequiredCommentUpsert(family, {
            where: { id: 601 },
            create: { id: 601, body: "missing relation" },
            update: { body: "unused" },
          })
        )
      ).rejects.toThrow(
        "Validation failed for create: Missing required fields: one of subject"
      );
      expect(await client.requiredComment.findMany()).toEqual([]);

      const post = await client.post.create({
        data: { slug: "required-upsert", title: "Required upsert" },
      });
      await client.requiredComment.create({
        data: {
          id: 602,
          body: "existing",
          subject: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      await expect(
        Promise.resolve().then(() =>
          executeRequiredCommentUpsert(family, {
            where: { id: 602 },
            create: { id: 602, body: "still missing relation" },
            update: { body: "must stay unchanged" },
          })
        )
      ).rejects.toThrow(
        "Validation failed for create: Missing required fields: one of subject"
      );
      await expect(
        client.requiredComment.findUniqueOrThrow({ where: { id: 602 } })
      ).resolves.toMatchObject({ body: "existing" });
    });

    test("inverse create consumes a generated parent id", async () => {
      const family = getFamily();
      const created = await family.client.post.create({
        data: {
          slug: "fresh-parent",
          title: "Fresh parent",
          comments: {
            create: [
              { body: "first inverse child" },
              { body: "second inverse child" },
            ],
          },
        },
        include: { comments: { orderBy: { id: "asc" } } },
      });

      expect(created.comments.map(({ body }) => body)).toEqual([
        "first inverse child",
        "second inverse child",
      ]);
      expect(await storedComments(family)).toEqual(
        created.comments.map(({ id }) => ({
          id,
          commentable_type: "content.post.v1",
          commentable_id: created.id,
        }))
      );
    });

    test("inverse create consumes explicit fresh and unchanged located parent ids", async () => {
      const family = getFamily();
      const fresh = await family.client.post.create({
        data: {
          id: 30,
          slug: "explicit-parent",
          title: "Explicit parent",
          comments: { create: { body: "explicit fresh child" } },
        },
        include: { comments: true },
      });
      await family.client.post.create({
        data: { id: 31, slug: "located-parent", title: "Located parent" },
      });
      const located = await family.client.post.update({
        where: { slug: "located-parent" },
        data: { comments: { create: { body: "unchanged located child" } } },
        include: { comments: true },
      });

      expect(await storedComments(family)).toEqual([
        {
          id: fresh.comments[0]?.id,
          commentable_type: "content.post.v1",
          commentable_id: 30,
        },
        {
          id: located.comments[0]?.id,
          commentable_type: "content.post.v1",
          commentable_id: 31,
        },
      ]);
    });

    test("inverse create after a primary-key transition writes the new key", async () => {
      const family = getFamily();
      const { client } = family;
      const parent = await client.post.create({
        data: { id: 20, slug: "moving-parent", title: "Moving parent" },
      });
      await client.video.create({
        data: { id: parent.id, slug: "same-old-id", title: "Wrong type" },
      });

      const updated = await client.post.update({
        where: { slug: "moving-parent" },
        data: {
          id: { increment: 100 },
          comments: { create: { body: "after transition" } },
        },
        include: { comments: true },
      });

      expect(updated.id).toBe(120);
      expect(updated.comments).toHaveLength(1);
      expect(await storedComments(family)).toEqual([
        {
          id: updated.comments[0]?.id,
          commentable_type: "content.post.v1",
          commentable_id: 120,
        },
      ]);
    });

    test("inverse membership correlates on both id and discriminator", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { id: 41, slug: "same-id-post", title: "Post" },
      });
      await client.video.create({
        data: { id: post.id, slug: "same-id-video", title: "Video" },
      });
      const postComment = await client.comment.create({
        data: {
          body: "belongs to post",
          commentable: {
            connect: { type: "post", where: { id: post.id } },
          },
        },
      });
      await client.comment.create({
        data: {
          body: "same id, wrong discriminator",
          commentable: {
            connect: { type: "video", where: { id: post.id } },
          },
        },
      });

      const found = await client.post.findUniqueOrThrow({
        where: { id: post.id },
        include: {
          comments: { select: { id: true, body: true } },
        },
      });
      expect(found.comments).toEqual([
        { id: postComment.id, body: "belongs to post" },
      ]);
      expect(
        await client.post.findMany({
          where: {
            comments: { some: { body: "same id, wrong discriminator" } },
          },
        })
      ).toEqual([]);
    });

    test("database orphans follow optional and required read semantics", async () => {
      const { client } = getFamily();
      const optionalTarget = await client.post.create({
        data: { slug: "optional-orphan", title: "Optional orphan" },
      });
      const requiredTarget = await client.video.create({
        data: { slug: "required-orphan", title: "Required orphan" },
      });
      const optional = await client.comment.create({
        data: {
          body: "optional",
          commentable: {
            connect: { type: "post", where: { id: optionalTarget.id } },
          },
        },
      });
      const required = await client.requiredComment.create({
        data: {
          body: "required",
          subject: {
            connect: { type: "video", where: { id: requiredTarget.id } },
          },
        },
      });

      await client.$executeRawUnsafe(
        'DELETE FROM "poly_write_posts" WHERE "id" = $1',
        optionalTarget.id
      );
      await client.$executeRawUnsafe(
        'DELETE FROM "poly_write_videos" WHERE "id" = $1',
        requiredTarget.id
      );

      await expect(
        client.comment.findUniqueOrThrow({
          where: { id: optional.id },
          include: { commentable: true },
        })
      ).resolves.toMatchObject({ commentable: null });

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

registerPolymorphicWriteBehavior("PGlite transaction", "transaction");
registerPolymorphicWriteBehavior("PGlite atomic batch", "atomicBatch");
