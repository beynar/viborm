import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";

export const operationFragmentSchema = (() => {
  const user = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("operation_fragment_users");
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
    })
    .map("operation_fragment_posts");
  return { user, post };
})();

hydrateSchemaNames(operationFragmentSchema);

export function createOperationExecutor(driver: AnyDriver): OperationExecutor {
  return new OperationExecutor(createOperationEngine(driver));
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

export function runCreateNestedUpsertBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} operation fragments`, () => {
    test(
      "creates the missing child with the generated parent id",
      { timeout: 30_000 },
      async () => {
        const driver = options.createDriver();
        const stateDriver = options.createStateDriver?.() ?? driver;
        const client = createClient({
          schema: operationFragmentSchema,
          driver: stateDriver,
        });
        try {
          await push(client, { force: true });
          await client.user.create({ data: { name: "existing" } });
          const result = await createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs()
          );

          expect(result).toEqual({
            name: "henry",
            posts: [{ id: 1, title: "post", slug: "post-key", userId: 2 }],
          });
          await expect(
            client.user.findMany({ include: { posts: true } })
          ).resolves.toEqual([
            {
              id: 1,
              name: "existing",
              posts: [],
            },
            {
              id: 2,
              name: "henry",
              posts: [{ id: 1, title: "post", slug: "post-key", userId: 2 }],
            },
          ]);
        } finally {
          await client.$disconnect();
          if (driver !== stateDriver) await driver.disconnect();
        }
      }
    );

    test(
      "updates and reparents the globally matched child",
      { timeout: 30_000 },
      async () => {
        const driver = options.createDriver();
        const stateDriver = options.createStateDriver?.() ?? driver;
        const client = createClient({
          schema: operationFragmentSchema,
          driver: stateDriver,
        });
        try {
          await push(client, { force: true });
          await client.user.create({ data: { name: "existing" } });
          await client.post.create({
            data: {
              id: 1,
              title: "draft",
              slug: "post-key",
              userId: null,
            },
          });

          const result = await createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs("published")
          );

          expect(result).toEqual({
            name: "henry",
            posts: [
              {
                id: 1,
                title: "published",
                slug: "post-key",
                userId: 2,
              },
            ],
          });
          await expect(
            client.post.findUnique({ where: { id: 1 } })
          ).resolves.toEqual({
            id: 1,
            title: "published",
            slug: "post-key",
            userId: 2,
          });
        } finally {
          await client.$disconnect();
          if (driver !== stateDriver) await driver.disconnect();
        }
      }
    );
  });
}
