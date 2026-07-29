import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError, NotFoundError } from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { DeleteOperation } from "../../src/query-engine-v2/DeleteOperation";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";
import { updateFamilySchema } from "./update-family-behavior";

// ---------------------------------------------------------------------------
// Staleness injection (PLAN P2a instrument 3). The single-threaded dual-run
// oracle cannot observe raceability, so each existing-row premise class gets a
// deterministic before-batch driver hook: it mutates committed state AFTER V2's
// unlocked planning read decides the arm but BEFORE the atomic batch runs. The
// pinned guard must then abort the batch with its typed failure — proving the
// premise is actually pinned inside the atomic unit, not merely observed at
// planning. This is the coverage ATOM §8.1 note (b) said P2a adds.
// ---------------------------------------------------------------------------

/**
 * A batch-only PGlite driver that runs `beforeBatch` between planning and the
 * atomic batch — the deterministic staleness window.
 */
class BeforeBatchPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(
    beforeBatch: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    this.beforeBatch = undefined;
    if (hook) await hook();
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

function makeClient(db: PGlite) {
  return createClient({
    schema: updateFamilySchema,
    driver: new PGliteDriver({ client: db }),
  });
}

/** Run a V2 update in forced-batch mode with a before-batch staleness hook. */
function runUpdate(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
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

function runDelete(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new DeleteOperation(engine, model, args);
  const context = createOperationExecutionContext(
    modelName,
    "delete",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

describe("query-engine-v2 staleness injection (per premise class)", () => {
  test("root-presence premise (update): a concurrent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "s@x", count: 1 } });

    // Planning locates the row; the hook deletes it before the batch runs. The
    // batch-mode root-presence assertion (ATOM §8.1 note (b)) must abort.
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
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "d@x", count: 1 } });

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
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
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
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
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
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
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

describe("query-engine-v2 staleness injection (set orphan pin)", () => {
  test("set departing-rows orphan pin: a concurrently added required-FK child aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeNestedClient(db);
    await push(client, { force: true });
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

describe("query-engine-v2 staleness injection (M2M deleteMany materialized-set pin)", () => {
  test("a concurrently added member aborts the batch typed and raceable, then a rerun converges", async () => {
    const db = new PGlite();
    const client = makeM2mClient(db);
    await push(client, { force: true });
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
    const db = new PGlite();
    const client = makeM2mClient(db);
    await push(client, { force: true });
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

describe("query-engine-v2 staleness injection (M2M adopt premises)", () => {
  test("connectOrCreate found premise: a concurrent delete of the adopted target aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeM2mClient(db);
    await push(client, { force: true });
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
    const db = new PGlite();
    const client = makeM2mClient(db);
    await push(client, { force: true });
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

// ---------------------------------------------------------------------------
// W4-U1 — the EXTENDED unique `where` (Prisma >= 4.5).
//
// Two premises, injected separately, because they are pinned by different
// machinery and must both hold:
//
//  - the FILTER half. Planning locates `K ∧ filters`; the hook makes the filter
//    stop matching. Batch mode addresses the row by the original `where`, so the
//    root-presence guard carries the filter INTO the atomic unit — a stale
//    filter must abort the batch typed, not fall through to an UPDATE that
//    matches zero rows and silently reports success.
//  - the DISCRIMINATOR half. The existing protection (a concurrent delete) must
//    fire exactly as it does for a plain `where` — extending the selector must
//    not have loosened it.
//
// The falsification for the Pin Rule lives with the pins themselves
// (extended-where-unique.test.ts asserts the create-arm racePin is present for a
// plain `where` and withheld for an extended one, and the conformance suite
// proves a filter naming the referenced parent column pins nothing).
// ---------------------------------------------------------------------------

describe("query-engine-v2 staleness injection (extended whereUnique)", () => {
  test("filter premise (update): a stale extra filter aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "f@x", count: 5 } });

    // Planning matches `email = 'f@x' AND count > 0`; the hook drives count to 0
    // before the batch. The row still EXISTS on the discriminator — only the
    // filter went stale — so this is precisely the case a discriminator-only
    // guard would miss.
    const injector = makeClient(db);
    const rejected = await runUpdate(
      db,
      async () => {
        await injector.user.update({
          where: { email: "f@x" },
          data: { count: { set: 0 } },
        });
      },
      "user",
      updateFamilySchema.user,
      {
        where: { email: "f@x", count: { gt: 0 } },
        data: { count: { increment: 10 } },
        select: { email: true, count: true },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NotFoundError);

    // The batch aborted whole: the injector's 0 stands, our +10 never landed.
    await expect(
      client.user.findUnique({
        where: { email: "f@x" },
        select: { count: true },
      })
    ).resolves.toEqual({ count: 0 });
    await client.$disconnect();
  });

  test("filter premise (delete): a stale extra filter aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "fd@x", count: 5 } });

    const injector = makeClient(db);
    const rejected = await runDelete(
      db,
      async () => {
        await injector.user.update({
          where: { email: "fd@x" },
          data: { count: { set: 0 } },
        });
      },
      "user",
      updateFamilySchema.user,
      { where: { email: "fd@x", count: { gt: 0 } }, select: { email: true } }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NotFoundError);

    // The row survives — a stale filter must not delete the row it no longer
    // describes.
    await expect(
      client.user.findUnique({
        where: { email: "fd@x" },
        select: { count: true },
      })
    ).resolves.toEqual({ count: 0 });
    await client.$disconnect();
  });

  test("discriminator premise still fires under an extended where", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "fk@x", count: 5 } });

    const injector = makeClient(db);
    const rejected = await runUpdate(
      db,
      async () => {
        await injector.user.delete({ where: { email: "fk@x" } });
      },
      "user",
      updateFamilySchema.user,
      {
        where: { email: "fk@x", count: { gt: 0 } },
        data: { count: { increment: 1 } },
        select: { email: true, count: true },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(NotFoundError);

    await expect(client.user.findMany()).resolves.toEqual([]);
    await client.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// N1-U1 — the located-parent Ref's race story. The Ref carries a value read at
// planning, OUTSIDE the atomic batch, into a write INSIDE it. The premise it
// depends on is the one the root-presence guard already pins: the located parent
// still exists when the unit runs. These two injections prove that premise is
// enforced for the Ref path specifically — a concurrent delete of the located
// parent aborts the batch typed, with no orphaned child row left behind — and
// that the pin is the EXISTING guard, not a new one (the Ref is dataflow; the
// Pin Rule's race classification is untouched by it).
// ---------------------------------------------------------------------------

describe("query-engine-v2 staleness injection (located-parent Ref)", () => {
  test("nested create by a non-PK unique: a concurrent parent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "ref@x", count: 0 } });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.user.delete({ where: { email: "ref@x" } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "ref@x" },
          data: { posts: { create: { id: 90, title: "raced", slug: "s90" } } },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    // No child rode a foreign key to a parent that no longer exists.
    await expect(client.post.findMany()).resolves.toEqual([]);
    await client.$disconnect();
  });

  test("nested createMany by a non-PK unique: a concurrent parent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "refm@x", count: 0 } });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.user.delete({ where: { email: "refm@x" } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "refm@x" },
          data: {
            posts: {
              createMany: {
                data: [
                  { id: 91, title: "a", slug: "s91" },
                  { id: 92, title: "b", slug: "s92" },
                ],
              },
            },
          },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(client.post.findMany()).resolves.toEqual([]);
    await client.$disconnect();
  });
});
