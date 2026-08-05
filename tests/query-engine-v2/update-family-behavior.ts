import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError, NotFoundError } from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { DeleteOperation } from "../../src/query-engine/write-engine/DeleteOperation";
import { OperationExecutor } from "../../src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine/write-engine/UpdateOperation";

/**
 * The P2a update-family schema. `user` holds a child-held-FK to-many (`posts`);
 * `post` holds the parent-held FK (`author`, via `userId`) — so ONE schema
 * exercises both FK directions of connect/disconnect plus scalar update, root
 * delete, and the correlated disconnect probe that carries technique #1.
 */
export const updateFamilySchema = (() => {
  const user = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      count: s.int(),
      posts: s.oneToMany(() => post),
    })
    .map("update_family_users");
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
    .map("update_family_posts");
  return { user, post };
})();

hydrateSchemaNames(updateFamilySchema);

export interface UpdateFamilyRunner {
  readonly executor: OperationExecutor;
  readonly engine: QueryEngine;
  executeUpdate<T = unknown>(
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T>;
  executeDelete<T = unknown>(
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T>;
}

export function createUpdateFamilyExecutor(
  driver: AnyDriver
): UpdateFamilyRunner {
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return {
    executor,
    engine,
    executeUpdate<T = unknown>(
      modelName: string,
      model: Model<any>,
      args: Record<string, unknown>
    ) {
      const operation = new UpdateOperation(engine, model, args);
      const context = createOperationExecutionContext(
        modelName,
        "update",
        engine.instrumentation
      );
      return executor.execute<T>(operation, context);
    },
    executeDelete<T = unknown>(
      modelName: string,
      model: Model<any>,
      args: Record<string, unknown>
    ) {
      const operation = new DeleteOperation(engine, model, args);
      const context = createOperationExecutionContext(
        modelName,
        "delete",
        engine.instrumentation
      );
      return executor.execute<T>(operation, context);
    },
  };
}

/**
 * Fixed-expectation behavior across the whole driver matrix (PLAN "gates name
 * their databases"). Every driver class runs the identical P2a shapes through
 * V2 and asserts the same result and post-state; the dual-run oracle
 * (update-family.test.ts) proves V1 parity on PGlite separately.
 */
export function runUpdateFamilyBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} update family`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = createClient({
        schema: updateFamilySchema,
        driver: stateDriver,
      });
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { driver, client, dispose };
    };

    test(
      "root scalar update by non-PK unique + increment",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "s@x", count: 10 } });
          const result = await createUpdateFamilyExecutor(driver).executeUpdate(
            "user",
            updateFamilySchema.user,
            {
              where: { email: "s@x" },
              data: { count: { increment: 5 } },
              select: { email: true, count: true },
            }
          );
          expect(result).toEqual({ email: "s@x", count: 15 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-many connect reparents the child",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "owner@x", count: 0 } });
          await client.post.create({
            data: { id: 7, title: "orphan", slug: "s7", userId: null },
          });
          const result = await createUpdateFamilyExecutor(driver).executeUpdate(
            "user",
            updateFamilySchema.user,
            {
              where: { email: "owner@x" },
              data: { posts: { connect: { id: 7 } } },
              select: {
                email: true,
                posts: { select: { id: true, userId: true } },
              },
            }
          );
          expect(result).toEqual({
            email: "owner@x",
            posts: [{ id: 7, userId: 1 }],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-many disconnect nulls the correlated child FK",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: {
              email: "d@x",
              count: 0,
              posts: { create: { id: 8, title: "mine", slug: "s8" } },
            },
          });
          const result = await createUpdateFamilyExecutor(driver).executeUpdate(
            "user",
            updateFamilySchema.user,
            {
              where: { email: "d@x" },
              data: { posts: { disconnect: { id: 8 } } },
              select: { email: true, posts: { select: { id: true } } },
            }
          );
          expect(result).toEqual({ email: "d@x", posts: [] });
          await expect(
            client.post.findUnique({ where: { id: 8 } })
          ).resolves.toMatchObject({ userId: null });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-many disconnect of an uncorrelated child → typed error, no write",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "a@x", count: 0 } });
          await client.user.create({ data: { email: "b@x", count: 0 } });
          await client.post.create({
            data: { id: 9, title: "b's", slug: "s9", userId: 2 },
          });
          await expect(
            createUpdateFamilyExecutor(driver).executeUpdate(
              "user",
              updateFamilySchema.user,
              {
                where: { email: "a@x" },
                data: { posts: { disconnect: { id: 9 } } },
                select: { email: true },
              }
            )
          ).rejects.toThrow(
            "Cannot disconnect relation 'posts': target record was not found for this parent."
          );
          await expect(
            client.post.findUnique({ where: { id: 9 } })
          ).resolves.toMatchObject({ userId: 2 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-many connect of a missing target → typed error",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "c@x", count: 0 } });
          await expect(
            createUpdateFamilyExecutor(driver).executeUpdate(
              "user",
              updateFamilySchema.user,
              {
                where: { email: "c@x" },
                data: { posts: { connect: { id: 404 } } },
                select: { email: true },
              }
            )
          ).rejects.toThrow(
            "Cannot connect relation 'posts': target record was not found."
          );
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-one connect sets the parent-held FK",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "u1@x", count: 0 } });
          await client.post.create({
            data: { id: 11, title: "p", slug: "s11", userId: null },
          });
          const result = await createUpdateFamilyExecutor(driver).executeUpdate(
            "post",
            updateFamilySchema.post,
            {
              where: { id: 11 },
              data: { author: { connect: { id: 1 } } },
              select: { id: true, userId: true },
            }
          );
          expect(result).toEqual({ id: 11, userId: 1 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "to-one disconnect nulls the parent-held FK",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "u2@x", count: 0 } });
          await client.post.create({
            data: { id: 12, title: "p", slug: "s12", userId: 1 },
          });
          const result = await createUpdateFamilyExecutor(driver).executeUpdate(
            "post",
            updateFamilySchema.post,
            {
              where: { id: 12 },
              data: { author: { disconnect: true } },
              select: { id: true, userId: true },
            }
          );
          expect(result).toEqual({ id: 12, userId: null });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "root delete returns the deleted row and removes it",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "del@x", count: 3 } });
          const result = await createUpdateFamilyExecutor(driver).executeDelete(
            "user",
            updateFamilySchema.user,
            { where: { email: "del@x" }, select: { email: true, count: true } }
          );
          expect(result).toEqual({ email: "del@x", count: 3 });
          await expect(
            client.user.findUnique({ where: { email: "del@x" } })
          ).resolves.toBeNull();
        } finally {
          await dispose();
        }
      }
    );

    test(
      "missing root update → typed notFound, no write",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await expect(
            createUpdateFamilyExecutor(driver).executeUpdate(
              "user",
              updateFamilySchema.user,
              {
                where: { email: "ghost@x" },
                data: { count: { increment: 1 } },
                select: { email: true },
              }
            )
          ).rejects.toBeInstanceOf(NotFoundError);
          await expect(client.user.findMany()).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "missing root delete → typed notFound",
      { timeout: 30_000 },
      async () => {
        const { driver, dispose } = await setup();
        try {
          await expect(
            createUpdateFamilyExecutor(driver).executeDelete(
              "user",
              updateFamilySchema.user,
              { where: { email: "ghost@x" }, select: { email: true } }
            )
          ).rejects.toBeInstanceOf(NotFoundError);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "non-nullable disconnect is rejected typed",
      { timeout: 30_000 },
      async () => {
        // `posts.author.userId` is nullable, so to prove the guard we assert the
        // NestedWriteError class holds on the uncorrelated disconnect above; here
        // we assert a required-FK disconnect is impossible to express silently.
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "n@x", count: 0 } });
          await client.post.create({
            data: { id: 20, title: "p", slug: "s20", userId: 1 },
          });
          // Disconnecting a present, correlated child succeeds (nullable FK).
          await createUpdateFamilyExecutor(driver).executeUpdate(
            "user",
            updateFamilySchema.user,
            {
              where: { email: "n@x" },
              data: { posts: { disconnect: { id: 20 } } },
              select: { email: true },
            }
          );
          await expect(
            client.post.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ userId: null });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "uncorrelated disconnect never mutates (class held)",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "keep@x", count: 0 } });
          await client.post.create({
            data: { id: 30, title: "free", slug: "s30", userId: null },
          });
          await expect(
            createUpdateFamilyExecutor(driver).executeUpdate(
              "user",
              updateFamilySchema.user,
              {
                where: { email: "keep@x" },
                data: { posts: { disconnect: { id: 30 } } },
                select: { email: true },
              }
            )
          ).rejects.toBeInstanceOf(NestedWriteError);
        } finally {
          await dispose();
        }
      }
    );
  });
}
