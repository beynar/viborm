import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { NestedWriteError, NotFoundError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  BeforeBatchPGliteDriver,
  makeClient,
  runDelete,
  runUpdate,
} from "@tests/contracts/engine/write/staleness-injection-fixtures";
import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import { manyToManySchema } from "@tests/fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// The PREMISE CLASSES themselves: one before-batch injection per class of
// existing-row premise the planner may read outside the atomic unit. P2a's four
// root/relation classes, P2c's `set` departing-rows orphan pin, P3's M2M
// `deleteMany` materialized-set difference, and P4.5's two M2M adopt premises.
// The selector-shaped premises (extended `where`, the located-parent Ref) and
// the root ADDRESS residue are their own slices; the shared drivers and the
// `updateFamilySchema` runners live in `staleness-injection-fixtures.ts`.
// ---------------------------------------------------------------------------

describe("write engine staleness injection (per premise class)", () => {
  test("root-presence premise (update): a concurrent delete aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "s@x", count: 1 } });

    // The hook deletes the row before the batch runs; the batch-mode
    // root-presence assertion (ATOM §8.1 note (b)) must abort.
    //
    // Since PLAN Phase 6.2 this payload is the FOLDED plan on a batch-only
    // driver — `[presence guard, UPDATE … RETURNING]`, no planning read left —
    // so this is also the witness that the fold did not drop the premise. The
    // fold has no JS postcondition to fall back on, so the guard is the only
    // thing between this concurrent delete and a silent zero-row success.
    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.user.delete({ where: { email: "s@x" } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "s@x" },
          data: { count: { increment: 1 } },
          select: { email: true, count: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    // No partial mutation survived.
    await expect(client.user.findMany()).resolves.toEqual([]);
    await client.$disconnect();
  });

  test("root-presence premise (delete): a concurrent delete aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "d@x", count: 1 } });

    // The delete projection of the same PLAN Phase 6.2 fold:
    // `[presence guard, DELETE … RETURNING]`, and the guard is what answers.
    const injector = makeClient(db);
    await expect(
      runDelete(
        db,
        async () => {
          await injector.user.delete({ where: { email: "d@x" } });
        },
        "user",
        updateFamilySchema.user,
        { where: { email: "d@x" }, select: { email: true } }
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    await client.$disconnect();
  });

  test("disconnect-correlation premise: a concurrent reparent aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({
      data: {
        email: "owner@x",
        count: 0,
        posts: { create: { id: 5, title: "mine", slug: "s5" } },
      },
    });
    await client.user.create({ data: { email: "thief@x", count: 0 } });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          // Reparent post 5 away before the disconnect batch runs.
          await injector.post.update({
            where: { id: 5 },
            data: { userId: 2 },
          });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "owner@x" },
          data: { posts: { disconnect: { id: 5 } } },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);

    // Post 5 kept the injected parent — the disconnect never fired.
    await expect(
      client.post.findUnique({ where: { id: 5 } })
    ).resolves.toMatchObject({ userId: 2 });
    await client.$disconnect();
  });

  test("connect-target premise: a concurrent delete aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "c@x", count: 0 } });
    await client.post.create({
      data: { id: 6, title: "orphan", slug: "s6", userId: null },
    });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.post.delete({ where: { id: 6 } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "c@x" },
          data: { posts: { connect: { id: 6 } } },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);
    await client.$disconnect();
  });

  test("upsert found premise: a concurrent delete aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({
      data: {
        email: "up@x",
        count: 0,
        posts: { create: { id: 4, title: "old", slug: "s4" } },
      },
    });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          // Delete the found child before the batch pins & updates it.
          await injector.post.delete({ where: { id: 4 } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "up@x" },
          data: {
            posts: {
              upsert: {
                where: { id: 4 },
                create: { id: 4, title: "made", slug: "s4" },
                update: { title: "fresh" },
              },
            },
          },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);
    await client.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// The P2c new premise class: the `set` departing-rows orphan pin (ATOM §2's
// RETAINED notExists guard, raceable: true). Planning finds no departing child
// (the required-FK set is a no-op); a concurrent write connects a new child to
// the parent BEFORE the batch, so a departing row now exists. The pinned guard
// must abort the batch with the typed orphan failure — proving the retained pin
// is enforced inside the atomic unit, not merely observed at planning.
// ---------------------------------------------------------------------------

function makeNestedClient(db: PGlite) {
  return createClient({
    schema: nestedWriteBehaviorSchema,
    driver: new PGliteDriver({ client: db }),
  });
}

