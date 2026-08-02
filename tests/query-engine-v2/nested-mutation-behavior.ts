import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError } from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

/**
 * The P2c nested-mutation family (nested update/updateMany/delete/deleteMany/set
 * on a child-held-FK to-many relation) exercised on the shared conformance
 * schema. Fixed-expectation behavior across the driver matrix (PLAN "gates name
 * their databases"); the dual-run oracle (nested-mutation.test.ts) proves V1
 * parity on PGlite separately.
 */
export const nestedMutationSchema = nestedWriteBehaviorSchema;

function runner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(nestedMutationSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(nestedMutationSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  // An async wrapper so a construction-time rejection (e.g. a required-FK
  // disconnect) surfaces as a rejected promise, not a synchronous throw.
  return async (
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ) =>
    executor.execute(
      new UpdateOperation(engine, model, args),
      createOperationExecutionContext(
        modelName,
        "update",
        engine.instrumentation
      )
    );
}

export function runNestedMutationBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} nested mutation`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = createClient({
        schema: nestedMutationSchema,
        driver: stateDriver,
      });
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { driver, client, dispose, update: runner(driver) };
    };

    test(
      "delete + deleteMany stay parent-correlated",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.user.create({
            data: {
              id: "u1",
              name: "Hana",
              posts: {
                create: [
                  { id: "po1", title: "Remove one" },
                  { id: "po2", title: "Remove many" },
                ],
              },
            },
          });
          await client.user.create({
            data: {
              id: "u2",
              name: "Ivan",
              posts: { create: { id: "po3", title: "Remove many" } },
            },
          });
          await update("user", nestedMutationSchema.user, {
            where: { id: "u1" },
            data: {
              posts: {
                delete: { id: "po1" },
                deleteMany: { title: "Remove many" },
              },
            },
          });
          expect(
            await client.post.findMany({ orderBy: { id: "asc" } })
          ).toMatchObject([{ id: "po3", title: "Remove many", userId: "u2" }]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "delete of another parent's child rejects, state unchanged",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.user.create({
            data: {
              id: "u1",
              name: "Owner",
              posts: { create: { id: "po1", title: "Owner post" } },
            },
          });
          await client.user.create({
            data: {
              id: "u2",
              name: "Other",
              posts: { create: { id: "po2", title: "Other post" } },
            },
          });
          await expect(
            update("user", nestedMutationSchema.user, {
              where: { id: "u1" },
              data: { posts: { delete: { id: "po2" } } },
            })
          ).rejects.toThrow(
            "Cannot delete relation 'posts': target record was not found for this parent."
          );
          expect(
            await client.post.findMany({ orderBy: { id: "asc" } })
          ).toMatchObject([
            { id: "po1", userId: "u1" },
            { id: "po2", userId: "u2" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "update + updateMany stay parent-correlated",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.user.create({
            data: {
              id: "u1",
              name: "Faye",
              posts: {
                create: [
                  { id: "po1", title: "Draft" },
                  { id: "po2", title: "Queued" },
                ],
              },
            },
          });
          await client.user.create({
            data: {
              id: "u2",
              name: "Gus",
              posts: { create: { id: "po3", title: "Queued" } },
            },
          });
          await update("user", nestedMutationSchema.user, {
            where: { id: "u1" },
            data: {
              posts: {
                update: {
                  where: { id: "po1" },
                  data: { title: "Updated one" },
                },
                updateMany: {
                  where: { title: "Queued" },
                  data: { title: "Updated many" },
                },
              },
            },
          });
          expect(
            await client.post.findMany({ orderBy: { id: "asc" } })
          ).toMatchObject([
            { id: "po1", title: "Updated one", userId: "u1" },
            { id: "po2", title: "Updated many", userId: "u1" },
            { id: "po3", title: "Queued", userId: "u2" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "update to another parent's child rejects",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.user.create({
            data: {
              id: "u1",
              name: "Lina",
              posts: { create: { id: "po1", title: "Owner" } },
            },
          });
          await client.user.create({
            data: {
              id: "u2",
              name: "Milo",
              posts: { create: { id: "po2", title: "Other" } },
            },
          });
          await expect(
            update("user", nestedMutationSchema.user, {
              where: { id: "u1" },
              data: {
                name: "Changed",
                posts: {
                  update: { where: { id: "po2" }, data: { title: "Stolen" } },
                },
              },
            })
          ).rejects.toBeInstanceOf(NestedWriteError);
          expect(
            await client.user.findUnique({ where: { id: "u1" } })
          ).toMatchObject({
            name: "Lina",
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "set (nullable FK) disconnects departing and connects added",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.user.create({
            data: {
              id: "u1",
              name: "Nia",
              posts: {
                create: [
                  { id: "po-kept", title: "Kept" },
                  { id: "po-dropped", title: "Dropped" },
                ],
              },
            },
          });
          await client.post.create({
            data: { id: "po-added", title: "Added", userId: null },
          });
          await update("user", nestedMutationSchema.user, {
            where: { id: "u1" },
            data: { posts: { set: [{ id: "po-kept" }, { id: "po-added" }] } },
          });
          expect(
            await client.post.findMany({ orderBy: { id: "asc" } })
          ).toMatchObject([
            { id: "po-added", userId: "u1" },
            { id: "po-dropped", userId: null },
            { id: "po-kept", userId: "u1" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "set keeping the only required-FK child is a no-op",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.tag.create({ data: { id: "t1", name: "keep" } });
          await client.post.create({
            data: {
              id: "po1",
              title: "Set no-op",
              userId: null,
              postTags: {
                create: { id: "j1", tag: { connect: { id: "t1" } } },
              },
            },
          });
          await update("post", nestedMutationSchema.post, {
            where: { id: "po1" },
            data: { postTags: { set: [{ id: "j1" }] } },
          });
          expect(await client.postTag.findMany()).toMatchObject([
            { id: "j1", postId: "po1", tagId: "t1" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "set orphaning a required-FK child rejects, state unchanged",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.tag.create({ data: { id: "t1", name: "keep" } });
          await client.tag.create({ data: { id: "t2", name: "orphan" } });
          await client.post.create({
            data: {
              id: "po1",
              title: "Set orphan",
              userId: null,
              postTags: {
                create: [
                  { id: "j-keep", tag: { connect: { id: "t1" } } },
                  { id: "j-orphan", tag: { connect: { id: "t2" } } },
                ],
              },
            },
          });
          await expect(
            update("post", nestedMutationSchema.post, {
              where: { id: "po1" },
              data: { title: "Changed", postTags: { set: [{ id: "j-keep" }] } },
            })
          ).rejects.toThrow(
            "Cannot set relation 'postTags' because foreign key field(s) postId are required: rows removed from the set cannot be disconnected. Delete them instead."
          );
          expect(
            await client.post.findUnique({ where: { id: "po1" } })
          ).toMatchObject({
            title: "Set orphan",
          });
          expect(
            await client.postTag.findMany({ orderBy: { id: "asc" } })
          ).toHaveLength(2);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "disconnect of a required-FK child rejects typed",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, update } = await setup();
        try {
          await client.tag.create({ data: { id: "t1", name: "required" } });
          await client.post.create({
            data: {
              id: "po1",
              title: "Required join",
              userId: null,
              postTags: {
                create: { id: "j1", tag: { connect: { id: "t1" } } },
              },
            },
          });
          await expect(
            update("post", nestedMutationSchema.post, {
              where: { id: "po1" },
              data: { postTags: { disconnect: { id: "j1" } } },
            })
          ).rejects.toThrow(
            "Cannot disconnect relation 'postTags' because foreign key field(s) postId are required."
          );
          expect(await client.postTag.findMany()).toMatchObject([
            { id: "j1", postId: "po1" },
          ]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
