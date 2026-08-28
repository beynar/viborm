import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
  NestedWriteError,
  TransactionError,
  UniqueConstraintError,
} from "@errors";

import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { executeRoutedOperation } from "@src/query-engine/write-engine/routing";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import {
  runUpsertFamilyBehavior,
  upsertFamilySchema,
} from "@tests/contracts/engine/write/upsert-family-behavior";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

// The whole upsert family on PGlite, both substrates (driver-matrix legs live in
// tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
runUpsertFamilyBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runUpsertFamilyBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

// ---------------------------------------------------------------------------
// The dual-run oracle (PLAN standing rule): the SAME payload driven through the
// real Direct client and — via the Observed-backed client proxy — through Observed, with
// reset state per arm, asserting byte-identical persisted state + result + error
// class AND message. Root upsert (create/update/targetWhere/setWhere) and nested
// connectOrCreate are certified head-to-head against Direct.
// ---------------------------------------------------------------------------

type State = { users: unknown[]; posts: unknown[] };

interface ErrorShape {
  name: string;
  code?: string | number;
  message: string;
}

interface Scenario {
  name: string;
  seed: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  act: (client: Record<string, RoutedModel>) => unknown;
  expectReject?: boolean;
}

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

function makeClient(db: PGlite) {
  return createClient({
    schema: upsertFamilySchema,
    driver: new PGliteDriver({ client: db }),
  });
}

function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const stable =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stable === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stable, message: error.message };
}

async function dump(client: ReturnType<typeof makeClient>): Promise<State> {
  const [users, posts] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, posts };
}

type ArmKind = "direct" | "observed-tx" | "observed-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof upsertFamilySchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database);
  await scenario.seed(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  let operations: { boundary: "direct" | "production" }[] = [];
  try {
    if (kind === "direct") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({ client: family.database })
          : new BatchOnlyPGliteDriver({ client: family.database });
      const observed = observeClientOperations({
        schema: upsertFamilySchema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const routedToObserved =
    kind === "direct" || operations.every((r) => r.boundary === "production");
  const observed = operations.length > 0;
  const state = await dump(client);
  return { result, error, state, routedToObserved, observed };
}

const scenarios: Scenario[] = [
  {
    name: "root upsert create branch",
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user!.upsert!({
        where: { email: "n@x" },
        create: { email: "n@x", score: 1 },
        update: { score: 100 },
        select: { email: true, score: true },
      }),
  },
  {
    name: "root upsert update branch",
    seed: (c) => c.user.create({ data: { email: "u@x", score: 10 } }),
    act: (c) =>
      c.user!.upsert!({
        where: { email: "u@x" },
        create: { email: "u@x", score: 999 },
        update: { score: 15 },
        select: { email: true, score: true },
      }),
  },
  // targetWhere/setWhere scalar skip is an EXTENSION scenario, NOT Direct dual-run
  // parity: Direct's scalar-only upsert takes the `ON CONFLICT` fast-path where
  // targetWhere (partial-index WHERE) and setWhere (conditional-update WHERE) do
  // NOT reproduce the branch-runtime skip — targetWhere no-match silently
  // updates, setWhere no-match raises V9001. Direct's *intended* skip (the
  // conformance contract, only reachable through the branch path when nested
  // writes are present) is what Observed implements probe-first + the retained
  // notExists pin. It therefore certifies by FIXED EXPECTATION (PLAN P−1.2's
  // extension-scenario class) in `runUpsertFamilyBehavior` + staleness/falsify
  // below, not against Direct's divergent scalar fast-path. Recorded in the report.
  {
    name: "nested connectOrCreate under update connects an existing child",
    seed: async (c) => {
      await c.user.create({ data: { email: "c@x", score: 0 } });
      await c.post.create({
        data: { id: 50, title: "orphan", slug: "s50", userId: null },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { email: "c@x" },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: 50 },
              create: { id: 50, title: "made", slug: "s50" },
            },
          },
        },
        select: { email: true, posts: { select: { id: true, userId: true } } },
      }),
  },
  {
    name: "nested connectOrCreate under update creates a missing child",
    seed: (c) => c.user.create({ data: { email: "cc@x", score: 0 } }),
    act: (c) =>
      c.user!.update!({
        where: { email: "cc@x" },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: 51 },
              create: { id: 51, title: "fresh", slug: "s51" },
            },
          },
        },
        select: { email: true, posts: { select: { id: true, userId: true } } },
      }),
  },
];

describe("write boundary upsert family dual-run oracle (Direct vs Observed)", () => {
  const getFamily = usePGliteSchemaFamily(upsertFamilySchema);
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      expect(tx.observed).toBe(true);
      expect(batch.observed).toBe(true);
      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      expect(tx.error).toEqual(direct.error);
      expect(batch.error).toEqual(direct.error);
      expect(Boolean(direct.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(direct.result);
        expect(batch.result).toEqual(direct.result);
      }

      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
    });
  }
});

