import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { OperationExecutor } from "../../src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine/write-engine/UpdateOperation";

/**
 * The depth-gate schema (PLAN P1 gate): a THREE-level chain
 * `user → posts → comments`, each edge a child-held-FK to-many. It exercises the
 * mandated `update > upsert > upsert` depth chain — a middle upsert (posts)
 * located by its PK whose UPDATE arm carries a deeper correlated upsert
 * (comments). Every level has an actual planning read (locate + two probes),
 * unlike `create > create > create`.
 */
export const depthSliceSchema = (() => {
  const user = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      count: s.int(),
      posts: s.oneToMany(() => post),
    })
    .map("depth_slice_users");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      slug: s.string().unique(),
      userId: s.int().nullable(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
      comments: s.oneToMany(() => comment),
    })
    .map("depth_slice_posts");
  const comment = s
    .model({
      id: s.int().id(),
      body: s.string(),
      tag: s.string().unique(),
      postId: s.int().nullable(),
      post: s
        .manyToOne(() => post)
        .fields("postId")
        .references("id")
        .optional(),
    })
    .map("depth_slice_comments");
  return { user, post, comment };
})();

hydrateSchemaNames(depthSliceSchema);

export interface DepthSliceRunner {
  readonly executor: OperationExecutor;
  readonly engine: QueryEngine;
  executeUpdate<T = unknown>(
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T>;
}

export function createDepthSliceExecutor(driver: AnyDriver): DepthSliceRunner {
  const schemas = createSchemaRegistry(depthSliceSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(depthSliceSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return {
    executor,
    engine,
    executeUpdate<T = unknown>(
      model: Model<any>,
      args: Record<string, unknown>
    ) {
      const operation = new UpdateOperation(engine, model, args);
      const context = createOperationExecutionContext(
        "user",
        "update",
        engine.instrumentation
      );
      return executor.execute<T>(operation, context);
    },
  };
}

/**
 * A `update > upsert post > upsert comment` payload. The comment upsert lives in
 * the post's UPDATE arm, so it runs only when the post is found+correlated — the
 * elision-free depth path.
 */
export function depthUpsertArgs(options: {
  email: string;
  postId: number;
  postSlug: string;
  commentId: number;
  commentTag: string;
  commentBody: string;
  increment?: number;
}): Record<string, unknown> {
  return {
    where: { email: options.email },
    data: {
      count: { increment: options.increment ?? 1 },
      posts: {
        upsert: {
          where: { id: options.postId },
          create: {
            id: options.postId,
            title: "created-post",
            slug: options.postSlug,
          },
          update: {
            title: "updated-post",
            comments: {
              upsert: {
                where: { id: options.commentId },
                create: {
                  id: options.commentId,
                  body: options.commentBody,
                  tag: options.commentTag,
                },
                update: { body: options.commentBody },
              },
            },
          },
        },
      },
    },
    select: {
      email: true,
      count: true,
      posts: {
        select: {
          id: true,
          title: true,
          comments: { select: { id: true, body: true, postId: true } },
        },
      },
    },
  };
}
