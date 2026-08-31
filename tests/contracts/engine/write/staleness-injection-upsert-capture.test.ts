import { createClient } from "@client/client";
import type { PGlite } from "@electric-sql/pglite";
import {
  NotFoundError,
  TransactionError,
  UniqueConstraintError,
} from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { executeRoutedOperation } from "@src/query-engine/write-engine/routing";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import {
  BeforeBatchPGliteDriver,
  MidBatchPGliteDriver,
  makeClient,
  type RawRunner,
  startsWithUpdate,
} from "@tests/contracts/engine/write/staleness-injection-fixtures";
import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// The TOP-LEVEL upsert's own captured-row story, and the only slice that needs
// the routed once-only retry seam. Both upsert runners live here rather than in
// the shared fixtures because nothing else drives them; the two drivers they
// wrap are the shared ones.
// ---------------------------------------------------------------------------

/** Run a probe-first V2 upsert through the production once-only retry seam. */
function runRoutedUpsert(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new UpsertOperation(engine, updateFamilySchema.user, args);
  const context = createOperationExecutionContext(
    "user",
    "upsert",
    engine.instrumentation
  );
  return executeRoutedOperation(executor, operation, context);
}

/** Run a probe-first V2 upsert with a hook inside its final atomic batch. */
function runUpsertMidBatch(
  db: PGlite,
  hook: (run: RawRunner) => Promise<void>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new MidBatchPGliteDriver(hook, startsWithUpdate, {
    client: db,
  });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new UpsertOperation(engine, updateFamilySchema.user, args);
  const context = createOperationExecutionContext(
    "user",
    "upsert",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

// ---------------------------------------------------------------------------
// Top-level probe-first upsert must keep every found arm bound to the captured
// row. A skip first proves identity and then the conditional no-match; an update
// guards identity and writes that same row. These witnesses deliberately close
// the direct ON CONFLICT door so they reach the locate -> compile seam.
// ---------------------------------------------------------------------------

describe("write engine upsert captured-row staleness", () => {
  test("targetWhere skip rejects a matching replacement without retry", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({
      data: { email: "up-skip-replaced@x", count: 10 },
    });

    const injector = makeClient(db);
    const stale = createClient({
      schema: updateFamilySchema,
      driver: new BeforeBatchPGliteDriver(
        async () => {
          await injector.user.update({
            where: { email: "up-skip-replaced@x" },
            data: { email: "up-skip-moved@x" },
          });
          await injector.user.create({
            data: { email: "up-skip-replaced@x", count: 999 },
          });
        },
        { client: db }
      ),
    });

    const outcome = await stale.user
      .upsert({
        where: { email: "up-skip-replaced@x" },
        targetWhere: { count: 999 },
        create: { email: "up-skip-replaced@x", count: 0 },
        update: { count: 15 },
        select: { email: true, count: true },
      })
      .catch((error) => error);
    const users = await client.user.findMany({ orderBy: { id: "asc" } });
    await client.$disconnect();

    // Planning selected A and chose the skip arm. B satisfies the same public
    // selector and condition, but it is not the row whose skip was compiled.
    expect(outcome).toBeInstanceOf(NotFoundError);
    expect((outcome as NotFoundError).message).toBe(
      "No user record found for upsert"
    );
    expect((outcome as NotFoundError).meta.raceable).not.toBe(true);
    expect(users).toEqual([
      { id: 1, email: "up-skip-moved@x", count: 10 },
      { id: 2, email: "up-skip-replaced@x", count: 999 },
    ]);
  });

  test("targetWhere skip reports deletion as non-raceable not found", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({
      data: { email: "up-skip-deleted@x", count: 10 },
    });

    const injector = makeClient(db);
    const stale = createClient({
      schema: updateFamilySchema,
      driver: new BeforeBatchPGliteDriver(
        async () => {
          await injector.user.delete({
            where: { email: "up-skip-deleted@x" },
          });
        },
        { client: db }
      ),
    });

    const outcome = await stale.user
      .upsert({
        where: { email: "up-skip-deleted@x" },
        targetWhere: { count: 999 },
        create: { email: "up-skip-deleted@x", count: 0 },
        update: { count: 15 },
        select: { email: true, count: true },
      })
      .catch((error) => error);
    const users = await client.user.findMany();
    await client.$disconnect();

    expect(outcome).toBeInstanceOf(NotFoundError);
    expect((outcome as NotFoundError).message).toBe(
      "No user record found for upsert"
    );
    expect((outcome as NotFoundError).meta.raceable).not.toBe(true);
    expect(users).toEqual([]);
  });

  test("targetWhere skip preserves SQL UNKNOWN as a stable no-match", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.post.create({
      data: {
        id: 400,
        title: "unchanged",
        slug: "up-null-skip",
        userId: null,
      },
    });

    const stale = createClient({
      schema: updateFamilySchema,
      driver: new BeforeBatchPGliteDriver(() => Promise.resolve(), {
        client: db,
      }),
    });
    const result = await stale.post.upsert({
      where: { slug: "up-null-skip" },
      targetWhere: { userId: 1 },
      create: {
        id: 400,
        title: "created",
        slug: "up-null-skip",
        userId: null,
      },
      update: { title: "updated" },
      select: { id: true, title: true, userId: true },
    });
    await client.$disconnect();

    expect(result).toEqual({ id: 400, title: "unchanged", userId: null });
  });

  test("no-condition found guard rejects a replacement row without retry", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({
      data: { email: "up-guard@x", count: 0 },
    });

    const injector = makeClient(db);
    const outcome = await runRoutedUpsert(
      db,
      async () => {
        await injector.user.update({
          where: { email: "up-guard@x" },
          data: { email: "up-guard-moved@x" },
        });
        await injector.user.create({
          data: { email: "up-guard@x", count: 0 },
        });
      },
      {
        // The filter closes the direct ON CONFLICT fold while preserving the
        // scalar UPDATE RETURNING arm after planning finds the row.
        where: { email: "up-guard@x", count: 0 },
        create: { email: "up-guard@x", count: 0 },
        update: { count: { increment: 1 } },
        select: { email: true, count: true },
      }
    ).catch((error) => error);
    const raceable =
      outcome instanceof NotFoundError ? outcome.meta.raceable : undefined;
    const users = await client.user.findMany({ orderBy: { id: "asc" } });
    await client.$disconnect();

    // The routed seam is intentional: if this existing-row guard were marked
    // raceable, its one retry would locate user 2 and this call would resolve.
    expect(outcome).toBeInstanceOf(NotFoundError);
    expect((outcome as NotFoundError).message).toBe(
      "No user record found for upsert"
    );
    expect(raceable).not.toBe(true);
    expect(users).toEqual([
      { id: 1, email: "up-guard-moved@x", count: 0 },
      { id: 2, email: "up-guard@x", count: 0 },
    ]);
  });

  test.each([
    "targetWhere",
    "setWhere",
  ] as const)("%s matched guard rejects a matching replacement row without retry", async (conditionalField) => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    const stem = conditionalField === "targetWhere" ? "target" : "set";
    const selectedEmail = `up-${stem}@x`;
    const movedEmail = `up-${stem}-moved@x`;
    await client.user.create({
      data: { email: selectedEmail, count: 10 },
    });

    const injector = makeClient(db);
    const outcome = await runRoutedUpsert(
      db,
      async () => {
        await injector.user.update({
          where: { email: selectedEmail },
          data: { email: movedEmail },
        });
        await injector.user.create({
          data: { email: selectedEmail, count: 10 },
        });
      },
      {
        where: { email: selectedEmail },
        [conditionalField]: { count: 10 },
        create: { email: selectedEmail, count: 0 },
        update: { count: { increment: 1 } },
        select: { email: true, count: true },
      }
    ).catch((error) => error);
    const raceable =
      outcome instanceof TransactionError ? outcome.meta.raceable : undefined;
    const users = await client.user.findMany({ orderBy: { id: "asc" } });
    await client.$disconnect();

    expect(outcome).toBeInstanceOf(TransactionError);
    expect((outcome as TransactionError).message).toBe(
      `query-engine-v2 top-level upsert ${conditionalField} match premise changed before the atomic batch.`
    );
    expect(raceable).not.toBe(true);
    expect(users).toEqual([
      { id: 1, email: movedEmail, count: 10 },
      { id: 2, email: selectedEmail, count: 10 },
    ]);
  });

  test("compiler-backed found guard rejects a replacement before relation writes", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({
      data: { email: "up-compiler@x", count: 0 },
    });

    const injector = makeClient(db);
    const outcome = await runRoutedUpsert(
      db,
      async () => {
        await injector.user.update({
          where: { email: "up-compiler@x" },
          data: { email: "up-compiler-moved@x" },
        });
        await injector.user.create({
          data: { email: "up-compiler@x", count: 0 },
        });
      },
      {
        where: { email: "up-compiler@x" },
        create: { email: "up-compiler@x", count: 0 },
        update: {
          posts: {
            create: {
              id: 401,
              title: "must-not-land",
              slug: "up-compiler-401",
            },
          },
        },
        select: { email: true },
      }
    ).catch((error) => error);
    const raceable =
      outcome instanceof NotFoundError ? outcome.meta.raceable : undefined;
    const users = await client.user.findMany({ orderBy: { id: "asc" } });
    const posts = await client.post.findMany();
    await client.$disconnect();

    expect(outcome).toBeInstanceOf(NotFoundError);
    expect((outcome as NotFoundError).message).toBe(
      "No user record found for upsert"
    );
    expect(raceable).not.toBe(true);
    expect(users).toEqual([
      { id: 1, email: "up-compiler-moved@x", count: 0 },
      { id: 2, email: "up-compiler@x", count: 0 },
    ]);
    expect(posts).toEqual([]);
  });

  test("folded UPDATE RETURNING addresses captured A after the guard", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "up-fold@x", count: 0 } });

    const result = await runUpsertMidBatch(
      db,
      async (run) => {
        await run(
          `UPDATE "update_family_users" SET "email" = 'up-fold-moved@x' WHERE "id" = 1`
        );
        await run(
          `INSERT INTO "update_family_users" ("email", "count") VALUES ('up-fold@x', 0)`
        );
      },
      {
        where: { email: "up-fold@x", count: 0 },
        create: { email: "up-fold@x", count: 0 },
        update: { count: { increment: 1 } },
        select: { email: true, count: true },
      }
    );
    const users = await client.user.findMany({ orderBy: { id: "asc" } });
    await client.$disconnect();

    expect(result).toEqual({ email: "up-fold-moved@x", count: 1 });
    expect(users).toEqual([
      { id: 1, email: "up-fold-moved@x", count: 1 },
      { id: 2, email: "up-fold@x", count: 0 },
    ]);
  });

  test("ordinary UPDATE plus terminal read addresses captured A after the guard", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "up-plain@x", count: 0 } });

    const result = await runUpsertMidBatch(
      db,
      async (run) => {
        await run(
          `UPDATE "update_family_users" SET "email" = 'up-plain-moved@x' WHERE "id" = 1`
        );
        await run(
          `INSERT INTO "update_family_users" ("email", "count") VALUES ('up-plain@x', 0)`
        );
      },
      {
        where: { email: "up-plain@x" },
        create: { email: "up-plain@x", count: 0 },
        update: { count: { increment: 1 } },
        // A relation projection keeps the scalar update arm on the ordinary
        // UPDATE + terminal-read path without adding relation writes.
        select: {
          email: true,
          count: true,
          posts: { select: { id: true } },
        },
      }
    );
    const users = await client.user.findMany({ orderBy: { id: "asc" } });
    await client.$disconnect();

    expect(result).toEqual({
      email: "up-plain-moved@x",
      count: 1,
      posts: [],
    });
    expect(users).toEqual([
      { id: 1, email: "up-plain-moved@x", count: 1 },
      { id: 2, email: "up-plain@x", count: 0 },
    ]);
  });

  test("found-arm unique conflicts stay unpinned and do not retry", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "up-conflict-a@x", count: 0 } });
    await client.user.create({ data: { email: "up-conflict-b@x", count: 0 } });

    const outcome = await runRoutedUpsert(db, () => Promise.resolve(), {
      where: { id: 1, count: 0 },
      create: { email: "up-conflict-new@x", count: 0 },
      update: { email: "up-conflict-b@x" },
      select: { email: true, count: true },
    }).catch((error) => error);
    const users = await client.user.findMany({ orderBy: { id: "asc" } });
    await client.$disconnect();

    expect(outcome).toBeInstanceOf(UniqueConstraintError);
    expect((outcome as UniqueConstraintError).meta.raceable).not.toBe(true);
    expect(users).toEqual([
      { id: 1, email: "up-conflict-a@x", count: 0 },
      { id: 2, email: "up-conflict-b@x", count: 0 },
    ]);
  });
});