// ---------------------------------------------------------------------------
// Observed upsert construction surface (was PLAN P2b per-tree routing). Pre-P6 an upsert
// whose arm carried a nested relation mutation observed the whole tree to the Direct
// client; post-P6 there is no Direct, so Observed's construction-time decision IS the
// caller's outcome — a supported upsert constructs, an out-of-surface arm declines
// with the typed refusal (an UnsupportedOperationError) before any I/O.
// ---------------------------------------------------------------------------

describe("write boundary upsert construction surface", () => {
  // DELIBERATE RETARGET (N1-U1). The second case used to be this file's decline
  // example, and its cause was the update arm's nested create demanding a
  // compile-time literal for the child's foreign key while the `where` names
  // `email`. The upsert's update arm IS an `UpdateOperation`, so N1's located-parent
  // Ref lands here unchanged and the tree constructs. The behavior witness — that
  // the update arm actually writes the child against the located row, and that the
  // CREATE arm is unaffected — is in `upsert-family-behavior.ts`, on every driver
  // and both substrates.
  test("both a scalar upsert and an update arm carrying a nested create construct on Observed", () => {
    const schemas = createSchemaRegistry(upsertFamilySchema);
    const boundary = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(upsertFamilySchema, schemas)
    );
    const userModel = upsertFamilySchema.user;

    expect(
      new UpsertOperation(boundary, userModel, {
        where: { email: "r@x" },
        create: { email: "r@x", score: 0 },
        update: { score: { increment: 1 } },
        select: { email: true },
      })
    ).toBeInstanceOf(UpsertOperation);

    expect(
      new UpsertOperation(boundary, userModel, {
        where: { email: "r@x" },
        create: { email: "r@x", score: 0 },
        update: {
          posts: { create: { id: 1, title: "t", slug: "sr" } },
        },
        select: { email: true, posts: { select: { id: true } } },
      })
    ).toBeInstanceOf(UpsertOperation);
  });
});

// ---------------------------------------------------------------------------
// Scope-shrink refusal (attack #4): a depth-2 shape whose grandchild is a to-one
// relation. `posts.upsert` is one-to-many (Observed depth-composes it), but its update
// arm's `author` is a many-to-one grandchild outside Observed's narrow door. Observed's depth
// recursion declines with an UnsupportedOperationError (a QueryEngineError
// SUBCLASS, never a bare QueryEngineError) during UpdateOperation construction,
// before any I/O. Pre-P6 the proxy caught that and observed the whole tree to Direct;
// post-P6 the typed refusal is the caller's outcome.
//
// Package B3 of the limitation lift tried to discharge this and was FALSIFIED at the
// package gate. `author` is the INVERSE of the traversed `posts`, so the arm's incoming
// membership and the deeper parent-held fold both write `authorId`, and the incoming one
// wins silently — an accepted payload whose requested write is discarded. The refusal
// below is what keeps that unreachable; the measurement is recorded in
// `nested-arm-dispatch.test.ts`.
// ---------------------------------------------------------------------------

