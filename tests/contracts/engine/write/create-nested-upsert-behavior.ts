import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { getStepModelName } from "@src/query-engine/write-engine/shared";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

export const operationFragmentSchema = (() => {
  const user = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("operation_fragment_users");
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
    .map("operation_fragment_posts");
  return { user, post };
})();

hydrateSchemaNames(operationFragmentSchema);

/**
 * Drives a create through the inverted executor: the concrete operation is
 * constructed here and handed to the generic `execute(operation, context)`. The
 * executor never learns what a create is; wiring an operation to it lives with
 * the caller (the seam the client proxy will own in P1).
 */
export interface CreateOperationRunner {
  readonly executor: OperationExecutor;
  executeCreate<T = unknown>(
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T>;
}

export function createOperationExecutor(
  driver: AnyDriver
): CreateOperationRunner {
  return createOperationRunner(createOperationEngine(driver));
}

export function createOperationRunner(
  engine: QueryEngine
): CreateOperationRunner {
  const executor = new OperationExecutor(engine);
  return {
    executor,
    executeCreate<T = unknown>(
      model: Model<any>,
      args: Record<string, unknown>
    ) {
      const operation = new CreateOperation(engine, model, args);
      const context = createOperationExecutionContext(
        getStepModelName(model, "model"),
        "create",
        engine.instrumentation
      );
      return executor.execute<T>(operation, context);
    },
  };
}

export function createOperationEngine(driver: AnyDriver): QueryEngine {
  const schemas = createSchemaRegistry(operationFragmentSchema);
  return new QueryEngine(
    driver,
    createModelRegistry(operationFragmentSchema, schemas)
  );
}

export function createNestedUpsertArgs(title = "post") {
  return {
    data: {
      name: "henry",
      posts: {
        upsert: {
          where: { id: 1 },
          create: { id: 1, title, slug: "post-key" },
          update: { title },
        },
      },
    },
    select: { name: true, posts: true },
  };
}

export function runCreateNestedUpsertBehavior(
  options: {
    readonly name: string;
  } & BehaviorDatabaseSource
): void {
  describe(`${options.name} operation fragments`, () => {
    const openDatabase = useBehaviorDatabase(operationFragmentSchema, options);
    test(
      "creates the missing child with the generated parent id",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await openDatabase();
        try {
          await client.user.create({ data: { id: -1, name: "existing" } });
          const execution = createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs()
          );

          const result = await execution;

          expect(result).toEqual({
            name: "henry",
            posts: [{ id: 1, title: "post", slug: "post-key", userId: 1 }],
          });
          await expect(
            client.user.findMany({ include: { posts: true } })
          ).resolves.toEqual([
            {
              id: -1,
              name: "existing",
              posts: [],
            },
            {
              id: 1,
              name: "henry",
              posts: [{ id: 1, title: "post", slug: "post-key", userId: 1 }],
            },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "updates and reparents the globally matched child",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await openDatabase();
        try {
          await client.user.create({ data: { id: -1, name: "existing" } });
          await client.post.create({
            data: {
              id: 1,
              title: "draft",
              slug: "post-key",
              userId: null,
            },
          });

          const execution = createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs("published")
          );

          const result = await execution;

          expect(result).toEqual({
            name: "henry",
            posts: [
              {
                id: 1,
                title: "published",
                slug: "post-key",
                userId: 1,
              },
            ],
          });
          await expect(
            client.post.findUnique({ where: { id: 1 } })
          ).resolves.toEqual({
            id: 1,
            title: "published",
            slug: "post-key",
            userId: 1,
          });
        } finally {
          await dispose();
        }
      }
    );
  });
}
