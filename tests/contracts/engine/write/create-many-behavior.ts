import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { CreateManyOperation } from "@src/query-engine/write-engine/CreateManyOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * Root `createMany` (PLAN P2c) across the driver matrix: single-statement where
 * the dialect allows, the multi-statement summed-count plan where row shapes
 * differ, and `skipDuplicates` (a plain SQL leaf on `sql`-strategy dialects, the
 * savepoint-wrapped executor effect on `recoverableUniqueError` dialects).
 */
export const createManySchema = nestedWriteBehaviorSchema;

function runner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(createManySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(createManySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return async (
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ) =>
    executor.execute(
      new CreateManyOperation(engine, model, args),
      createOperationExecutionContext(
        modelName,
        "createMany",
        engine.instrumentation
      )
    );
}

export function runCreateManyBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} createMany`, () => {
    const openDatabase = useBehaviorDatabase(createManySchema, options);
    const setup = async () => {
      const { driver, client, dispose } = await openDatabase();
      return { client, dispose, createMany: runner(driver) };
    };

    test(
      "inserts a batch and returns the count",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, createMany } = await setup();
        try {
          const result = await createMany("tag", createManySchema.tag, {
            data: [
              { id: "t1", name: "a" },
              { id: "t2", name: "b" },
              { id: "t3", name: "c" },
            ],
          });
          expect(result).toEqual({ count: 3 });
          expect(await client.tag.findMany()).toHaveLength(3);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "sums the count across a multi-shape plan",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, createMany } = await setup();
        try {
          // Rows of differing explicit column shape cannot share one VALUES clause,
          // so the plan is several statements whose row counts sum (ATOM §1).
          const result = await createMany("post", createManySchema.post, {
            data: [
              { id: "p1", title: "one" },
              { id: "p2", title: "two", userId: null },
              { id: "p3", title: "three" },
            ],
          });
          expect(result).toEqual({ count: 3 });
          expect(await client.post.findMany()).toHaveLength(3);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "skipDuplicates skips a conflicting row and counts the rest",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, createMany } = await setup();
        try {
          await client.tag.create({ data: { id: "t1", name: "existing" } });
          const result = await createMany("tag", createManySchema.tag, {
            data: [
              { id: "t1", name: "dup" },
              { id: "t2", name: "fresh-b" },
              { id: "t3", name: "fresh-c" },
            ],
            skipDuplicates: true,
          });
          expect(result).toEqual({ count: 2 });
          const tags = await client.tag.findMany({ orderBy: { id: "asc" } });
          expect(tags).toMatchObject([
            { id: "t1", name: "existing" },
            { id: "t2", name: "fresh-b" },
            { id: "t3", name: "fresh-c" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a duplicate without skipDuplicates rolls back the whole batch",
      { timeout: 30_000 },
      async () => {
        const { client, dispose, createMany } = await setup();
        try {
          await expect(
            createMany("tag", createManySchema.tag, {
              data: [
                { id: "d1", name: "first" },
                { id: "d1", name: "second" },
              ],
            })
          ).rejects.toThrow();
          expect(await client.tag.findMany()).toEqual([]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