describe("write boundary depth-2 to-one grandchild, LIFTED", () => {
  // RETARGETED by the residual lift's Package I orchestrator pass (2026-08-14).
  //
  // This block asserted `assertArmEdgeIsChildHeld` — the broad parent-held refusal
  // that residual Package C DELETED and replaced with the exact
  // same-incoming-membership target-mutation rule. The file was never retargeted, so
  // it had been red since C and was carried through D-I as "stale batch residue" it
  // never belonged to (it constructs in 9 ms and never reaches a driver).
  //
  // MEASURED on PGlite before rewriting, because the shape is the one whose SILENT
  // OVERWRITE the first lift's Package B restored a guard for: the arm's incoming
  // membership and the deeper parent-held fold both write `userId`. Both halves are
  // pinned below. The old defect was that the explicit write was DISCARDED; residual
  // C's assignment reconciliation makes the incoming membership locate/guard-only, so
  // the explicit write is the one final value and it LANDS. The refusal is gone
  // because the composition became coherent, not because the hazard was accepted.
  const getFamily = usePGliteSchemaFamily(upsertFamilySchema);

  test("constructs — the broad refusal is gone", () => {
    const schemas = createSchemaRegistry(upsertFamilySchema);
    const boundary = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(upsertFamilySchema, schemas)
    );

    expect(
      () =>
        new UpdateOperation(boundary, upsertFamilySchema.user, {
          where: { email: "gp@x" },
          data: {
            posts: {
              upsert: [
                {
                  where: { id: 50 },
                  create: { id: 50, title: "created", slug: "s50c" },
                  update: {
                    author: {
                      connectOrCreate: {
                        where: { id: 1 },
                        create: { id: 1, email: "gp@x", score: 0 },
                      },
                    },
                  },
                },
              ],
            },
          },
          select: { email: true },
        })
    ).not.toThrow();
  });

  test(
    "the deeper parent-held write is the final value on both the agreeing and the DISAGREEING spelling",
    { timeout: 30_000 },
    async () => {
      const family = getFamily();
      await family.reset();
      const client = makeClient(family.database);
      await client.user.create({ data: { id: 1, email: "gp@x", score: 0 } });
      await client.user.create({ data: { id: 2, email: "other@x", score: 0 } });
      await client.post.create({
        data: {
          id: 50,
          title: "orig",
          slug: "s50",
          author: { connect: { id: 1 } },
        },
      });

      // AGREEING: the grandchild names the same parent the arm located through.
      await client.user.update({
        where: { email: "gp@x" },
        data: {
          posts: {
            upsert: [
              {
                where: { id: 50 },
                create: { id: 50, title: "created", slug: "s50c" },
                update: {
                  author: {
                    connectOrCreate: {
                      where: { id: 1 },
                      create: { id: 1, email: "gp@x", score: 0 },
                    },
                  },
                },
              },
            ],
          },
        },
        select: { email: true },
      });
      await expect(
        client.post.findUnique({ where: { id: 50 } })
      ).resolves.toMatchObject({ userId: 1 });

      // DISAGREEING — the half that measures the old defect. The arm located post 50
      // through user 1; the update arm reparents it to user 2. The requested write is
      // the final value; a `userId` of 1 here would be the silent discard.
      await client.user.update({
        where: { email: "gp@x" },
        data: {
          posts: {
            upsert: [
              {
                where: { id: 50 },
                create: { id: 50, title: "created", slug: "s50c" },
                update: { author: { connect: { id: 2 } } },
              },
            ],
          },
        },
        select: { email: true },
      });
      await expect(
        client.post.findUnique({ where: { id: 50 } })
      ).resolves.toMatchObject({ userId: 2 });
    }
  );
});

// ---------------------------------------------------------------------------
// Staleness injection (PLAN P2b instrument): the single-threaded oracle cannot
// observe raceability, so each NEW premise class gets a before-batch hook that
// mutates committed state after Observed's unlocked planning read decides the arm but
// before the atomic batch runs. The pinned guard must then abort the batch typed
// — proving the premise is actually pinned inside the atomic unit.
// ---------------------------------------------------------------------------

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
    // Fire before the operation's compiled ATOMIC UNIT, not the first batch of
    // any kind: planning reads ride a batch too once grouped by level (PLAN
    // Phase 6.1).
    if (hook && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await hook();
    }
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

function buildBatchExecution(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  operation: "update" | "upsert",
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
) {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(upsertFamilySchema);
  const boundary = new QueryEngine(
    driver,
    createModelRegistry(upsertFamilySchema, schemas)
  );
  const executor = new OperationExecutor(boundary);
  const instance =
    operation === "upsert"
      ? new UpsertOperation(boundary, model, args)
      : new UpdateOperation(boundary, model, args);
  const context = createOperationExecutionContext(
    modelName,
    operation,
    boundary.instrumentation
  );
  return { executor, instance, context };
}

function runBatch(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  operation: "update" | "upsert",
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const { executor, instance, context } = buildBatchExecution(
    db,
    beforeBatch,
    operation,
    modelName,
    model,
    args
  );
  return executor.execute(instance, context);
}

/** `runBatch` through the production retry layer (`executeRoutedOperation`): a
 *  `meta.raceable` abort re-plans once instead of surfacing. */
function runRoutedBatch(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  operation: "update" | "upsert",
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const { executor, instance, context } = buildBatchExecution(
    db,
    beforeBatch,
    operation,
    modelName,
    model,
    args
  );
  return executeRoutedOperation(executor, instance, context);
}

