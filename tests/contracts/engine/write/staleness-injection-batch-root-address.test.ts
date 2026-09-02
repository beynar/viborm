import { NotFoundError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  MidBatchPGliteDriver,
  makeClient,
  type RawRunner,
  runUpdate,
  type StalenessTarget,
  startsWithUpdate,
} from "@tests/contracts/engine/write/staleness-injection-fixtures";
import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// A private schema on the worker's shared database per schema this slice binds.
// The family syncs its tables and empties them — identities restarted — between
// tests, which is what a fresh database per test did.
const getFamily = usePGliteSchemaFamily(updateFamilySchema);

// ---------------------------------------------------------------------------
// N1 residue — the BATCH root address. Every child edge of a located-parent
// update addresses the CAPTURED row (the Ref the locate produced). Batch mode
// used to leave the root's own two statements addressing the caller's SELECTOR
// instead: the presence guard re-ran `findUnique(where)` and the root UPDATE
// carried the same `where`. A discriminator is REASSIGNABLE — rename the located
// row and re-insert the freed value on another row and the selector names a
// DIFFERENT row than the one the children attach to. The guard passed on the
// replacement, the UPDATE mutated the replacement, the children rode the capture:
// two rows, one operation (the terminal read, which already addressed the
// captured PK, then reported the row that was NOT mutated).
//
// Both halves are pinned, and each is falsified at its own injection point,
// because they answer different questions at different instants:
//
//  - the GUARD is the batch's abort mechanism. It asserts `selector ∧ captured
//    PK` — the split-witness the nested targeted-mutation guards already use —
//    so a reassigned discriminator finds no row and the unit aborts typed.
//    Falsified BEFORE the batch (`BeforeBatchPGliteDriver`): reinstate the
//    selector-only guard and the abort never happens.
//  - the WRITE's WHERE is the row ADDRESS. It names the captured PK, the row the
//    locate acted on (the wrong-row doctrine), which is what the children and the
//    terminal read already name. Falsified INSIDE the batch
//    (`MidBatchPGliteDriver`): a batch is atomic, not serializable, so the row
//    can be reassigned in the guard→UPDATE window; reinstate the selector-only
//    address and the UPDATE walks off onto the replacement row while the guard,
//    the children and the terminal all stay on the captured one.
// ---------------------------------------------------------------------------

/**
 * A root whose primary key also sits inside a COMPOUND unique. Selecting by that
 * compound names every PK column while smuggling a reassignable one alongside it,
 * with NO filter half — the second spelling of the root-address hazard, and the one
 * an extended-`where` check alone cannot see.
 */
const compoundRootSchema = (() => {
  const user = s
    .model({
      id: s.int().id(),
      email: s.string().unique(),
      count: s.int(),
      posts: s.toMany(() => post),
    })
    .unique(["id", "count"])
    .map("cmp_root_users");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string(),
      userId: s.int().nullable(),
      author: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("cmp_root_posts");
  return { user, post };
})();

hydrateSchemaNames(compoundRootSchema);

const getCompoundFamily = usePGliteSchemaFamily(compoundRootSchema);

