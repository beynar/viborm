import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import {
  type BatchQuery,
  Driver,
  type DriverResultParser,
  type QueryExecutionContext,
  type QueryResult,
} from "@drivers";
import { getExecutionInstrumentation } from "@drivers/execution-context";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError, QueryError, UniqueConstraintError } from "@errors";
import { createInstrumentationContext } from "@instrumentation/context";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import {
  isOperationValueReference,
  ref,
  type TargetConstraintPin,
} from "@src/query-engine/write-engine/OperationFragment";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  createNestedUpsertArgs,
  createOperationExecutor,
  createOperationRunner,
  operationFragmentSchema,
  runCreateNestedUpsertBehavior,
} from "@tests/contracts/engine/write/create-nested-upsert-behavior";

class BatchCountingPGliteDriver extends BatchOnlyPGliteDriver {
  batchCalls = 0;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    return super.executeBatch<T>(client, queries);
  }
}

class BeforeBatchPGliteDriver extends BatchCountingPGliteDriver {
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
    const beforeBatch = this.beforeBatch;
    // Fire before the operation's compiled ATOMIC UNIT, not the first batch of
    // any kind: planning reads ride a batch too once grouped by level (PLAN
    // Phase 6.1).
    if (beforeBatch && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await beforeBatch();
    }
    return super.executeBatch<T>(client, queries);
  }
}

class FailingResultPGliteDriver extends PGliteDriver {
  readonly failure = new QueryError("result parser failure");
  override readonly result: DriverResultParser = {
    parseResult: () => {
      throw this.failure;
    },
  };
}

class TransactionProbeDriver extends Driver<string, string> {
  readonly adapter = new PostgresAdapter();
  readonly clients: string[] = [];
  readonly statements: string[] = [];
  readonly contexts: (QueryExecutionContext | undefined)[] = [];
  executions = 0;

  constructor() {
    super("postgresql", "write-engine-transaction-probe");
  }

  protected async initClient(): Promise<string> {
    return "client";
  }

  protected async closeClient(): Promise<void> {
    // This driver owns no external resource.
  }

  protected async execute<T>(
    client: string,
    statement: string,
    _params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.executions += 1;
    this.clients.push(client);
    this.statements.push(statement);
    this.contexts.push(context);
    return { rows: [], rowCount: this.executions === 1 ? 0 : 1 };
  }

  protected executeRaw<T>(
    client: string,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, statement, params ?? [], context);
  }

  protected async transaction<T>(
    _client: string,
    execute: (transaction: string) => Promise<T>
  ): Promise<T> {
    return execute("transaction");
  }
}

class UnsupportedDriver extends TransactionProbeDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

class BatchProbeDriver extends Driver<null, null> {
  readonly adapter = new PostgresAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  executions = 0;
  batchCalls = 0;

  constructor() {
    super("postgresql", "write-engine-batch-probe");
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // This driver owns no external resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    this.executions += 1;
    return { rows: [], rowCount: 0 };
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }
}

class GuardProviderFailureBatchDriver extends BatchProbeDriver {
  readonly failure = new QueryError("guard provider failure");
  guardIndex = -1;

  // The planning read finds the child, so the operation takes the found branch —
  // the only branch that carries a guard now that the Pin Rule removed the
  // missing-branch notExists guard.
  protected override async execute<T>(): Promise<QueryResult<T>> {
    this.executions += 1;
    return { rows: [{ id: 1 }] as T[], rowCount: 1 };
  }

  override _executeBatch<T>(queries: BatchQuery[]): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    this.guardIndex = queries.findIndex((query) =>
      query.sql.includes("__viborm_assert__")
    );
    return Promise.reject(this.failure);
  }
}

class ShortBatchDriver extends BatchProbeDriver {
  override _executeBatch<T>(): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    return Promise.resolve([]);
  }
}

class MalformedResultDriver extends BatchProbeDriver {
  override _execute<T>(): Promise<QueryResult<T>> {
    this.executions += 1;
    return Promise.resolve({ rows: [], rowCount: Number.NaN });
  }
}

runCreateNestedUpsertBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});

runCreateNestedUpsertBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

