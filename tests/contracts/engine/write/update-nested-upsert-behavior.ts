import type { AnyDriver } from "@drivers";
import { NestedWriteError, NotFoundError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * The canonical parity slice schema (PLAN P1.1(b)): a parent located by a
 * NON-PK unique (`email`), with an atomic `count`, and a child-held-FK to-many
 * relation whose unique key (`id`) drives the correlated upsert.
 */
export const updateSliceSchema = (() => {
  const user = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      count: s.int(),
      posts: s.toMany(() => post),
    })
    .map("update_slice_users");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      slug: s.string().unique(),
      userId: s.int().nullable(),
      author: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("update_slice_posts");
  return { user, post };
})();

hydrateSchemaNames(updateSliceSchema);

export interface UpdateSliceRunner {
  readonly executor: OperationExecutor;
  executeUpdate<T = unknown>(
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T>;
}

export function createUpdateSliceExecutor(
  driver: AnyDriver
): UpdateSliceRunner {
  const schemas = createSchemaRegistry(updateSliceSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateSliceSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return {
    executor,
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

export function correlatedUpsertArgs(options: {
  email: string;
  childId: number;
  title: string;
  slug: string;
  increment?: number;
}): Record<string, unknown> {
  return {
    where: { email: options.email },
    data: {
      count: { increment: options.increment ?? 1 },
      posts: {
        upsert: {
          where: { id: options.childId },
          create: {
            id: options.childId,
            title: options.title,
            slug: options.slug,
          },
          update: { title: options.title },
        },
      },
    },
    select: {
      email: true,
      count: true,
      posts: { select: { id: true, title: true, slug: true, userId: true } },
    },
  };
}

export function runUpdateNestedUpsertBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} update slice`, () => {
    const setup = useBehaviorDatabase(updateSliceSchema, options);

    test(
      "absent child → create arm, with the located parent id and increment",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: { id: 1, email: "a@x", count: 10 },
          });
          const result = await createUpdateSliceExecutor(driver).executeUpdate(
            updateSliceSchema.user,
            correlatedUpsertArgs({
              email: "a@x",
              childId: 1,
              title: "made",
              slug: "made",
              increment: 3,
            })
          );
          expect(result).toEqual({
            email: "a@x",
            count: 13,
            posts: [{ id: 1, title: "made", slug: "made", userId: 1 }],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "correlated child → update arm updates in place, no reparent",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: {
              id: 1,
              email: "b@x",
              count: 0,
              posts: { create: { id: 5, title: "old", slug: "s5" } },
            },
          });
          const result = await createUpdateSliceExecutor(driver).executeUpdate(
            updateSliceSchema.user,
            correlatedUpsertArgs({
              email: "b@x",
              childId: 5,
              title: "fresh",
              slug: "s5",
              increment: 2,
            })
          );
          expect(result).toEqual({
            email: "b@x",
            count: 2,
            posts: [{ id: 5, title: "fresh", slug: "s5", userId: 1 }],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "found-uncorrelated child → typed V7001, no writes",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: { id: 1, email: "owner@x", count: 0 },
          });
          await client.user.create({
            data: { id: 2, email: "thief@x", count: 0 },
          });
          await client.post.create({
            data: { id: 7, title: "owned", slug: "s7", userId: 1 },
          });
          await expect(
            createUpdateSliceExecutor(driver).executeUpdate(
              updateSliceSchema.user,
              correlatedUpsertArgs({
                email: "thief@x",
                childId: 7,
                title: "stolen",
                slug: "s7",
              })
            )
          ).rejects.toThrow(
            "Cannot upsert relation 'posts': target record was not found for this parent."
          );
          // No partial mutation: thief's count is unchanged, post unmoved.
          await expect(
            client.user.findUnique({ where: { email: "thief@x" } })
          ).resolves.toMatchObject({ count: 0 });
          await expect(
            client.post.findUnique({ where: { id: 7 } })
          ).resolves.toMatchObject({ userId: 1, title: "owned" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "missing root → typed notFound, no writes",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          const execution = createUpdateSliceExecutor(driver).executeUpdate(
            updateSliceSchema.user,
            correlatedUpsertArgs({
              email: "ghost@x",
              childId: 9,
              title: "n",
              slug: "s9",
            })
          );
          await expect(execution).rejects.toBeInstanceOf(NotFoundError);
          await expect(client.user.findMany()).resolves.toEqual([]);
          await expect(client.post.findMany()).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "uncorrelated arm never mutates: NestedWriteError class held",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: { id: 1, email: "u@x", count: 0 },
          });
          await client.post.create({
            data: { id: 3, title: "other", slug: "s3", userId: null },
          });
          await expect(
            createUpdateSliceExecutor(driver).executeUpdate(
              updateSliceSchema.user,
              correlatedUpsertArgs({
                email: "u@x",
                childId: 3,
                title: "x",
                slug: "s3",
              })
            )
          ).rejects.toBeInstanceOf(NestedWriteError);
        } finally {
          await dispose();
        }
      }
    );
  });
}
