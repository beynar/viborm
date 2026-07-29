import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { UpsertOperation } from "../../src/query-engine-v2/UpsertOperation";

/**
 * The P2b upsert-family schema. `user` (auto-increment PK, unique `email`, an
 * ordinary int `score`, child-held-FK to-many `posts`) exercises root upsert by
 * a non-PK unique (create/update/targetWhere/setWhere skip) AND nested
 * `connectOrCreate` under an update. `score` is used rather than `count` to keep
 * V1's own `ON CONFLICT` SQL free of the `count()`-aggregate column ambiguity —
 * the oracle certifies V2 against a working V1 arm.
 */
export const upsertFamilySchema = (() => {
  const user = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      score: s.int(),
      posts: s.oneToMany(() => post),
    })
    .map("upsert_family_users");
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
    .map("upsert_family_posts");
  return { user, post };
})();

hydrateSchemaNames(upsertFamilySchema);

export interface UpsertFamilyRunner {
  readonly executor: OperationExecutor;
  readonly engine: QueryEngine;
  executeUpsert<T = unknown>(
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T>;
  executeUpdate<T = unknown>(
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<T>;
}

export function createUpsertFamilyExecutor(
  driver: AnyDriver
): UpsertFamilyRunner {
  const schemas = createSchemaRegistry(upsertFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(upsertFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return {
    executor,
    engine,
    executeUpsert<T = unknown>(
      modelName: string,
      model: Model<any>,
      args: Record<string, unknown>
    ) {
      const operation = new UpsertOperation(engine, model, args);
      const context = createOperationExecutionContext(
        modelName,
        "upsert",
        engine.instrumentation
      );
      return executor.execute<T>(operation, context);
    },
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
  };
}

/**
 * Fixed-expectation behavior across the whole driver matrix (PLAN "gates name
 * their databases"). Every driver class runs the identical P2b shapes through V2
 * and asserts the same result and post-state; the dual-run oracle
 * (upsert-family.test.ts) proves V1 parity on PGlite separately.
 */
export function runUpsertFamilyBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} upsert family`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = createClient({
        schema: upsertFamilySchema,
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
      "root upsert create branch inserts a new row",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "new@x" },
              create: { email: "new@x", score: 1 },
              update: { score: { increment: 100 } },
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "new@x", score: 1 });
          await expect(
            client.user.findUnique({ where: { email: "new@x" } })
          ).resolves.toMatchObject({ email: "new@x", score: 1 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "root upsert update branch mutates the existing row",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "s@x", score: 10 } });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "s@x" },
              create: { email: "s@x", score: 999 },
              update: { score: { increment: 5 } },
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "s@x", score: 15 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "root upsert targetWhere no-match skips the update (silent no-op)",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "t@x", score: 10 } });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "t@x" },
              targetWhere: { score: 999 },
              create: { email: "t@x", score: 0 },
              update: { score: { increment: 5 } },
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "t@x", score: 10 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "root upsert setWhere no-match skips the update (silent no-op)",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "w@x", score: 10 } });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "w@x" },
              setWhere: { score: 999 },
              create: { email: "w@x", score: 0 },
              update: { score: { increment: 5 } },
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "w@x", score: 10 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "root upsert targetWhere+setWhere match runs the update",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "m@x", score: 10 } });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "m@x" },
              targetWhere: { score: 10 },
              setWhere: { score: 10 },
              create: { email: "m@x", score: 0 },
              update: { score: { increment: 5 } },
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "m@x", score: 15 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "nested connectOrCreate under update connects an existing child",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "coc@x", score: 0 } });
          await client.post.create({
            data: { id: 40, title: "orphan", slug: "s40", userId: null },
          });
          const result = await createUpsertFamilyExecutor(driver).executeUpdate(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "coc@x" },
              data: {
                posts: {
                  connectOrCreate: {
                    where: { id: 40 },
                    create: { id: 40, title: "made", slug: "s40" },
                  },
                },
              },
              select: {
                email: true,
                posts: { select: { id: true, userId: true } },
              },
            }
          );
          expect(result).toEqual({
            email: "coc@x",
            posts: [{ id: 40, userId: 1 }],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "nested connectOrCreate under update creates a missing child",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "coc2@x", score: 0 } });
          const result = await createUpsertFamilyExecutor(driver).executeUpdate(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "coc2@x" },
              data: {
                posts: {
                  connectOrCreate: {
                    where: { id: 41 },
                    create: { id: 41, title: "fresh", slug: "s41" },
                  },
                },
              },
              select: {
                email: true,
                posts: { select: { id: true, userId: true } },
              },
            }
          );
          expect(result).toEqual({
            email: "coc2@x",
            posts: [{ id: 41, userId: 1 }],
          });
        } finally {
          await dispose();
        }
      }
    );

    // N1-U1 — the located-parent Ref reaches the upsert's UPDATE ARM. The arm is an
    // `UpdateOperation` whose locate is the upsert's own superset read, so the same
    // mechanism applies: the `where` names `email`, the child's foreign key needs
    // `id`, and the value comes from the located row. Both arms are witnessed —
    // the update arm because that is where the Ref lives, and the create arm
    // because its parent id is a PRODUCED identity (a fresh auto-increment row),
    // a different provenance that must stay unaffected.
    test(
      "upsert UPDATE arm: a nested create by a non-PK unique rides the located-parent Ref",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          // A decoy seeded FIRST, so it holds the lower generated id.
          await client.user.create({ data: { email: "decoy@x", score: 0 } });
          await client.user.create({ data: { email: "arm@x", score: 5 } });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "arm@x" },
              create: { email: "arm@x", score: 0 },
              update: {
                posts: { create: { id: 50, title: "reffed", slug: "s50" } },
              },
              select: {
                email: true,
                posts: { select: { id: true, userId: true } },
              },
            }
          );
          expect(result).toEqual({
            email: "arm@x",
            posts: [{ id: 50, userId: 2 }],
          });
          await expect(
            client.post.findMany({ where: { userId: 1 } })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "upsert CREATE arm with the same payload still parents the child on the fresh row",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({ data: { email: "decoy@x", score: 0 } });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "absent@x" },
              create: {
                email: "absent@x",
                score: 0,
                posts: { create: { id: 51, title: "fresh", slug: "s51" } },
              },
              update: {
                posts: { create: { id: 52, title: "never", slug: "s52" } },
              },
              select: {
                email: true,
                posts: { select: { id: true, userId: true } },
              },
            }
          );
          expect(result).toEqual({
            email: "absent@x",
            posts: [{ id: 51, userId: 2 }],
          });
          // The untaken update arm wrote nothing.
          await expect(
            client.post.findMany({ where: { id: 52 } })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