/** {@link runUpdateMidBatch} against {@link compoundRootSchema}. */
function runCompoundUpdateMidBatch(
  target: StalenessTarget,
  hook: (run: RawRunner) => Promise<void>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new MidBatchPGliteDriver(hook, startsWithUpdate, {
    client: target.database,
    namespace: target.namespace,
  });
  const schemas = createSchemaRegistry(compoundRootSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(compoundRootSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new UpdateOperation(engine, compoundRootSchema.user, args);
  const context = createOperationExecutionContext(
    "user",
    "update",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

/** Run a V2 update in forced-batch mode with a hook wedged inside the batch. */
function runUpdateMidBatch(
  target: StalenessTarget,
  hook: (run: RawRunner) => Promise<void>,
  runBefore: (sql: string) => boolean,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new MidBatchPGliteDriver(hook, runBefore, {
    client: target.database,
    namespace: target.namespace,
  });
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

describe("write engine staleness injection (batch root address)", () => {
  test("guard half: a reassigned discriminator aborts the batch, writing neither row", async () => {
    const family = getFamily();
    const client = makeClient(family);
    await client.user.create({ data: { email: "split@x", count: 0 } });

    // Planning locates user 1 by its email and captures its id for the child FK.
    // The hook then RENAMES user 1 and re-plants `split@x` on a brand-new user 2:
    // the selector still matches a row, so a selector-only presence guard sees
    // nothing wrong — but it is no longer the row the children were built for.
    const injector = makeClient(family);
    await expect(
      runUpdate(
        family,
        async () => {
          await injector.user.update({
            where: { email: "split@x" },
            data: { email: "moved@x" },
          });
          await injector.user.create({
            data: { email: "split@x", count: 100 },
          });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "split@x" },
          data: {
            count: { increment: 1 },
            posts: { create: { id: 70, title: "split", slug: "s70" } },
          },
          select: { email: true, count: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    // Neither row moved: not the located one (count still 0), not the row that
    // took its discriminator (count still 100), and no child was planted.
    await expect(
      client.user.findMany({ orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: 1, email: "moved@x", count: 0 },
      { id: 2, email: "split@x", count: 100 },
    ]);
    await expect(client.post.findMany()).resolves.toEqual([]);
  });

  test("write half: the root UPDATE addresses the captured row, not the one that took the discriminator", async () => {
    const family = getFamily();
    const client = makeClient(family);
    await client.user.create({ data: { email: "mid@x", count: 0 } });

    // The reassignment lands AFTER the presence guard has passed and BEFORE the
    // root UPDATE runs. The guard cannot answer for this window; only the UPDATE's
    // own address can. It must stay on the captured id — the row the child INSERT
    // and the terminal read both name — never follow the selector onto user 2.
    const result = await runUpdateMidBatch(
      family,
      async (run) => {
        // Verbatim SQL is not qualified by the driver's namespace, so these
        // planted statements must name the suite's schema themselves.
        await run(
          `UPDATE "${family.namespace}"."update_family_users" SET "email" = 'gone@x' WHERE "id" = 1`
        );
        await run(
          `INSERT INTO "${family.namespace}"."update_family_users" ("email", "count") VALUES ('mid@x', 100)`
        );
      },
      startsWithUpdate,
      "user",
      updateFamilySchema.user,
      {
        where: { email: "mid@x" },
        data: {
          count: { increment: 1 },
          posts: { create: { id: 71, title: "mid", slug: "s71" } },
        },
        select: { email: true, count: true },
      }
    );

    // The operation reports the row it mutated, and that row is the located one.
    expect(result).toEqual({ email: "gone@x", count: 1 });
    await expect(
      client.user.findMany({ orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: 1, email: "gone@x", count: 1 },
      { id: 2, email: "mid@x", count: 100 },
    ]);
    // The child rode the same row the UPDATE did — the split the address closes.
    await expect(client.post.findMany()).resolves.toEqual([
      { id: 71, title: "mid", slug: "s71", userId: 1 },
    ]);
  });

  test("control: with no interference the located-parent batch is unchanged", async () => {
    const family = getFamily();
    const client = makeClient(family);
    await client.user.create({ data: { email: "calm@x", count: 0 } });

    const result = await runUpdate(
      family,
      // The staleness hook is the harness's, not the scenario's: nothing moves.
      () => Promise.resolve(),
      "user",
      updateFamilySchema.user,
      {
        where: { email: "calm@x" },
        data: {
          count: { increment: 1 },
          posts: { create: { id: 72, title: "calm", slug: "s72" } },
        },
        select: { email: true, count: true },
      }
    );

    expect(result).toEqual({ email: "calm@x", count: 1 });
    await expect(client.post.findMany()).resolves.toEqual([
      { id: 72, title: "calm", slug: "s72", userId: 1 },
    ]);
  });

  // A `where` whose DISCRIMINATOR names the PK is still not, on its own, an
  // immutable address: an extended `where` (Prisma >= 4.5) carries a FILTER half
  // too, and a filter is an ordinary reassignable column. The PK pins WHICH row
  // the UPDATE can touch, so this is never the wrong row — but re-consulting the
  // filter at the UPDATE's instant can make it touch NO row, and batch mode
  // lowers no `affectedRows` postcondition. That is the silent zero-row root the
  // address rule exists to forbid, reached through the PK-named door.
  test("write half: an extended selector's filter does not ride into the root UPDATE", async () => {
    const family = getFamily();
    const client = makeClient(family);
    await client.user.create({ data: { email: "ext@x", count: 0 } });

    // The guard has already asserted `id = 1 AND count = 0` inside the unit. The
    // hook then moves `count` off 0 in the guard→UPDATE window. The UPDATE must
    // still address the row the locate acted on.
    const result = await runUpdateMidBatch(
      family,
      async (run) => {
        // Verbatim SQL is not qualified by the driver's namespace.
        await run(
          `UPDATE "${family.namespace}"."update_family_users" SET "count" = 5 WHERE "id" = 1`
        );
      },
      startsWithUpdate,
      "user",
      updateFamilySchema.user,
      {
        where: { id: 1, count: 0 },
        data: {
          count: { increment: 1 },
          posts: { create: { id: 73, title: "ext", slug: "s73" } },
        },
        select: { email: true, count: true },
      }
    );

    // One row, incremented off the value the interference left. A selector-copy
    // in the UPDATE's WHERE returns `count: 5` here — the root silently skipped
    // while the child still landed.
    expect(result).toEqual({ email: "ext@x", count: 6 });
    await expect(client.post.findMany()).resolves.toEqual([
      { id: 73, title: "ext", slug: "s73", userId: 1 },
    ]);
  });

  test("control: an extended selector whose filter excludes the row fails closed", async () => {
    const family = getFamily();
    const client = makeClient(family);
    await client.user.create({ data: { email: "excl@x", count: 9 } });

    await expect(
      runUpdate(
        family,
        () => Promise.resolve(),
        "user",
        updateFamilySchema.user,
        {
          where: { id: 1, count: 0 },
          data: {
            count: { increment: 1 },
            posts: { create: { id: 74, title: "excl", slug: "s74" } },
          },
          select: { email: true, count: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(client.user.findMany()).resolves.toEqual([
      { id: 1, email: "excl@x", count: 9 },
    ]);
    await expect(client.post.findMany()).resolves.toEqual([]);
  });

  test("control: an extended selector with no interference runs once", async () => {
    const family = getFamily();
    const client = makeClient(family);
    await client.user.create({ data: { email: "ok@x", count: 0 } });

    const result = await runUpdate(
      family,
      () => Promise.resolve(),
      "user",
      updateFamilySchema.user,
      {
        where: { id: 1, count: 0 },
        data: {
          count: { increment: 1 },
          posts: { create: { id: 75, title: "ok", slug: "s75" } },
        },
        select: { email: true, count: true },
      }
    );

    expect(result).toEqual({ email: "ok@x", count: 1 });
    await expect(client.post.findMany()).resolves.toEqual([
      { id: 75, title: "ok", slug: "s75", userId: 1 },
    ]);
  });

  // The SECOND spelling of the same hazard, and the one that stays hidden if you look
  // only for a filter half. A compound unique that CONTAINS the primary key is wholly a
  // discriminator — there is no filter half at all — and `getWhereUniqueEntries`
  // flattens it, so every PK column is named. The extra member would ride into the root
  // UPDATE's WHERE exactly as an extended filter would, and it is just as reassignable.
  // Both spellings are why the address rule has no arms: the root UPDATE addresses the
  // captured PK whatever the selector named, so neither spelling has a door to enter by.
  test("write half: a compound unique's non-PK member does not ride into the root UPDATE", async () => {
    const family = getCompoundFamily();
    const client = family.client;
    await client.user.create({ data: { id: 1, email: "cmp@x", count: 0 } });

    const result = await runCompoundUpdateMidBatch(
      family,
      async (run) => {
        // Verbatim SQL is not qualified by the driver's namespace.
        await run(
          `UPDATE "${family.namespace}"."cmp_root_users" SET "count" = 5 WHERE "id" = 1`
        );
      },
      {
        where: { id_count: { id: 1, count: 0 } },
        data: {
          count: { increment: 1 },
          posts: { create: { id: 76, title: "cmp" } },
        },
        select: { email: true, count: true },
      }
    );

    expect(result).toEqual({ email: "cmp@x", count: 6 });
    await expect(client.post.findMany()).resolves.toEqual([
      { id: 76, title: "cmp", userId: 1 },
    ]);
  });

  // The compound arm's no-interference control. Its `where` names `id` AND `count`, so
  // it is the same selector as the arm above with the mid-batch move removed: the
  // premise holds, the guard passes, and the unit runs exactly once.
  test("control: a compound-unique selector with no interference runs once", async () => {
    const family = getCompoundFamily();
    const client = family.client;
    await client.user.create({ data: { id: 1, email: "pk@x", count: 0 } });

    // No interference: the compound selector's premise holds and the unit runs once.
    const result = await runCompoundUpdateMidBatch(
      family,
      () => Promise.resolve(),
      {
        where: { id_count: { id: 1, count: 0 } },
        data: {
          count: { increment: 1 },
          posts: { create: { id: 77, title: "pk" } },
        },
        select: { email: true, count: true },
      }
    );

    expect(result).toEqual({ email: "pk@x", count: 1 });
  });
});
