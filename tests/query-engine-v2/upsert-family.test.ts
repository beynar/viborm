import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import {
  NestedWriteError,
  TransactionError,
  UniqueConstraintError,
} from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { UpsertOperation } from "../../src/query-engine-v2/UpsertOperation";
import {
  runUpsertFamilyBehavior,
  upsertFamilySchema,
} from "./upsert-family-behavior";
import { createV2RoutedClient } from "./v2-client-proxy";

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
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

// The whole upsert family on PGlite, both substrates (driver-matrix legs live in
// tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
runUpsertFamilyBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runUpsertFamilyBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// The dual-run oracle (PLAN standing rule): the SAME payload driven through the
// real V1 client and — via the V2-backed client proxy — through V2, on FRESH
// instances per arm, asserting byte-identical persisted state + result + error
// class AND message. Root upsert (create/update/targetWhere/setWhere) and nested
// connectOrCreate are certified head-to-head against V1.
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

type ArmKind = "v1" | "v2-tx" | "v2-batch";

async function runArm(kind: ArmKind, scenario: Scenario) {
  const db = new PGlite();
  const client = makeClient(db);
  await push(client, { force: true });
  await scenario.seed(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  let routes: { engine: "v1" | "v2" }[] = [];
  try {
    if (kind === "v1") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      const routed = createV2RoutedClient({
        schema: upsertFamilySchema,
        client: client as unknown as Record<string, RoutedModel>,
        driver,
      });
      routes = routed.routes;
      result = await scenario.act(routed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const routedToV2 = kind === "v1" || routes.every((r) => r.engine === "v2");
  const routed = routes.length > 0;
  const state = await dump(client);
  await client.$disconnect();
  return { result, error, state, routedToV2, routed };
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
  // targetWhere/setWhere scalar skip is an EXTENSION scenario, NOT V1 dual-run
  // parity: V1's scalar-only upsert takes the `ON CONFLICT` fast-path where
  // targetWhere (partial-index WHERE) and setWhere (conditional-update WHERE) do
  // NOT reproduce the branch-runtime skip — targetWhere no-match silently
  // updates, setWhere no-match raises V9001. V1's *intended* skip (the
  // conformance contract, only reachable through the branch path when nested
  // writes are present) is what V2 implements probe-first + the retained
  // notExists pin. It therefore certifies by FIXED EXPECTATION (PLAN P−1.2's
  // extension-scenario class) in `runUpsertFamilyBehavior` + staleness/falsify
  // below, not against V1's divergent scalar fast-path. Recorded in the report.
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

describe("query-engine-v2 upsert family dual-run oracle (V1 vs V2)", () => {
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      expect(tx.routed).toBe(true);
      expect(batch.routed).toBe(true);
      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);

      expect(tx.error).toEqual(v1.error);
      expect(batch.error).toEqual(v1.error);
      expect(Boolean(v1.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(v1.result);
        expect(batch.result).toEqual(v1.result);
      }

      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
    });
  }
});

// ---------------------------------------------------------------------------
// Routing (PLAN P2b): a supported upsert runs on V2; an upsert whose arm carries
// a nested relation mutation (out of P2b scope) falls back to the real V1 client
// — one call never mixes engines. Proven by the proxy's route spy.
// ---------------------------------------------------------------------------

describe("query-engine-v2 per-tree routing (upsert)", () => {
  test("scalar upsert routes to V2; nested-arm upsert routes to V1", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "r@x", score: 0 } });

    const routed = createV2RoutedClient({
      schema: upsertFamilySchema,
      client: client as unknown as Record<string, RoutedModel>,
      driver: new PGliteDriver({ client: db }),
    });

    await routed.client.user!.upsert!({
      where: { email: "r@x" },
      create: { email: "r@x", score: 0 },
      update: { score: { increment: 1 } },
      select: { email: true },
    });
    expect(routed.routes.at(-1)).toEqual({
      model: "user",
      operation: "upsert",
      engine: "v2",
    });

    // A nested relation mutation in the update arm is out of P2b scope → V1.
    await routed.client.user!.upsert!({
      where: { email: "r@x" },
      create: { email: "r@x", score: 0 },
      update: {
        posts: { create: { id: 1, title: "t", slug: "sr" } },
      },
      select: { email: true, posts: { select: { id: true } } },
    });
    expect(routed.routes.at(-1)).toEqual({
      model: "user",
      operation: "upsert",
      engine: "v1",
    });
    await expect(
      client.post.findUnique({ where: { id: 1 } })
    ).resolves.toMatchObject({ userId: 1 });

    await client.$disconnect();
  });
});

// ---------------------------------------------------------------------------
// Staleness injection (PLAN P2b instrument): the single-threaded oracle cannot
// observe raceability, so each NEW premise class gets a before-batch hook that
// mutates committed state after V2's unlocked planning read decides the arm but
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

function runBatch(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  operation: "update" | "upsert",
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(upsertFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(upsertFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const instance =
    operation === "upsert"
      ? new UpsertOperation(engine, model, args)
      : new UpdateOperation(engine, model, args);
  const context = createOperationExecutionContext(
    modelName,
    operation,
    engine.instrumentation
  );
  return executor.execute(instance, context);
}

describe("query-engine-v2 upsert-family staleness injection (per premise class)", () => {
  test("connectOrCreate found premise: a concurrent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
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
    await push(client, { force: true });
    await client.user.create({ data: { email: "sk@x", score: 10 } });

    // Planning sees the row does NOT match targetWhere{score:999} → skip. The
    // hook makes it match; the retained notExists pin must abort the batch (had
    // it not, V2 would silently return the now-stale skip). This is the FALSIFY
    // target: removing `absenceGuard` from compileSkipArm makes this pass with a
    // silent stale skip instead of the typed abort.
    const injector = makeClient(db);
    await expect(
      runBatch(
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
      )
    ).rejects.toBeInstanceOf(TransactionError);
    await client.$disconnect();
  });

  test("setWhere skip premise: a concurrent write that makes the row match aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "sk2@x", score: 10 } });

    const injector = makeClient(db);
    await expect(
      runBatch(
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
      )
    ).rejects.toBeInstanceOf(TransactionError);
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

describe("query-engine-v2 connectOrCreate create-branch race convergence", () => {
  test("the loser surfaces a pinned unique conflict, never a guard abort", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
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