describe("write engine linear operation fragments", () => {
  test("creates locked transaction planning and linear final fragments", () => {
    const driver = new TransactionProbeDriver();
    const operation = createOperation(driver);
    const planning = operation.planning();
    const planningStep = planning.steps[0];

    expect(operation.mode).toBe("transaction");
    expect(planning.steps.map((step) => step.id)).toEqual(["post.find"]);
    expect(planning.outputs).toEqual({
      "post.find.rows": ref("post.find", "rows"),
      "post.find.id": ref("post.find", "id"),
    });
    expect(planningStep?.kind).toBe("read");
    if (planningStep?.kind !== "read") return;
    expect(driver._prepare(planningStep.statement).sql).toContain("FOR UPDATE");

    const existing = operation.compile({ "post.find.rows": [{ id: 1 }] });
    const missing = operation.compile({ "post.find.rows": [] });
    expect(existing.steps.map((step) => step.id)).toEqual([
      "user.create",
      "post.update",
      "user.select",
    ]);
    expect(missing.steps.map((step) => step.id)).toEqual([
      "user.create",
      "post.create",
      "user.select",
    ]);
    // No guards in transaction mode — the locked probe pins both premises.
    expect(
      [...existing.steps, ...missing.steps].every(
        (step) => step.kind !== "guard"
      )
    ).toBe(true);
    // The found-branch update carries an affectedRows postcondition; the
    // missing-branch create carries the racePin, never a postcondition.
    const txUpdate = existing.steps[1];
    expect(txUpdate?.kind === "write" && txUpdate.expects?.kind).toBe(
      "affectedRows"
    );
    const txCreateChild = missing.steps[1];
    expect(
      txCreateChild?.kind === "write" && txCreateChild.racePin?.fields
    ).toEqual(["id"]);
    expect(txCreateChild?.kind === "write" && txCreateChild.expects).toBe(
      undefined
    );
    const txTerminal = existing.steps[2];
    expect(txTerminal?.kind === "read" && txTerminal.expects?.kind).toBe(
      "exactlyOneRow"
    );
    expect(existing.outputs).toEqual({
      result: ref("user.select", "result"),
    });
  });

  test("creates unlocked batch planning and a Pin-Rule-compliant final fragment", () => {
    const driver = new BatchProbeDriver();
    const operation = createOperation(driver);
    const planning = operation.planning();
    const planningStep = planning.steps[0];

    expect(operation.mode).toBe("batch");
    expect(planningStep?.kind).toBe("read");
    if (planningStep?.kind !== "read") return;
    expect(driver._prepare(planningStep.statement).sql).not.toContain(
      "FOR UPDATE"
    );

    const existing = operation.compile({ "post.find.rows": [{ id: 1 }] });
    const missing = operation.compile({ "post.find.rows": [] });
    // Found branch keeps its exists guard; missing branch has NO guard — the
    // child's unique constraint enforces the premise (Pin Rule).
    expect(existing.steps.map((step) => step.id)).toEqual([
      "post.guard.exists",
      "user.create",
      "post.update",
      "user.select",
    ]);
    expect(missing.steps.map((step) => step.id)).toEqual([
      "user.create",
      "post.create",
      "user.select",
    ]);
    expect(existing.steps[0]?.kind).toBe("guard");
    expect(missing.steps.every((step) => step.kind !== "guard")).toBe(true);

    const existingGuard = existing.steps[0];
    if (existingGuard?.kind !== "guard") return;
    // The stored batch guard probe no longer locks (dropped forUpdate: true).
    expect(driver._prepare(existingGuard.premise.statement).sql).not.toContain(
      "FOR UPDATE"
    );
    // An existing-row premise is pinned raceable: false.
    expect(existingGuard.premise.kind).toBe("exists");
    expect(existingGuard.failure.raceable).toBe(false);

    // The missing-branch create carries the racePin and no postcondition; its
    // constraint violation is the raceable signal.
    const createChild = missing.steps[1];
    expect(createChild?.kind).toBe("write");
    if (createChild?.kind !== "write") return;
    expect(createChild.statement.values.some(isOperationValueReference)).toBe(
      true
    );
    expect(createChild.racePin?.fields).toEqual(["id"]);
    expect(createChild.racePin?.table).toBe("operation_fragment_posts");
    expect(createChild.expects).toBeUndefined();
  });

  test("rejects unsupported shapes and unsupported drivers before I/O", async () => {
    const driver = new TransactionProbeDriver();

    expect(
      () =>
        new CreateOperation(
          driverEngine(driver),
          operationFragmentSchema.user,
          {
            data: {
              name: "henry",
              posts: {
                upsert: {
                  where: { id: 1 },
                  create: {
                    id: 1,
                    title: "post",
                    slug: "post-key",
                    author: { connect: { id: 1 } },
                  },
                  update: { title: "post" },
                },
              },
            },
            select: { name: true, posts: true },
          }
        )
      // RETARGETED BY N4-U2 (authorized test change). This assertion has been walked
      // down the same shape twice: first the proof-slice's blanket "deeper relation
      // mutations" refusal, then RelationUpsertPart's create-arm bound ("only
      // connectOrCreate one level deeper"). Both are gone. The create arm's row is
      // PRODUCED, and a produced row's relations are the create root's surface, so the
      // whole arm is now a create SUBTREE and a deeper parent-held to-one `connect` is
      // simply one of the things a create root has always folded. The payload is
      // unchanged; what it does is now construct, so the assertion is that it does.
    ).not.toThrow();

    const upsert = createNestedUpsertArgs().data.posts.upsert;
    expect(
      () =>
        new CreateOperation(
          driverEngine(driver),
          operationFragmentSchema.user,
          {
            data: {
              name: "henry",
              posts: { upsert: [upsert, upsert] },
            },
            select: { name: true, posts: true },
          }
        )
      // The create family generalized (PLAN P6-prerequisite): a to-many `upsert`
      // is now an ARRAY (V1's surface), no longer the proof-slice's single-object
      // limitation. Two upserts naming the SAME target under a fresh parent is a
      // genuine own-write dependency (arm 2's create/adopt decision depends on
      // arm 1's write); the own-write preflight (ATOM §4) rejects it at
      // construction with V1's BYTE-IDENTICAL NestedWriteError — the dual-run
      // oracle confirms V1 and V2 emit the same error and the same (empty) state.
    ).toThrow("Split these operations into separate queries");
    expect(driver.executions).toBe(0);

    // A neither-substrate driver is NOT rejected at construction — V1 parity
    // (OperationRuntime.execute): a single-statement program runs directly on
    // any driver via statement atomicity, so an operation must be constructible
    // regardless of substrate. A MULTI-statement operation (this nested upsert)
    // fails closed at EXECUTE, before any I/O, with V1's byte-identical
    // TransactionError. The old construction-time throw diverged from V1 both in
    // timing and in type (it raised QueryEngineError for most operations); the
    // P5 flip corrected it (see report design decision).
    const unsupported = new UnsupportedDriver();
    expect(() => createOperation(unsupported)).not.toThrow();
    await expect(
      createOperationExecutor(unsupported).executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow(
      "supports neither transactions nor atomic batch execution"
    );
    expect(unsupported.executions).toBe(0);
  });

  test("slice (a): an invalid nested upsert payload fails at VALIDATION, not the engine", () => {
    const driver = new TransactionProbeDriver();
    // The nested upsert is now validated through the relation's first-class
    // CREATE-input schema (the update-schema smuggling is gone). A wrong-typed
    // create field is a ValidationError raised before any planning or I/O.
    expect(
      () =>
        new CreateOperation(
          driverEngine(driver),
          operationFragmentSchema.user,
          {
            data: {
              name: "henry",
              posts: {
                upsert: {
                  where: { id: 1 },
                  create: { id: 1, title: 42, slug: "post-key" },
                  update: { title: "post" },
                },
              },
            },
            select: { name: true, posts: true },
          }
        )
    ).toThrow("Validation failed for create");
    expect(driver.executions).toBe(0);
  });

  test("plans on the transaction-bound driver and fails closed on a missing generated id", async () => {
    const driver = new TransactionProbeDriver();

    await expect(
      createOperationExecutor(driver).executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("did not produce row field 'id'");

    expect(driver.clients).toEqual(["transaction", "transaction"]);
    expect(driver.statements[0]).toContain("FOR UPDATE");
  });

  test("passes engine-owned attribution through staged transaction execution", async () => {
    const driver = new TransactionProbeDriver();
    const instrumentation = createInstrumentationContext({});
    const runner = createOperationRunner(
      new QueryEngine(
        driver,
        createModelRegistry(
          operationFragmentSchema,
          createSchemaRegistry(operationFragmentSchema)
        ),
        instrumentation
      )
    );

    await expect(
      runner.executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("did not produce row field 'id'");

    expect(driver.contexts[0]).toMatchObject({
      model: "user",
      operation: "create",
    });
    expect(driver.contexts[0]?.correlationId).toEqual(expect.any(String));
    expect(getExecutionInstrumentation(driver.contexts[0])).toBeDefined();
  });

  test("uses the validated selection snapshot during result parsing", () => {
    const driver = new TransactionProbeDriver();
    const args = createNestedUpsertArgs();
    const operation = new CreateOperation(
      driverEngine(driver),
      operationFragmentSchema.user,
      args
    );
    args.select.name = false;
    args.select.posts = false;

    expect(
      operation.parse({
        result: [{ name: "henry", posts: [] }],
      })
    ).toEqual({ name: "henry", posts: [] });
  });

  test("performs one planning read before one atomic batch and preserves guard provider errors", async () => {
    const driver = new GuardProviderFailureBatchDriver();
    const execution = createOperationExecutor(driver).executeCreate(
      operationFragmentSchema.user,
      createNestedUpsertArgs()
    );

    await expect(execution).rejects.toBe(driver.failure);
    await expect(execution).rejects.not.toBeInstanceOf(NestedWriteError);
    expect(driver.executions).toBe(1);
    expect(driver.batchCalls).toBe(1);
    expect(driver.guardIndex).toBeGreaterThanOrEqual(0);
  });

  test("rejects malformed provider results and incorrect batch result counts", async () => {
    const malformed = new MalformedResultDriver();
    await expect(
      createOperationExecutor(malformed).executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("malformed normalized result");
    expect(malformed.batchCalls).toBe(0);

    const short = new ShortBatchDriver();
    await expect(
      createOperationExecutor(short).executeCreate(
        operationFragmentSchema.user,
        createNestedUpsertArgs()
      )
    ).rejects.toThrow("returned 0 results");
    expect(short.executions).toBe(1);
    expect(short.batchCalls).toBe(1);
  });

  test(
    "rolls back transaction writes when result parsing fails",
    {
      timeout: 30_000,
    },
    async () => {
      const db = new PGlite();
      const setup = createClient({
        schema: operationFragmentSchema,
        driver: new PGliteDriver({ client: db }),
      });
      const driver = new FailingResultPGliteDriver({ client: db });
      try {
        await push(setup, { force: true });

        await expect(
          createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs()
          )
        ).rejects.toBe(driver.failure);
        await expect(setup.user.findMany()).resolves.toEqual([]);
        await expect(setup.post.findMany()).resolves.toEqual([]);
      } finally {
        await setup.$disconnect();
      }
    }
  );

  test(
    "propagates a post-guard unique conflict and rolls back without retry",
    {
      timeout: 30_000,
    },
    async () => {
      const db = new PGlite();
      const setup = createClient({
        schema: operationFragmentSchema,
        driver: new PGliteDriver({ client: db }),
      });
      const driver = new BatchCountingPGliteDriver({ client: db });
      try {
        await push(setup, { force: true });
        await setup.post.create({
          data: {
            id: 2,
            title: "existing",
            slug: "post-key",
            userId: null,
          },
        });

        await expect(
          createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs()
          )
        ).rejects.toBeInstanceOf(UniqueConstraintError);
        expect(driver.batchCalls).toBe(1);
        await expect(setup.user.findMany()).resolves.toEqual([]);
        await expect(setup.post.findMany()).resolves.toEqual([
          {
            id: 2,
            title: "existing",
            slug: "post-key",
            userId: null,
          },
        ]);
      } finally {
        await setup.$disconnect();
      }
    }
  );

  test(
    "fails a stale batch premise before writes and leaves no partial mutation",
    {
      timeout: 30_000,
    },
    async () => {
      const db = new PGlite();
      const setup = createClient({
        schema: operationFragmentSchema,
        driver: new PGliteDriver({ client: db }),
      });
      try {
        await push(setup, { force: true });
        await setup.post.create({
          data: {
            id: 1,
            title: "draft",
            slug: "post-key",
            userId: null,
          },
        });
        const driver = new BeforeBatchPGliteDriver(
          async () => {
            await setup.post.delete({ where: { id: 1 } });
          },
          { client: db }
        );

        await expect(
          createOperationExecutor(driver).executeCreate(
            operationFragmentSchema.user,
            createNestedUpsertArgs("published")
          )
        ).rejects.toBeInstanceOf(NestedWriteError);
        expect(driver.batchCalls).toBe(1);
        await expect(setup.user.findMany()).resolves.toEqual([]);
        await expect(setup.post.findMany()).resolves.toEqual([]);
      } finally {
        await setup.$disconnect();
      }
    }
  );

  test("emits Pin-Rule guard flags per premise class", () => {
    const batch = createOperation(new BatchProbeDriver());

    // Existing-row premise: pinned by an exists guard, raceable: false.
    const guard = batch.compile({ "post.find.rows": [{ id: 1 }] }).steps[0];
    expect(guard?.kind).toBe("guard");
    if (guard?.kind !== "guard") return;
    expect(guard.premise.kind).toBe("exists");
    expect(guard.failure).toMatchObject({
      kind: "nestedWrite",
      relation: "posts",
      raceable: false,
    });

    // Same-model-INSERT missing premise: never guarded — the child's unique
    // constraint enforces it, and its racePin classifies the violation.
    const missing = batch.compile({ "post.find.rows": [] });
    expect(missing.steps.some((step) => step.kind === "guard")).toBe(false);
    const created = missing.steps[1];
    expect(created?.kind === "write" && Boolean(created.racePin)).toBe(true);

    // Transaction mode locks the probe, so neither branch carries a guard.
    const tx = createOperation(new TransactionProbeDriver());
    expect(
      tx
        .compile({ "post.find.rows": [{ id: 1 }] })
        .steps.every((s) => s.kind !== "guard")
    ).toBe(true);
    expect(
      tx
        .compile({ "post.find.rows": [] })
        .steps.every((s) => s.kind !== "guard")
    ).toBe(true);
  });

  test(
    "surfaces a create-branch race as a pinned unique conflict, never a guard abort",
    {
      timeout: 30_000,
    },
    async () => {
      const db = new PGlite();
      const setup = createClient({
        schema: operationFragmentSchema,
        driver: new PGliteDriver({ client: db }),
      });
      try {
        await push(setup, { force: true });

        // The racePin the missing-branch create carries (the child primary key).
        const missing = createOperation(new BatchProbeDriver()).compile({
          "post.find.rows": [],
        });
        const createStep = missing.steps[1];
        const racePin =
          createStep?.kind === "write" ? createStep.racePin : undefined;
        expect(racePin?.fields).toEqual(["id"]);
        if (!racePin) return;

        // A concurrent winner commits the same child primary key just before the
        // loser's batch runs; the loser's INSERT then violates that key.
        const driver = new BeforeBatchPGliteDriver(
          async () => {
            await setup.post.create({
              data: {
                id: 1,
                title: "winner",
                slug: "winner-key",
                userId: null,
              },
            });
          },
          { client: db }
        );

        let caught: unknown;
        await createOperationExecutor(driver)
          .executeCreate(operationFragmentSchema.user, createNestedUpsertArgs())
          .catch((error) => {
            caught = error;
          });

        // The loser surfaces the pinned unique conflict, not a guard abort.
        expect(caught).toBeInstanceOf(UniqueConstraintError);
        expect(caught).not.toBeInstanceOf(NestedWriteError);
        expect(matchesRacePin(caught as UniqueConstraintError, racePin)).toBe(
          true
        );
        expect(driver.batchCalls).toBe(1);
        await expect(setup.user.findMany()).resolves.toEqual([]);
        await expect(setup.post.findMany()).resolves.toEqual([
          { id: 1, title: "winner", slug: "winner-key", userId: null },
        ]);
      } finally {
        await setup.$disconnect();
      }
    }
  );
});

/**
 * Mirrors V1's `matchesPinnedUniqueConstraint` (OperationRuntime.ts): a race is
 * classified to the pin only when normalized provider metadata identifies the
 * pinned table and constraint/columns. Missing attribution fails closed.
 */
function matchesRacePin(
  error: UniqueConstraintError,
  pin: TargetConstraintPin
): boolean {
  const normalize = (id: string) =>
    (id.split(".").at(-1) ?? id).replace(/["`[\]]/g, "").toLowerCase();
  const meta = error.meta as {
    table?: string;
    columns?: string[];
    constraint?: string;
  };
  if (meta.table && normalize(meta.table) !== normalize(pin.table)) {
    return false;
  }
  let matched = false;
  if (meta.columns) {
    matched = true;
    const actual = meta.columns.map(normalize).sort();
    const expected = pin.columns.map(normalize).sort();
    if (
      actual.length !== expected.length ||
      !actual.every((column, index) => column === expected[index])
    ) {
      return false;
    }
  }
  if (meta.constraint) {
    matched = true;
    if (
      !new Set(pin.constraints.map(normalize)).has(normalize(meta.constraint))
    ) {
      return false;
    }
  }
  return matched;
}

function driverEngine(driver: Driver<unknown, unknown>): QueryEngine {
  const schemas = createSchemaRegistry(operationFragmentSchema);
  return new QueryEngine(
    driver,
    createModelRegistry(operationFragmentSchema, schemas)
  );
}

function createOperation(driver: Driver<unknown, unknown>): CreateOperation {
  return new CreateOperation(
    driverEngine(driver),
    operationFragmentSchema.user,
    createNestedUpsertArgs()
  );
}