describe("write boundary upsert-family staleness injection (per premise class)", () => {
  test("connectOrCreate found premise: a concurrent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "own@x", score: 0 } });
    await client.post.create({
      data: { id: 60, title: "orphan", slug: "s60", userId: null },
    });

    const injector = makeClient(db);
    await expect(
      runBatch(
        db,
        async () => {
          // The globally-located connectOrCreate target vanishes before the
          // batch pins & connects it — the found exists guard must abort.
          await injector.post.delete({ where: { id: 60 } });
        },
        "update",
        "user",
        upsertFamilySchema.user,
        {
          where: { email: "own@x" },
          data: {
            posts: {
              connectOrCreate: {
                where: { id: 60 },
                create: { id: 60, title: "made", slug: "s60" },
              },
            },
          },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);
    await client.$disconnect();
  });

  test("targetWhere skip premise: a concurrent write that makes the row match aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "sk@x", score: 10 } });

    // Planning sees the row does NOT match targetWhere{score:999} → skip. The
    // hook makes it match; the retained notExists pin must abort the batch (had
    // it not, Observed would silently return the now-stale skip). This is the FALSIFY
    // target: removing `absenceGuard` from compileSkipArm makes this pass with a
    // silent stale skip instead of the typed abort. The abort carries
    // `meta.raceable` (ATOM §2's retained-pin class) — the mark the observed retry
    // converges on; dropping the propagation in `failureError` fails this.
    const injector = makeClient(db);
    const rejected = await runBatch(
      db,
      async () => {
        await injector.user.update({
          where: { email: "sk@x" },
          data: { score: 999 },
        });
      },
      "upsert",
      "user",
      upsertFamilySchema.user,
      {
        where: { email: "sk@x" },
        targetWhere: { score: 999 },
        create: { email: "sk@x", score: 0 },
        update: { score: 15 },
        select: { email: true, score: true },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(TransactionError);
    expect((rejected as TransactionError).meta.raceable).toBe(true);
    await client.$disconnect();
  });

  test("setWhere skip premise: a concurrent write that makes the row match aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "sk2@x", score: 10 } });

    const injector = makeClient(db);
    const rejected = await runBatch(
      db,
      async () => {
        await injector.user.update({
          where: { email: "sk2@x" },
          data: { score: 999 },
        });
      },
      "upsert",
      "user",
      upsertFamilySchema.user,
      {
        where: { email: "sk2@x" },
        setWhere: { score: 999 },
        create: { email: "sk2@x", score: 0 },
        update: { score: 15 },
        select: { email: true, score: true },
      }
    ).catch((error) => error);
    expect(rejected).toBeInstanceOf(TransactionError);
    expect((rejected as TransactionError).meta.raceable).toBe(true);
    await client.$disconnect();
  });

  test("targetWhere skip premise: through the observed retry the raceable abort re-plans and converges", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "sk3@x", score: 10 } });

    // The SAME staleness as above, but through `executeRoutedOperation` (the
    // production path): the skip-premise abort is `meta.raceable`, so the retry
    // re-plans, sees the row NOW matching targetWhere, and takes the update arm
    // — one retry, convergence, no surfaced error. FALSIFY: drop the `raceable`
    // propagation on `failureError`'s query arm and this rejects with the
    // skip-premise TransactionError instead of converging.
    const injector = makeClient(db);
    await runRoutedBatch(
      db,
      async () => {
        await injector.user.update({
          where: { email: "sk3@x" },
          data: { score: 999 },
        });
      },
      "upsert",
      "user",
      upsertFamilySchema.user,
      {
        where: { email: "sk3@x" },
        targetWhere: { score: 999 },
        create: { email: "sk3@x", score: 0 },
        update: { score: 15 },
        select: { email: true, score: true },
      }
    );
    const after = await client.user.findUnique({ where: { email: "sk3@x" } });
    expect(after).toMatchObject({ email: "sk3@x", score: 15 });
    await client.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// Race convergence (PLAN P2b gate): the P0 create-branch race extended to
// connectOrCreate. A concurrent winner commits the child key just before the
// loser's batch runs; the loser's missing-arm INSERT then violates the
// constraint and surfaces as the racePin-matched UniqueConstraintError — never a
// guard abort. Both racers of a missing key converge to one row. (The Docker
// two-real-connection legs live in tests/drivers/{pg,mysql2}.test.ts; PGlite's
// single session models the same window deterministically here.)
// ---------------------------------------------------------------------------

describe("write boundary connectOrCreate create-branch race convergence", () => {
  test("the loser surfaces a pinned unique conflict, never a guard abort", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "race@x", score: 0 } });

    const injector = makeClient(db);
    let caught: unknown;
    await runBatch(
      db,
      async () => {
        // The winner commits post 70 (the connectOrCreate target) just before
        // the loser's missing-arm INSERT runs.
        await injector.post.create({
          data: { id: 70, title: "winner", slug: "s70", userId: null },
        });
      },
      "update",
      "user",
      upsertFamilySchema.user,
      {
        where: { email: "race@x" },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: 70 },
              create: { id: 70, title: "loser", slug: "s70" },
            },
          },
        },
        select: { email: true },
      }
    ).catch((error) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(UniqueConstraintError);
    expect(caught).not.toBeInstanceOf(NestedWriteError);
    // Convergence: exactly one post 70 survives (the winner's).
    await expect(client.post.findMany()).resolves.toEqual([
      { id: 70, title: "winner", slug: "s70", userId: null },
    ]);
    await client.$disconnect();
  });
});
