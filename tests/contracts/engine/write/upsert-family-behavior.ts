import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * The P2b upsert-family schema. `user` (auto-increment PK, unique `email`, an
 * ordinary int `score`, child-held-FK to-many `posts`) exercises root upsert by
 * a non-PK unique (create/update/targetWhere/setWhere skip) AND nested
 * `connectOrCreate` under an update. `score` is used rather than `count` to keep
 * V1's own `ON CONFLICT` SQL free of the `count()`-aggregate column ambiguity —
 * the oracle certifies V2 against a working V1 arm.
 *
 * `tagged` adds the one thing `user` and `post` cannot state: a unique selector
 * whose COLUMN name differs from its field name. Every row shape here stays
 * separate from the two models above, so it changes no existing expectation.
 */
export const upsertFamilySchema = (() => {
  const user = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      score: s.int(),
      posts: s.toMany(() => post),
    })
    .map("upsert_family_users");
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
    .map("upsert_family_posts");
  const tagged = s
    .model({
      id: s.string().id().map("tagged_pk"),
      code: s.string().unique().map("tagged_code"),
      note: s.string().nullable(),
    })
    .map("upsert_family_tagged");
  return { user, post, tagged };
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
export function runUpsertFamilyBehavior(
  options: {
    readonly name: string;
  } & BehaviorDatabaseSource
): void {
  describe(`${options.name} upsert family`, () => {
    const setup = useBehaviorDatabase(upsertFamilySchema, options);

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
          await client.user.create({
            data: { id: 1, email: "s@x", score: 10 },
          });
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
          await client.user.create({
            data: { id: 1, email: "t@x", score: 10 },
          });
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
          await client.user.create({
            data: { id: 1, email: "w@x", score: 10 },
          });
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
          await client.user.create({
            data: { id: 1, email: "m@x", score: 10 },
          });
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
          await client.user.create({
            data: { id: 1, email: "coc@x", score: 0 },
          });
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
          await client.user.create({
            data: { id: 1, email: "coc2@x", score: 0 },
          });
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
          // A decoy holds the lower deterministic id.
          await client.user.create({
            data: { id: 1, email: "decoy@x", score: 0 },
          });
          await client.user.create({
            data: { id: 2, email: "arm@x", score: 5 },
          });
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
          await client.user.create({
            data: { id: -1, email: "decoy@x", score: 0 },
          });
          const execution = createUpsertFamilyExecutor(driver).executeUpsert(
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
          const result = await execution;
          expect(result).toEqual({
            email: "absent@x",
            posts: [{ id: 51, userId: 1 }],
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

    // -----------------------------------------------------------------------
    // The ASSIGNMENT-FREE found arm (upstream Prisma 3f1f10fd). `update: {}`
    // asks the found row for nothing, so the arm is a read: the row comes back
    // unchanged while the missing arm still creates (ATOM §20). Each case is a
    // falsifier for that classification: route an empty payload back into the
    // inline `UPDATE` and `buildSet` raises `No fields to update` instead.
    // `isPlainSetUpdate` keeps an empty payload off the `ON CONFLICT` door, so
    // these run probe-first on every dialect, and the atomicBatch leg is the one
    // that exercises the arm's guards.
    // -----------------------------------------------------------------------

    test(
      "an EMPTY update arm returns the found row unchanged and writes nothing",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: { id: 1, email: "noop@x", score: 10 },
          });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "noop@x" },
              create: { email: "noop@x", score: 999 },
              update: {},
            }
          );
          expect(result).toEqual({ id: 1, email: "noop@x", score: 10 });
          await expect(client.user.findMany()).resolves.toEqual([
            { id: 1, email: "noop@x", score: 10 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an EMPTY update arm still CREATES when the row is missing",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "noop-new@x" },
              create: { email: "noop-new@x", score: 3 },
              update: {},
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "noop-new@x", score: 3 });
          await expect(
            client.user.findUnique({ where: { email: "noop-new@x" } })
          ).resolves.toMatchObject({ email: "noop-new@x", score: 3 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the EMPTY found arm honors select and include",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: { id: 1, email: "proj@x", score: 10 },
          });
          await client.post.create({
            data: { id: 80, title: "kept", slug: "s80", userId: 1 },
          });
          const runner = createUpsertFamilyExecutor(driver);
          const args = {
            where: { email: "proj@x" },
            create: { email: "proj@x", score: 999 },
            update: {},
          };
          await expect(
            runner.executeUpsert("user", upsertFamilySchema.user, {
              ...args,
              select: { score: true },
            })
          ).resolves.toEqual({ score: 10 });
          // `include` forces the terminal read path: a relation projection can
          // never ride a folded `UPDATE … RETURNING`.
          await expect(
            runner.executeUpsert("user", upsertFamilySchema.user, {
              ...args,
              include: { posts: { select: { id: true } } },
            })
          ).resolves.toEqual({
            id: 1,
            email: "proj@x",
            score: 10,
            posts: [{ id: 80 }],
          });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the EMPTY found arm locates by a MAPPED unique key",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.tagged.create({
            data: { id: "t1", code: "c1", note: "kept" },
          });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "tagged",
            upsertFamilySchema.tagged,
            {
              where: { code: "c1" },
              create: { id: "t2", code: "c1", note: "created" },
              update: {},
            }
          );
          expect(result).toEqual({ id: "t1", code: "c1", note: "kept" });
          // The create arm never ran: no second row carries its id.
          await expect(
            client.tagged.findUnique({ where: { id: "t2" } })
          ).resolves.toBeNull();
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an EMPTY update arm under a MATCHING conditional still writes nothing",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: { id: 1, email: "cond@x", score: 10 },
          });
          // A matched conditional replaces the found-premise guard with its own
          // in batch mode, so this is a different compiled arm from the case
          // above even though it answers the same row.
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "cond@x" },
              targetWhere: { score: 10 },
              setWhere: { score: 10 },
              create: { email: "cond@x", score: 999 },
              update: {},
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "cond@x", score: 10 });
        } finally {
          await dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // PLAN Decision 7.1 — the ON CONFLICT door.
    //
    // Every case above uses `{ increment }` in its update payload, so none of
    // them folds. These four are the fold's SHAPE, and they run on the whole
    // driver matrix on purpose: PostgreSQL and SQLite answer them through one
    // `INSERT … ON CONFLICT (target) DO UPDATE … RETURNING`, MySQL answers them
    // through the unchanged probe-first sequence, and the ANSWER must be the same
    // either way. The MySQL leg is the one that matters most here — it is the
    // dialect the door is closed to, and closing it must cost nothing but speed.
    // -----------------------------------------------------------------------

    test(
      "7.1 fold shape — the create arm writes the row and answers it",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "door-new@x" },
              create: { email: "door-new@x", score: 4 },
              update: { score: 99 },
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "door-new@x", score: 4 });
          await expect(
            client.user.findUnique({ where: { email: "door-new@x" } })
          ).resolves.toMatchObject({ email: "door-new@x", score: 4 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "7.1 fold shape — the update arm mutates the existing row and answers it",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.user.create({
            data: { id: 1, email: "door@x", score: 10 },
          });
          const result = await createUpsertFamilyExecutor(driver).executeUpsert(
            "user",
            upsertFamilySchema.user,
            {
              where: { email: "door@x" },
              create: { email: "door@x", score: 4 },
              update: { score: 42 },
              select: { email: true, score: true },
            }
          );
          expect(result).toEqual({ email: "door@x", score: 42 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "7.1 fold shape — running it twice converges (create then update)",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          const runner = createUpsertFamilyExecutor(driver);
          const args = {
            where: { email: "twice@x" },
            create: { email: "twice@x", score: 1 },
            update: { score: 2 },
            select: { email: true, score: true },
          };
          expect(
            await runner.executeUpsert("user", upsertFamilySchema.user, args)
          ).toEqual({ email: "twice@x", score: 1 });
          expect(
            await runner.executeUpsert("user", upsertFamilySchema.user, args)
          ).toEqual({ email: "twice@x", score: 2 });
          // Exactly one row: the second pass adopted, it did not insert.
          await expect(
            client.user.count({ where: { email: "twice@x" } })
          ).resolves.toBe(1);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "7.1 fold shape — an UNRELATED unique collision is a constraint error on every dialect",
      { timeout: 30_000 },
      async () => {
        const { driver, client, dispose } = await setup();
        try {
          await client.post.create({
            data: { id: 70, title: "sitting", slug: "taken" },
          });
          // `where` names an absent post, so the create arm is taken — but the
          // create data's `slug` belongs to post 70. This is the observable the
          // plan singled out as the reason MySQL cannot come through the door:
          // `ON DUPLICATE KEY UPDATE` would ADOPT post 70 instead of refusing.
          // PostgreSQL and SQLite arbitrate on the named target and raise the
          // non-arbiter index's own violation; MySQL never folds and its probe
          // path raises the same class. Every dialect must refuse, and post 70
          // must be untouched.
          await expect(
            createUpsertFamilyExecutor(driver).executeUpsert(
              "post",
              upsertFamilySchema.post,
              {
                where: { id: 71 },
                create: { id: 71, title: "intruder", slug: "taken" },
                update: { title: "adopted" },
              }
            )
          ).rejects.toMatchObject({ code: "V3001" });
          await expect(
            client.post.findUnique({ where: { id: 70 } })
          ).resolves.toMatchObject({ id: 70, title: "sitting" });
          await expect(
            client.post.findUnique({ where: { id: 71 } })
          ).resolves.toBeNull();
        } finally {
          await dispose();
        }
      }
    );
  });
}