function runNestedUpdate(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(nestedWriteBehaviorSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(nestedWriteBehaviorSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new UpdateOperation(engine, model, args);
  const context = createOperationExecutionContext(
    modelName,
    "update",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

describe("write engine staleness injection (set orphan pin)", () => {
  test("set departing-rows orphan pin: a concurrently added required-FK child aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeNestedClient(db);
    await syncLiveSchema(client);
    await client.tag.create({ data: { id: "t1", name: "one" } });
    await client.tag.create({ data: { id: "t2", name: "two" } });
    await client.post.create({
      data: {
        id: "po1",
        title: "Set no-op",
        userId: null,
        postTags: { create: { id: "j1", tag: { connect: { id: "t1" } } } },
      },
    });

    // Planning sees po1's only child is j1 (in the target set) → the departing
    // set is empty and the retained notExists guard is pinned. The hook connects
    // a NEW child (j2) to po1 before the batch, making it a departing row.
    const injector = makeNestedClient(db);
    await expect(
      runNestedUpdate(
        db,
        async () => {
          await injector.postTag.create({
            data: { id: "j2", postId: "po1", tagId: "t2" },
          });
        },
        "post",
        nestedWriteBehaviorSchema.post,
        {
          where: { id: "po1" },
          data: { postTags: { set: [{ id: "j1" }] } },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);

    // Both children survive; the set never fired.
    await expect(client.postTag.findMany()).resolves.toHaveLength(2);
    await client.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// The P3 premise class: the M2M `deleteMany` materialized-set symmetric-
// difference pin (ATOM §2's RETAINED notExists guards, raceable: true — Pin
// Rule class 3). Planning reads the connected∧filter member set; a concurrent
// connect adds a NEW matching member BEFORE the batch, so the "added" difference
// guard must abort the batch with a typed raceable failure. A plain RERUN then
// converges (it captures the enlarged set and deletes it). Falsify once: with
// the guards removed the stale batch would silently under-delete.
// ---------------------------------------------------------------------------

function makeM2mClient(db: PGlite) {
  return createClient({
    schema: manyToManySchema,
    driver: new PGliteDriver({ client: db }),
  });
}

function runM2mUpdate(
  db: PGlite,
  beforeBatch: (() => Promise<void>) | undefined,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = beforeBatch
    ? new BeforeBatchPGliteDriver(beforeBatch, { client: db })
    : new BeforeBatchPGliteDriver(
        async () => {
          /* no-op hook: forced-batch rerun */
        },
        { client: db }
      );
  const schemas = createSchemaRegistry(manyToManySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(manyToManySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new UpdateOperation(engine, model, args);
  const context = createOperationExecutionContext(
    "post",
    "update",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

describe("write engine staleness injection (M2M deleteMany materialized-set pin)", () => {
  test("a concurrently added member aborts the batch typed and raceable, then a rerun converges", async () => {
    const db = openBorrowedPGlite();
    const client = makeM2mClient(db);
    await syncLiveSchema(client);
    await client.post.create({ data: { id: "p1", title: "Post 1" } });
    await client.tag.create({
      data: { id: "t1", name: "tag-1", featuredPostId: null },
    });
    await client.tag.create({
      data: { id: "t2", name: "tag-2", featuredPostId: null },
    });
    await client.post.update({
      where: { id: "p1" },
      data: { tags: { connect: { id: "t1" } } },
    });

    // Planning captures the connected∧filter set = {t1}. The hook connects t2
    // (also matching the empty filter) before the batch → an "added" difference.
    const injector = makeM2mClient(db);
    const rejected = await runM2mUpdate(
      db,
      async () => {
        await injector.post.update({
          where: { id: "p1" },
          data: { tags: { connect: { id: "t2" } } },
        });
      },
      manyToManySchema.post,
      { where: { id: "p1" }, data: { tags: { deleteMany: {} } } }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NestedWriteError);
    expect((rejected as NestedWriteError).meta.raceable).toBe(true);

    // The batch aborted whole: both members survive (nothing deleted).
    const afterAbort = await client.post.findUnique({
      where: { id: "p1" },
      include: { tags: { orderBy: { id: "asc" } } },
    });
    expect(
      (afterAbort as { tags: { id: string }[] }).tags.map((t) => t.id)
    ).toEqual(["t1", "t2"]);

    // Rerun with no concurrent change: it re-reads the enlarged set and converges.
    await runM2mUpdate(db, undefined, manyToManySchema.post, {
      where: { id: "p1" },
      data: { tags: { deleteMany: {} } },
    });
    const afterRerun = await client.post.findUnique({
      where: { id: "p1" },
      include: { tags: true },
    });
    expect((afterRerun as { tags: unknown[] }).tags).toHaveLength(0);
    expect(await client.tag.findMany()).toHaveLength(0);
    await client.$disconnect();
  });

  test("a concurrently removed member aborts the batch typed and raceable, then a rerun converges", async () => {
    const db = openBorrowedPGlite();
    const client = makeM2mClient(db);
    await syncLiveSchema(client);
    await client.post.create({ data: { id: "p1", title: "Post 1" } });
    await client.tag.create({
      data: { id: "t1", name: "tag-1", featuredPostId: null },
    });
    await client.tag.create({
      data: { id: "t2", name: "tag-2", featuredPostId: null },
    });
    await client.post.update({
      where: { id: "p1" },
      data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
    });

    // Planning captures the connected∧filter set = {t1, t2}. The hook
    // disconnects t2 before the batch → a "removed" difference: deleting the
    // materialized set would now over-delete a child no longer connected.
    const injector = makeM2mClient(db);
    const rejected = await runM2mUpdate(
      db,
      async () => {
        await injector.post.update({
          where: { id: "p1" },
          data: { tags: { disconnect: { id: "t2" } } },
        });
      },
      manyToManySchema.post,
      { where: { id: "p1" }, data: { tags: { deleteMany: {} } } }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NestedWriteError);
    expect((rejected as NestedWriteError).meta.raceable).toBe(true);

    // The batch aborted whole: t1 stays connected, t2 survives disconnected.
    const afterAbort = await client.post.findUnique({
      where: { id: "p1" },
      include: { tags: true },
    });
    expect(
      (afterAbort as { tags: { id: string }[] }).tags.map((t) => t.id)
    ).toEqual(["t1"]);
    expect(await client.tag.findMany()).toHaveLength(2);

    // Rerun with no concurrent change: it re-reads the shrunken set {t1} and
    // converges — t1 deleted, the disconnected t2 untouched.
    await runM2mUpdate(db, undefined, manyToManySchema.post, {
      where: { id: "p1" },
      data: { tags: { deleteMany: {} } },
    });
    const afterRerun = await client.post.findUnique({
      where: { id: "p1" },
      include: { tags: true },
    });
    expect((afterRerun as { tags: unknown[] }).tags).toHaveLength(0);
    expect(
      (await client.tag.findMany()).map((t: { id: string }) => t.id)
    ).toEqual(["t2"]);
    await client.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// The P4.5 M2M adopt-family premises: connectOrCreate's found-target premise and
// upsert's member premise are both existing-row premises (presenceGuard,
// raceable: false — Pin Rule class 1). Planning finds the target present; a
// concurrent delete/disconnect removes it before the batch; the pinned guard must
// abort the atomic unit with V1's typed replacement failure. Falsify once: with
// the guard removed the stale batch would proceed (join a deleted row / update a
// vanished member).
// ---------------------------------------------------------------------------

describe("write engine staleness injection (M2M adopt premises)", () => {
  test("connectOrCreate found premise: a concurrent delete of the adopted target aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeM2mClient(db);
    await syncLiveSchema(client);
    await client.post.create({ data: { id: "p1", title: "Post 1" } });
    await client.tag.create({
      data: { id: "t1", name: "tag-1", featuredPostId: null },
    });

    // Planning's global probe finds t1 → the found (adopt) arm, pinned by the
    // exists guard. The hook deletes t1 before the batch pins & joins it.
    const injector = makeM2mClient(db);
    const rejected = await runM2mUpdate(
      db,
      async () => {
        await injector.tag.delete({ where: { id: "t1" } });
      },
      manyToManySchema.post,
      {
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t1" },
              create: { id: "t1", name: "tag-1" },
            },
          },
        },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NestedWriteError);

    // The batch aborted whole: no join row survives.
    const after = await client.post.findUnique({
      where: { id: "p1" },
      include: { tags: true },
    });
    expect((after as { tags: unknown[] }).tags).toHaveLength(0);
    await client.$disconnect();
  });

  test("upsert member premise: a concurrent disconnect of the member aborts the batch typed", async () => {
    const db = openBorrowedPGlite();
    const client = makeM2mClient(db);
    await syncLiveSchema(client);
    await client.post.create({ data: { id: "p1", title: "Post 1" } });
    await client.tag.create({
      data: { id: "t1", name: "tag-1", featuredPostId: null },
    });
    await client.post.update({
      where: { id: "p1" },
      data: { tags: { connect: { id: "t1" } } },
    });

    // Planning's membership probe finds t1 is a member of p1 → the update arm,
    // pinned by the member exists guard. The hook disconnects t1 before the batch.
    const injector = makeM2mClient(db);
    const rejected = await runM2mUpdate(
      db,
      async () => {
        await injector.post.update({
          where: { id: "p1" },
          data: { tags: { disconnect: { id: "t1" } } },
        });
      },
      manyToManySchema.post,
      {
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t1" },
              create: { id: "t1", name: "tag-1" },
              update: { name: "tag-1-upserted" },
            },
          },
        },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NestedWriteError);

    // The batch aborted whole: t1's name is unchanged (the update never fired).
    const after = await client.tag.findUnique({ where: { id: "t1" } });
    expect((after as { name: string }).name).toBe("tag-1");
    await client.$disconnect();
  });
});
