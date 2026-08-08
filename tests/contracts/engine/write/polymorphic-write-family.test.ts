import type { BatchQuery, QueryResult } from "@drivers";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { QueryEngineError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { executeRoutedOperation } from "@src/query-engine/write-engine/routing";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
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
      requiredComments: s.oneToMany(() => requiredComment).name("subject"),
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
      code: s.string().unique().nullable(),
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

type PolymorphicWriteFamily = PGliteSchemaFamily<typeof polymorphicWriteSchema>;

interface StoredComment {
  readonly id: number;
  readonly commentable_type: string | null;
  readonly commentable_id: number | null;
}

interface StoredRequiredComment {
  readonly id: number;
  readonly subject_type: string;
  readonly subject_id: number;
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

async function storedRequiredComments(
  family: PolymorphicWriteFamily
): Promise<StoredRequiredComment[]> {
  return family.client.$queryRawUnsafe<StoredRequiredComment>(
    'SELECT "id", "subject_type", "subject_id" FROM "poly_write_required_comments" ORDER BY "id"'
  );
}

function executePostUpdate(
  family: PolymorphicWriteFamily,
  args: Record<string, unknown>
): Promise<unknown> {
  const schemas = createSchemaRegistry(polymorphicWriteSchema);
  const engine = new QueryEngine(
    family.driver,
    createModelRegistry(polymorphicWriteSchema, schemas)
  );
  return executeRoutedOperation(
    new OperationExecutor(engine),
    new UpdateOperation(engine, polymorphicWriteSchema.post, args),
    createOperationExecutionContext("post", "update", engine.instrumentation)
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
    createOperationExecutionContext("comment", "create", engine.instrumentation)
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
    createOperationExecutionContext("comment", "update", engine.instrumentation)
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
  return executeRoutedOperation(
    new OperationExecutor(engine),
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

    test("direct create and update share connect-or-create and fresh-target compilation", async () => {
      const { client } = getFamily();
      const existing = await client.post.create({
        data: { slug: "direct-coc", title: "Existing" },
      });

      const found = await client.comment.create({
        data: {
          body: "found",
          commentable: {
            connectOrCreate: {
              type: "post",
              where: { slug: "direct-coc" },
              create: { slug: "unused", title: "Unused" },
            },
          },
        },
        include: { commentable: true },
      });
      const missing = await client.comment.create({
        data: {
          body: "missing",
          commentable: {
            connectOrCreate: {
              type: "video",
              where: { slug: "direct-coc-video" },
              create: { slug: "direct-coc-video", title: "Created" },
            },
          },
        },
        include: { commentable: true },
      });
      const replaced = await client.comment.update({
        where: { id: found.id },
        data: {
          commentable: {
            create: {
              type: "video",
              data: { slug: "direct-created-update", title: "Created update" },
            },
          },
        },
        include: { commentable: true },
      });

      expect(found.commentable).toMatchObject({
        type: "post",
        data: { id: existing.id },
      });
      expect(missing.commentable).toMatchObject({
        type: "video",
        data: { slug: "direct-coc-video" },
      });
      expect(replaced.commentable).toMatchObject({
        type: "video",
        data: { slug: "direct-created-update" },
      });
    });

    test("direct selected update, delete, and replacing upsert use the current membership", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { slug: "direct-target", title: "Before" },
      });
      const comment = await client.comment.create({
        data: {
          body: "owner",
          commentable: {
            connect: { type: "post", where: { id: post.id } },
          },
        },
      });

      await client.comment.update({
        where: { id: comment.id },
        data: {
          commentable: {
            update: {
              type: "post",
              where: { title: "Before" },
              data: { title: "After" },
            },
          },
        },
      });
      await expect(
        client.post.findUniqueOrThrow({ where: { id: post.id } })
      ).resolves.toMatchObject({ title: "After" });

      await client.comment.update({
        where: { id: comment.id },
        data: {
          commentable: {
            upsert: {
              type: "post",
              create: { slug: "unused-same-type", title: "Unused" },
              update: { title: "Updated by upsert" },
            },
          },
        },
      });
      await expect(
        client.post.findUniqueOrThrow({ where: { id: post.id } })
      ).resolves.toMatchObject({ title: "Updated by upsert" });

      const replaced = await client.comment.update({
        where: { id: comment.id },
        data: {
          commentable: {
            upsert: {
              type: "video",
              create: { slug: "replacement-video", title: "Replacement" },
              update: { title: "Unused" },
            },
          },
        },
        include: { commentable: true },
      });
      expect(replaced.commentable).toMatchObject({
        type: "video",
        data: { slug: "replacement-video" },
      });

      const deleted = await client.comment.update({
        where: { id: comment.id },
        data: { commentable: { delete: { type: "video" } } },
        include: { commentable: true },
      });
      expect(deleted.commentable).toBeNull();
      await expect(
        client.video.findUnique({ where: { slug: "replacement-video" } })
      ).resolves.toBeNull();
    });

    test("selected connect-or-create adopts found targets and creates missing targets", async () => {
      const { client } = getFamily();
      const foundTarget = await client.video.create({
        data: { slug: "update-coc-found", title: "Found" },
      });
      const owner = await client.comment.create({ data: { body: "owner" } });

      const found = await client.comment.update({
        where: { id: owner.id },
        data: {
          commentable: {
            connectOrCreate: {
              type: "video",
              where: { slug: "update-coc-found" },
              create: { slug: "unused-update-coc", title: "Unused" },
            },
          },
        },
        include: { commentable: true },
      });
      expect(found.commentable).toMatchObject({
        type: "video",
        data: { id: foundTarget.id },
      });

      const missing = await client.comment.update({
        where: { id: owner.id },
        data: {
          commentable: {
            connectOrCreate: {
              type: "post",
              where: { slug: "update-coc-missing" },
              create: { slug: "update-coc-missing", title: "Created" },
            },
          },
        },
        include: { commentable: true },
      });
      expect(missing.commentable).toMatchObject({
        type: "post",
        data: { slug: "update-coc-missing" },
      });
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

    test("an ordinary nested selected update keeps polymorphic membership projection", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { slug: "nested-update-target", title: "Before nested update" },
      });
      const board = await client.board.create({
        data: { name: "nested update" },
      });
      const comment = await client.comment.create({
        data: {
          body: "nested owner",
          board: { connect: { id: board.id } },
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });

      await client.board.update({
        where: { id: board.id },
        data: {
          entries: {
            update: {
              where: { id: comment.id },
              data: {
                commentable: {
                  update: {
                    type: "post",
                    data: { title: "After nested update" },
                  },
                },
              },
            },
          },
        },
      });

      await expect(
        client.post.findUniqueOrThrow({ where: { id: post.id } })
      ).resolves.toMatchObject({ title: "After nested update" });
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

    test("root createMany resolves connect-only memberships in grouped variant probes", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { slug: "bulk-post", title: "Bulk post" },
      });
      const video = await client.video.create({
        data: { slug: "bulk-video", title: "Bulk video" },
      });

      await expect(
        client.requiredComment.createMany({
          data: [
            {
              id: 801,
              body: "post one",
              subject: { connect: { type: "post", where: { id: post.id } } },
            },
            {
              id: 802,
              body: "post two",
              subject: {
                connect: { type: "post", where: { slug: "bulk-post" } },
              },
            },
            {
              id: 803,
              body: "video",
              subject: {
                connect: { type: "video", where: { slug: "bulk-video" } },
              },
            },
          ],
        })
      ).resolves.toEqual({ count: 3 });
      expect(await storedRequiredComments(family)).toEqual([
        { id: 801, subject_type: "required.post.v1", subject_id: post.id },
        { id: 802, subject_type: "required.post.v1", subject_id: post.id },
        { id: 803, subject_type: "required.video.v1", subject_id: video.id },
      ]);
    });

    test("root createMany keeps optional omissions and scalar returning", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { slug: "bulk-return-post", title: "Bulk return post" },
      });

      await expect(
        client.comment.createMany({
          data: [
            {
              id: 811,
              body: "linked return",
              commentable: {
                connect: { type: "post", where: { id: post.id } },
              },
            },
            { id: 812, body: "unlinked return" },
          ],
          select: { id: true, body: true },
        })
      ).resolves.toEqual([
        { id: 811, body: "linked return" },
        { id: 812, body: "unlinked return" },
      ]);
      expect(await storedComments(family)).toEqual([
        {
          id: 811,
          commentable_type: "content.post.v1",
          commentable_id: post.id,
        },
        { id: 812, commentable_type: null, commentable_id: null },
      ]);
    });

    test("root createMany fails before inserts when a connected target is missing", async () => {
      const { client } = getFamily();

      await expect(
        client.requiredComment.createMany({
          data: [
            {
              id: 821,
              body: "must not survive",
              subject: {
                connect: { type: "post", where: { slug: "bulk-missing" } },
              },
            },
          ],
          skipDuplicates: true,
        })
      ).rejects.toThrow(
        "Cannot connect relation 'subject': target record was not found."
      );
      await expect(client.requiredComment.findMany()).resolves.toEqual([]);
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

      test("inverse update does not follow a captured member to a replacement row", async () => {
        const family = getFamily();
        const parent = await family.client.post.create({
          data: { id: 640, slug: "replaced-member", title: "Replaced member" },
        });
        const member = await family.client.comment.create({
          data: {
            id: 641,
            body: "captured member",
            commentable: {
              connect: { type: "post", where: { id: parent.id } },
            },
          },
        });

        await expect(
          executePostUpdateAfterPlanning(
            family,
            async () => {
              await family.client.comment.delete({ where: { id: member.id } });
              await family.client.comment.create({
                data: { id: member.id, body: "replacement row" },
              });
            },
            {
              where: { id: parent.id },
              data: {
                comments: {
                  update: {
                    where: { id: member.id },
                    data: { body: "must not follow" },
                  },
                },
              },
            }
          )
        ).rejects.toThrow(
          "Cannot update relation 'comments': target record was not found for this parent."
        );
        await expect(
          family.client.comment.findUniqueOrThrow({ where: { id: member.id } })
        ).resolves.toMatchObject({ body: "replacement row" });
      });

      test("inverse connectOrCreate retries a missing-arm unique race and adopts the winner", async () => {
        const family = getFamily();
        const parent = await family.client.post.create({
          data: { id: 645, slug: "coc-race", title: "Connect or create race" },
        });
        await executePostUpdateAfterPlanning(
          family,
          async () => {
            await family.client.comment.create({
              data: { id: 646, body: "concurrent winner" },
            });
          },
          {
            where: { id: parent.id },
            data: {
              comments: {
                connectOrCreate: {
                  where: { id: 646 },
                  create: { id: 646, body: "must lose the race" },
                },
              },
            },
          }
        );

        await expect(
          family.client.comment.findUniqueOrThrow({
            where: { id: 646 },
            include: { commentable: true },
          })
        ).resolves.toMatchObject({
          body: "concurrent winner",
          commentable: { type: "post", data: { id: parent.id } },
        });
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

    test("inverse createMany applies one storage pair to every inserted row and preserves skip behavior", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { id: 700, slug: "inverse-create-many", title: "Bulk parent" },
      });
      await client.comment.create({
        data: { id: 702, body: "occupied and unlinked" },
      });

      await client.post.update({
        where: { id: post.id },
        data: {
          comments: {
            createMany: {
              data: [
                { id: 701, body: "first bulk child" },
                { id: 702, body: "must be skipped" },
              ],
              skipDuplicates: true,
            },
          },
        },
      });

      expect(await storedComments(family)).toEqual([
        {
          id: 701,
          commentable_type: "content.post.v1",
          commentable_id: post.id,
        },
        { id: 702, commentable_type: null, commentable_id: null },
      ]);
      await expect(
        client.comment.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([
        { id: 701, body: "first bulk child" },
        { id: 702, body: "occupied and unlinked" },
      ]);

      const requiredParent = await client.post.create({
        data: {
          id: 710,
          slug: "required-inverse-create-many",
          title: "Required bulk parent",
          requiredComments: {
            createMany: {
              data: [
                { id: 711, body: "required first" },
                { id: 712, body: "required second" },
              ],
            },
          },
        },
      });
      expect(await storedRequiredComments(family)).toEqual([
        {
          id: 711,
          subject_type: "required.post.v1",
          subject_id: requiredParent.id,
        },
        {
          id: 712,
          subject_type: "required.post.v1",
          subject_id: requiredParent.id,
        },
      ]);
    });

    test("inverse connect adopts globally and optional disconnect clears the exact pair", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { id: 100, slug: "inverse-link", title: "Inverse link" },
      });
      await client.video.create({
        data: { id: post.id, slug: "inverse-link-decoy", title: "Decoy" },
      });
      const free = await client.comment.create({
        data: { id: 101, body: "free target" },
      });
      const decoy = await client.comment.create({
        data: {
          id: 102,
          body: "wrong discriminator",
          commentable: { connect: { type: "video", where: { id: post.id } } },
        },
      });

      await client.post.update({
        where: { id: post.id },
        data: { comments: { connect: { id: free.id } } },
      });
      await expect(
        client.post.findUniqueOrThrow({
          where: { id: post.id },
          include: { comments: { orderBy: { id: "asc" } } },
        })
      ).resolves.toMatchObject({ comments: [{ id: free.id }] });

      await client.post.update({
        where: { id: post.id },
        data: { comments: { disconnect: { id: free.id } } },
      });
      expect(await storedComments(family)).toEqual([
        { id: free.id, commentable_type: null, commentable_id: null },
        {
          id: decoy.id,
          commentable_type: "content.video.v1",
          commentable_id: post.id,
        },
      ]);
    });

    test("required inverse membership refuses disconnect and set before effects", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { id: 120, slug: "required-owner", title: "Required owner" },
      });
      const child = await client.requiredComment.create({
        data: {
          id: 121,
          body: "required child",
          subject: { connect: { type: "post", where: { id: post.id } } },
        },
      });

      await expect(
        Promise.resolve().then(() =>
          executePostUpdate(family, {
            where: { id: post.id },
            data: { requiredComments: { disconnect: { id: child.id } } },
          })
        )
      ).rejects.toThrow();
      await expect(
        Promise.resolve().then(() =>
          executePostUpdate(family, {
            where: { id: post.id },
            data: { requiredComments: { set: [] } },
          })
        )
      ).rejects.toThrow();
      expect(await storedRequiredComments(family)).toEqual([
        {
          id: child.id,
          subject_type: "required.post.v1",
          subject_id: post.id,
        },
      ]);
    });

    test("inverse selected update recurses through the record compiler and refuses wrong-type decoys", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { id: 200, slug: "inverse-update", title: "Inverse update" },
      });
      await client.video.create({
        data: { id: post.id, slug: "inverse-update-decoy", title: "Decoy" },
      });
      const member = await client.comment.create({
        data: {
          id: 201,
          body: "member before",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const decoy = await client.comment.create({
        data: {
          id: 202,
          body: "decoy before",
          commentable: { connect: { type: "video", where: { id: post.id } } },
        },
      });

      await client.post.update({
        where: { id: post.id },
        data: {
          comments: {
            update: {
              where: { id: member.id },
              data: {
                body: "member after",
                board: { create: { name: "compiler recursion" } },
              },
            },
          },
        },
      });
      await expect(
        client.comment.findUniqueOrThrow({
          where: { id: member.id },
          include: { board: true },
        })
      ).resolves.toMatchObject({
        body: "member after",
        board: { name: "compiler recursion" },
      });

      await expect(
        client.post.update({
          where: { id: post.id },
          data: {
            comments: {
              update: {
                where: { id: decoy.id },
                data: { body: "must not change" },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Cannot update relation 'comments': target record was not found for this parent."
      );
      await expect(
        client.comment.findUniqueOrThrow({ where: { id: decoy.id } })
      ).resolves.toMatchObject({ body: "decoy before" });
    });

    test("inverse bulk update and delete always keep the discriminator in membership", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { id: 300, slug: "inverse-bulk", title: "Inverse bulk" },
      });
      await client.video.create({
        data: { id: post.id, slug: "inverse-bulk-decoy", title: "Decoy" },
      });
      await client.comment.create({
        data: {
          id: 301,
          body: "bulk candidate one",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      await client.comment.create({
        data: {
          id: 302,
          body: "bulk candidate two",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const decoy = await client.comment.create({
        data: {
          id: 303,
          body: "bulk candidate decoy",
          commentable: { connect: { type: "video", where: { id: post.id } } },
        },
      });

      await client.post.update({
        where: { id: post.id },
        data: {
          comments: {
            updateMany: {
              where: { body: { contains: "bulk candidate" } },
              data: { body: "bulk updated" },
            },
          },
        },
      });
      await expect(
        client.comment.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([
        { id: 301, body: "bulk updated" },
        { id: 302, body: "bulk updated" },
        { id: decoy.id, body: "bulk candidate decoy" },
      ]);

      await client.post.update({
        where: { id: post.id },
        data: { comments: { deleteMany: { body: "bulk updated" } } },
      });
      await expect(client.comment.findMany()).resolves.toMatchObject([
        { id: decoy.id, body: "bulk candidate decoy" },
      ]);
    });

    test("inverse targeted delete requires the exact membership", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { id: 350, slug: "inverse-delete", title: "Inverse delete" },
      });
      await client.video.create({
        data: { id: post.id, slug: "inverse-delete-decoy", title: "Decoy" },
      });
      const member = await client.comment.create({
        data: {
          id: 351,
          body: "delete member",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const decoy = await client.comment.create({
        data: {
          id: 352,
          body: "keep decoy",
          commentable: { connect: { type: "video", where: { id: post.id } } },
        },
      });

      await expect(
        client.post.update({
          where: { id: post.id },
          data: { comments: { delete: { id: decoy.id } } },
        })
      ).rejects.toThrow(
        "Cannot delete relation 'comments': target record was not found for this parent."
      );
      await client.post.update({
        where: { id: post.id },
        data: { comments: { delete: { id: member.id } } },
      });
      await expect(client.comment.findMany()).resolves.toMatchObject([
        { id: decoy.id, body: "keep decoy" },
      ]);
    });

    test("inverse set adopts, retains, departs, and ignores same-id wrong-type rows", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { id: 400, slug: "inverse-set", title: "Inverse set" },
      });
      const otherPost = await client.post.create({
        data: { id: 401, slug: "inverse-set-other", title: "Other" },
      });
      await client.video.create({
        data: { id: post.id, slug: "inverse-set-decoy", title: "Decoy" },
      });
      const retained = await client.comment.create({
        data: {
          id: 410,
          body: "retained",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const departing = await client.comment.create({
        data: {
          id: 411,
          body: "departing",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const adopted = await client.comment.create({
        data: {
          id: 412,
          body: "adopted",
          commentable: {
            connect: { type: "post", where: { id: otherPost.id } },
          },
        },
      });
      const decoy = await client.comment.create({
        data: {
          id: 413,
          body: "wrong type",
          commentable: { connect: { type: "video", where: { id: post.id } } },
        },
      });

      await client.post.update({
        where: { id: post.id },
        data: {
          comments: { set: [{ id: retained.id }, { id: adopted.id }] },
        },
      });
      expect(await storedComments(family)).toEqual([
        {
          id: retained.id,
          commentable_type: "content.post.v1",
          commentable_id: post.id,
        },
        { id: departing.id, commentable_type: null, commentable_id: null },
        {
          id: adopted.id,
          commentable_type: "content.post.v1",
          commentable_id: post.id,
        },
        {
          id: decoy.id,
          commentable_type: "content.video.v1",
          commentable_id: post.id,
        },
      ]);

      await client.post.update({
        where: { id: post.id },
        data: { comments: { set: [] } },
      });
      expect(await storedComments(family)).toEqual([
        { id: retained.id, commentable_type: null, commentable_id: null },
        { id: departing.id, commentable_type: null, commentable_id: null },
        { id: adopted.id, commentable_type: null, commentable_id: null },
        {
          id: decoy.id,
          commentable_type: "content.video.v1",
          commentable_id: post.id,
        },
      ]);
    });

    test("inverse connectOrCreate adopts existing rows and keeps first-create-wins duplicates", async () => {
      const { client } = getFamily();
      const existing = await client.comment.create({
        data: { id: 501, body: "existing target" },
      });
      const connected = await client.comment.create({
        data: { id: 503, body: "connected target" },
      });

      const post = await client.post.create({
        data: {
          id: 500,
          slug: "inverse-connect-or-create",
          title: "Inverse connect or create",
          comments: {
            connect: { id: connected.id },
            connectOrCreate: [
              {
                where: { id: existing.id },
                create: { id: existing.id, body: "must not create" },
              },
              {
                where: { id: 502 },
                create: { id: 502, body: "first create wins" },
              },
              {
                where: { id: 502 },
                create: { id: 502, body: "must lose" },
              },
            ],
          },
        },
        include: { comments: { orderBy: { id: "asc" } } },
      });

      expect(post.comments).toMatchObject([
        { id: existing.id, body: "existing target" },
        { id: 502, body: "first create wins" },
        { id: connected.id, body: "connected target" },
      ]);
    });

    test("inverse connectOrCreate deduplicates a generated id by its unique selector", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: {
          id: 520,
          slug: "inverse-generated-connect-or-create",
          title: "Generated connect or create",
          comments: {
            connectOrCreate: [
              {
                where: { code: "generated-target" },
                create: {
                  code: "generated-target",
                  body: "first generated create wins",
                },
              },
              {
                where: { code: "generated-target" },
                create: {
                  code: "generated-target",
                  body: "must lose",
                },
              },
            ],
          },
        },
        include: { comments: true },
      });

      expect(post.comments).toHaveLength(1);
      expect(post.comments[0]).toMatchObject({
        code: "generated-target",
        body: "first generated create wins",
      });
      await expect(storedComments(family)).resolves.toEqual([
        {
          id: post.comments[0]?.id,
          commentable_type: "content.post.v1",
          commentable_id: post.id,
        },
      ]);
    });

    test("inverse connectOrCreate deduplicates equal selectors despite different create ids", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: {
          id: 530,
          slug: "inverse-selector-dedup",
          title: "Selector dedup",
          comments: {
            connectOrCreate: [
              {
                where: { code: "same-selector" },
                create: {
                  id: 531,
                  code: "same-selector",
                  body: "first selector create wins",
                },
              },
              {
                where: { code: "same-selector" },
                create: {
                  id: 532,
                  code: "same-selector",
                  body: "must lose",
                },
              },
            ],
          },
        },
        include: { comments: true },
      });

      expect(post.comments).toMatchObject([
        {
          id: 531,
          code: "same-selector",
          body: "first selector create wins",
        },
      ]);
      await expect(
        client.comment.findUnique({ where: { id: 532 } })
      ).resolves.toBeNull();
    });

    test("inverse connectOrCreate does not deduplicate when create misses its selector", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: {
          id: 540,
          slug: "inverse-selector-mismatch",
          title: "Selector mismatch",
          comments: {
            connectOrCreate: [
              {
                where: { code: "wanted-selector" },
                create: {
                  id: 541,
                  code: "different-created-row",
                  body: "first independent create",
                },
              },
              {
                where: { code: "wanted-selector" },
                create: {
                  id: 542,
                  code: "wanted-selector",
                  body: "second create must run",
                },
              },
            ],
          },
        },
        include: { comments: { orderBy: { id: "asc" } } },
      });

      expect(post.comments).toMatchObject([
        {
          id: 541,
          code: "different-created-row",
          body: "first independent create",
        },
        {
          id: 542,
          code: "wanted-selector",
          body: "second create must run",
        },
      ]);
    });

    test("inverse connectOrCreate treats reordered unique fields as one selector", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: {
          id: 550,
          slug: "inverse-reordered-selector",
          title: "Reordered selector",
          comments: {
            connectOrCreate: [
              {
                where: { id: 551, code: "same-row" },
                create: {
                  id: 551,
                  code: "same-row",
                  body: "first create wins",
                },
              },
              {
                where: { code: "same-row", id: 551 },
                create: {
                  id: 551,
                  code: "same-row",
                  body: "must lose",
                },
              },
            ],
          },
        },
        include: { comments: true },
      });

      expect(post.comments).toMatchObject([
        { id: 551, code: "same-row", body: "first create wins" },
      ]);
    });

    test("inverse connectOrCreate analyzes relation work after a selector mismatch", async () => {
      const { client } = getFamily();

      await expect(
        client.post.create({
          data: {
            id: 560,
            slug: "inverse-own-write-selector-mismatch",
            title: "OwnWrite selector mismatch",
            comments: {
              connectOrCreate: [
                {
                  where: { code: "wanted-own-write-selector" },
                  create: {
                    id: 562,
                    code: "different-created-row",
                    body: "first independent create",
                  },
                },
                {
                  where: { code: "wanted-own-write-selector" },
                  create: {
                    id: 563,
                    code: "wanted-own-write-selector",
                    body: "second relation-bearing create",
                    board: {
                      create: {
                        id: 561,
                        name: "nested own-write board",
                        posts: {
                          upsert: {
                            where: { id: 564 },
                            create: {
                              id: 564,
                              slug: "nested-own-write-post",
                              title: "Nested own-write post",
                            },
                            update: { title: "Must not update nested post" },
                          },
                          connectOrCreate: {
                            where: { id: 564 },
                            create: {
                              id: 564,
                              slug: "must-not-create-nested-post",
                              title: "Must not create nested post",
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        })
      ).rejects.toThrow("depends on an earlier 'upsert' target write");

      await expect(
        client.post.findUnique({ where: { id: 560 } })
      ).resolves.toBeNull();
    });

    test("inverse upsert distinguishes member, missing, and foreign memberships", async () => {
      const { client } = getFamily();
      const post = await client.post.create({
        data: { id: 600, slug: "inverse-upsert", title: "Inverse upsert" },
      });
      await client.video.create({
        data: { id: post.id, slug: "inverse-upsert-decoy", title: "Decoy" },
      });
      const member = await client.comment.create({
        data: {
          id: 601,
          body: "member before",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const foreign = await client.comment.create({
        data: {
          id: 603,
          body: "foreign before",
          commentable: { connect: { type: "video", where: { id: post.id } } },
        },
      });

      await client.post.update({
        where: { id: post.id },
        data: {
          comments: {
            upsert: [
              {
                where: { id: member.id },
                create: { id: member.id, body: "must not create" },
                update: { body: "member after" },
              },
              {
                where: { id: 602 },
                create: { id: 602, body: "missing create" },
                update: { body: "must not update" },
              },
            ],
          },
        },
      });
      await expect(
        client.comment.findMany({
          where: { id: { in: [member.id, 602] } },
          orderBy: { id: "asc" },
        })
      ).resolves.toMatchObject([
        { id: member.id, body: "member after" },
        { id: 602, body: "missing create" },
      ]);

      await expect(
        client.post.update({
          where: { id: post.id },
          data: {
            comments: {
              upsert: {
                where: { id: foreign.id },
                create: { id: foreign.id, body: "must not create" },
                update: { body: "must not update" },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Cannot upsert relation 'comments': target record was not found for this parent."
      );
      await expect(
        client.comment.findUniqueOrThrow({ where: { id: foreign.id } })
      ).resolves.toMatchObject({ body: "foreign before" });
    });

    test("fresh-parent inverse upsert globally adopts an existing target", async () => {
      const family = getFamily();
      const { client } = family;
      const target = await client.comment.create({
        data: { id: 651, body: "global before" },
      });

      const post = await client.post.create({
        data: {
          id: 650,
          slug: "fresh-parent-upsert",
          title: "Fresh parent upsert",
          comments: {
            upsert: {
              where: { id: target.id },
              create: { id: target.id, body: "must not create" },
              update: { body: "global after" },
            },
          },
        },
        include: { comments: true },
      });

      expect(post.comments).toMatchObject([
        { id: target.id, body: "global after" },
      ]);
      expect(await storedComments(family)).toEqual([
        {
          id: target.id,
          commentable_type: "content.post.v1",
          commentable_id: post.id,
        },
      ]);
    });

    test("inverse writes read the old parent key and adopt with the transitioned key", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: { id: 800, slug: "transition-owner", title: "Transition" },
      });
      const oldMember = await client.comment.create({
        data: {
          id: 801,
          body: "old membership",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const adopted = await client.comment.create({
        data: { id: 802, body: "adopt after transition" },
      });

      const updated = await client.post.update({
        where: { id: post.id },
        data: {
          id: { increment: 1 },
          comments: {
            connect: { id: adopted.id },
            create: { id: 803, body: "create after transition" },
          },
        },
      });
      expect(updated.id).toBe(801);
      expect(await storedComments(family)).toEqual([
        {
          id: oldMember.id,
          commentable_type: "content.post.v1",
          commentable_id: 800,
        },
        {
          id: adopted.id,
          commentable_type: "content.post.v1",
          commentable_id: 801,
        },
        {
          id: 803,
          commentable_type: "content.post.v1",
          commentable_id: 801,
        },
      ]);
    });

    test("correlated upsert keeps existing membership across a parent key transition", async () => {
      const family = getFamily();
      const { client } = family;
      const post = await client.post.create({
        data: {
          id: 820,
          slug: "transition-upsert-owner",
          title: "Transition upsert",
        },
      });
      const empty = await client.comment.create({
        data: {
          id: 821,
          body: "empty update",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });
      const changed = await client.comment.create({
        data: {
          id: 822,
          body: "before scalar update",
          commentable: { connect: { type: "post", where: { id: post.id } } },
        },
      });

      const updated = await client.post.update({
        where: { id: post.id },
        data: {
          id: { increment: 1 },
          comments: {
            upsert: [
              {
                where: { id: empty.id },
                create: { id: empty.id, body: "must not create" },
                update: {},
              },
              {
                where: { id: changed.id },
                create: { id: changed.id, body: "must not create" },
                update: { body: "after scalar update" },
              },
            ],
          },
        },
      });

      expect(updated.id).toBe(821);
      expect(await storedComments(family)).toEqual([
        {
          id: empty.id,
          commentable_type: "content.post.v1",
          commentable_id: 820,
        },
        {
          id: changed.id,
          commentable_type: "content.post.v1",
          commentable_id: 820,
        },
      ]);
      await expect(
        client.comment.findUniqueOrThrow({ where: { id: changed.id } })
      ).resolves.toMatchObject({ body: "after scalar update" });
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
