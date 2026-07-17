import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import {
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  UniqueConstraintError,
} from "@errors";
import {
  attributeOperationBatchError,
  OperationBatchRuntime,
} from "@query-engine/OperationBatchRuntime";
import { OperationCompiler } from "@query-engine/OperationCompiler";
import { OperationResults } from "@query-engine/OperationResults";
import { OperationRuntime } from "@query-engine/OperationRuntime";
import type { ProgramFailure } from "@query-engine/operation-program";
import {
  createResultSource,
  createWriteStep,
  type GuardStep,
  type OperationProgram,
  type ProducedValue,
} from "@query-engine/operation-program";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { PreparedBatchGuard } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { createSchemaRegistry } from "@validation";
import { describe, expect, it } from "vitest";

const INSERT_SQL = /INSERT INTO/i;
const UPDATE_SQL = /UPDATE/i;
const BATCH_REFS_SQL = /viborm_batch_refs/i;
const INTEGER_CAST_SQL = /CAST|::integer/i;

class WriteContractDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  next: QueryResult<unknown> = { rows: [], rowCount: 0 };
  executionCount = 0;
  transactionCount = 0;
  queued: QueryResult<unknown>[] = [];

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `write-contract-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // This test driver opens no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    this.executionCount += 1;
    return (this.queued.shift() ?? this.next) as QueryResult<T>;
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute();
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    this.transactionCount += 1;
    return execute(null);
  }
}

class BatchOnlyWriteContractDriver extends WriteContractDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

class FailingWriteContractDriver extends WriteContractDriver {
  readonly failures = new Map<number, Error>();

  protected override async execute<T>(): Promise<QueryResult<T>> {
    const execution = this.executionCount + 1;
    const failure = this.failures.get(execution);
    if (failure) {
      this.executionCount = execution;
      throw failure;
    }
    return super.execute<T>();
  }
}

class IndexedBatchFailureDriver extends BatchOnlyWriteContractDriver {
  statementIndex = 0;
  batchCount = 0;

  protected override async executeBatch<T>(): Promise<QueryResult<T>[]> {
    this.batchCount += 1;
    throw new NestedWriteAssertionError("indexed direct batch assertion", {
      meta: { statementIndex: this.statementIndex },
    });
  }
}

class ReturningWithoutUpsertWhereAdapter extends PostgresAdapter {
  constructor() {
    super();
    this.capabilities = {
      ...this.capabilities,
      supportsUpsertWhere: false,
    };
  }
}

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string().unique(),
});
const schema = { user };
hydrateSchemaNames(schema);
const registry = createModelRegistry(schema, createSchemaRegistry(schema));

const counter = s.model({
  id: s.int().id().increment(),
  key: s.string().unique(),
  value: s.int(),
});
const compound = s
  .model({
    tenantId: s.string().map("tenant_id"),
    localId: s.string().map("local_id"),
    name: s.string(),
  })
  .id(["tenantId", "localId"]);
const dynamicSchema = { counter, compound };
hydrateSchemaNames(dynamicSchema);
const dynamicRegistry = createModelRegistry(
  dynamicSchema,
  createSchemaRegistry(dynamicSchema)
);

function createEngine(adapter: DatabaseAdapter, dialect: Dialect) {
  const driver = new WriteContractDriver(adapter, dialect);
  return { driver, engine: new QueryEngine(driver, registry) };
}

describe("OperationProgram direct writes", () => {
  it.each([
    [new PostgresAdapter(), "postgresql"],
    [new SQLiteAdapter(), "sqlite"],
  ] as const)("compiles complete returning mutations on %s", (adapter, dialect) => {
    const { engine } = createEngine(adapter, dialect);
    const cases = [
      ["create", { data: { id: "1", email: "one@test", name: "one" } }],
      ["update", { where: { id: "1" }, data: { name: "updated" } }],
      ["delete", { where: { id: "1" } }],
      [
        "upsert",
        {
          where: { email: "one@test" },
          create: { id: "1", email: "one@test", name: "created" },
          update: { name: "updated" },
        },
      ],
      ["updateManyAndReturn", { data: { name: "many" } }],
      [
        "createManyAndReturn",
        { data: [{ id: "2", email: "two@test", name: "two" }] },
      ],
    ] as const;

    for (const [operation, args] of cases) {
      const program = engine.prepare(user, operation, args).compile();
      expect(program).toMatchObject({
        atomicity: "statement",
        steps: [
          {
            id: "write:0",
            kind: "write",
            produces: "write:0:result",
          },
        ],
        result: {
          source: {
            kind: "rows",
            results: [{ step: "write:0", result: "write:0:result" }],
          },
          operation,
        },
      });
      expect(program.steps).toHaveLength(1);
    }
  });

  it.each([
    [new PostgresAdapter(), "postgresql"],
    [new MySQLAdapter(), "mysql"],
    [new SQLiteAdapter(), "sqlite"],
  ] as const)("compiles portable count writes on %s", (adapter, dialect) => {
    const { engine } = createEngine(adapter, dialect);
    for (const [operation, args] of [
      ["createMany", { data: [{ id: "1", email: "one@test", name: "one" }] }],
      ["updateMany", { data: { name: "updated" } }],
      ["deleteMany", {}],
    ] as const) {
      expect(engine.prepare(user, operation, args).compile()).toMatchObject({
        steps: [
          {
            kind: "write",
            expectedCardinality: "many",
            affectedRows: "unrestricted",
          },
        ],
        result: { source: { kind: "rowCount" }, operation },
      });
    }
  });

  it("compiles linear cases and defers only branch-capable upsert", () => {
    const mysql = createEngine(new MySQLAdapter(), "mysql").engine;
    expect(
      mysql
        .prepare(user, "create", {
          data: { id: "1", email: "one@test", name: "one" },
        })
        .prepare()
    ).toBeUndefined();
    expect(
      mysql
        .prepare(user, "create", {
          data: { id: "1", email: "one@test", name: "one" },
        })
        .compile()
    ).toMatchObject({
      atomicity: "operation",
      steps: [{ kind: "write" }, { kind: "read" }],
    });

    const filtered = createEngine(
      new ReturningWithoutUpsertWhereAdapter(),
      "postgresql"
    ).engine;
    expect(
      filtered
        .prepare(user, "upsert", {
          where: { email: "one@test" },
          create: { id: "1", email: "one@test", name: "created" },
          update: { name: "updated" },
          setWhere: { name: "before" },
        })
        .compile()
    ).toMatchObject({
      atomicity: "operation",
      steps: [
        { kind: "read", producedValues: expect.any(Array) },
        { kind: "branch" },
      ],
    });

    const returning = createEngine(new PostgresAdapter(), "postgresql").engine;
    expect(
      returning
        .prepare(user, "createManyAndReturn", {
          data: [
            { id: "1", email: "one@test", name: "one" },
            { id: "2", email: "two@test", name: "two" },
          ],
        })
        .compile()
    ).toMatchObject({
      atomicity: "operation",
      steps: [{ kind: "write" }, { kind: "write" }],
    });
  });

  it("declares recoverable duplicate writes in an atomic program", () => {
    const args = {
      data: [{ id: "1", email: "one@test", name: "one" }],
      skipDuplicates: true,
    };
    const mysql = createEngine(new MySQLAdapter(), "mysql").engine;
    expect(mysql.prepare(user, "createMany", args).compile()).toMatchObject({
      atomicity: "operation",
      steps: [{ kind: "write", onUniqueConflict: "skip" }],
    });
    expect(mysql.prepare(user, "createMany", args).prepare()).toBeUndefined();

    const postgres = createEngine(new PostgresAdapter(), "postgresql").engine;
    expect(postgres.prepare(user, "createMany", args).compile()).toMatchObject({
      steps: [{ kind: "write" }],
      result: { source: { kind: "rowCount" } },
    });
  });

  it("resolves rows, counts, and definitive misses from the result contract", async () => {
    const { driver, engine } = createEngine(new SQLiteAdapter(), "sqlite");
    driver.next = {
      rows: [{ id: "1", email: "one@test", name: "created" }],
      rowCount: 1,
    };
    await expect(
      engine.prepare(user, "create", {
        data: { id: "1", email: "one@test", name: "created" },
      })
    ).resolves.toEqual(driver.next.rows[0]);

    driver.next = { rows: [], rowCount: 3 };
    await expect(
      engine.prepare(user, "updateMany", { data: { name: "updated" } })
    ).resolves.toEqual({ count: 3 });

    driver.next = { rows: [], rowCount: 0 };
    expect(
      engine
        .prepare(user, "update", {
          where: { id: "missing" },
          data: { name: "updated" },
        })
        .compile()
    ).toMatchObject({
      steps: [{ kind: "write", missing: "not-found" }],
    });
    expect(
      engine.prepare(user, "delete", { where: { id: "missing" } }).compile()
    ).toMatchObject({
      steps: [{ kind: "write", missing: "not-found" }],
    });
    await expect(
      engine.prepare(user, "update", {
        where: { id: "missing" },
        data: { name: "updated" },
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(driver.executionCount).toBe(3);
    expect(driver.transactionCount).toBe(0);
  });

  it("specializes both fallback-upsert arms and rejects an unpinned missing arm", async () => {
    const adapter = new ReturningWithoutUpsertWhereAdapter();
    const driver = new BatchOnlyWriteContractDriver(adapter, "postgresql");
    const engine = new QueryEngine(driver, registry);
    const args = {
      where: { email: "one@test" },
      create: { id: "1", email: "one@test", name: "created" },
      update: { name: "updated" },
      setWhere: { name: "before" },
    };

    driver.queued = [{ rows: [], rowCount: 0 }];
    const missing = await engine.prepare(user, "upsert", args).prepareBatch();
    expect(missing?.queries.some((query) => INSERT_SQL.test(query.sql))).toBe(
      true
    );

    driver.queued = [
      { rows: [{ id: "1" }], rowCount: 1 },
      { rows: [{ exists: 1 }], rowCount: 1 },
    ];
    const found = await engine.prepare(user, "upsert", args).prepareBatch();
    expect(found?.guards).toHaveLength(2);
    expect(found?.queries.some((query) => UPDATE_SQL.test(query.sql))).toBe(
      true
    );

    driver.queued = [{ rows: [], rowCount: 0 }];
    await expect(
      engine
        .prepare(user, "upsert", {
          ...args,
          create: { id: "1", email: "different@test", name: "created" },
        })
        .prepareBatch()
    ).rejects.toThrow("cannot pin the missing upsert premise");
  });

  it("stores a generated identity immediately after its producer and casts the read", async () => {
    const adapter = new ReturningWithoutUpsertWhereAdapter();
    const driver = new BatchOnlyWriteContractDriver(adapter, "postgresql");
    const engine = new QueryEngine(driver, dynamicRegistry);
    driver.queued = [{ rows: [], rowCount: 0 }];
    const pending = engine.prepare(counter, "upsert", {
      where: { key: "counter" },
      create: { key: "counter", value: 1 },
      update: { value: 2 },
      setWhere: { value: 0 },
    });
    const program = pending.compile();
    expect(JSON.stringify(program)).toContain('"id":"value:0"');
    expect(JSON.stringify(program)).toContain('"id":"value:1"');

    const prepared = await pending.prepareBatch();
    expect(prepared?.setupQueries).toHaveLength(2);
    expect(prepared?.cleanupQueries).toHaveLength(1);
    expect(prepared?.queries).toHaveLength(3);
    expect(prepared?.queries[0]?.sql).toMatch(INSERT_SQL);
    expect(prepared?.queries[1]?.sql).toMatch(BATCH_REFS_SQL);
    expect(prepared?.queries[2]?.sql).toMatch(INTEGER_CAST_SQL);
  });

  it("accepts exact mapped compound pins and rejects mismatched constituents", async () => {
    const adapter = new ReturningWithoutUpsertWhereAdapter();
    const driver = new BatchOnlyWriteContractDriver(adapter, "postgresql");
    const engine = new QueryEngine(driver, dynamicRegistry);
    const where = {
      tenantId_localId: { tenantId: "tenant", localId: "local" },
    };
    driver.queued = [{ rows: [], rowCount: 0 }];
    await expect(
      engine
        .prepare(compound, "upsert", {
          where,
          create: { tenantId: "tenant", localId: "local", name: "created" },
          update: { name: "updated" },
          setWhere: { name: "before" },
        })
        .prepareBatch()
    ).resolves.toBeDefined();

    driver.queued = [{ rows: [], rowCount: 0 }];
    await expect(
      engine
        .prepare(compound, "upsert", {
          where,
          create: { tenantId: "tenant", localId: "other", name: "created" },
          update: { name: "updated" },
          setWhere: { name: "before" },
        })
        .prepareBatch()
    ).rejects.toThrow("cannot pin the missing upsert premise");
  });

  it("retries only the exact missing-branch unique target", async () => {
    const driver = new FailingWriteContractDriver(new MySQLAdapter(), "mysql");
    const engine = new QueryEngine(driver, registry);
    const conflict = new UniqueConstraintError("email race", {
      meta: { columns: ["email"] },
    });
    driver.failures.set(2, conflict);
    driver.queued = [
      { rows: [], rowCount: 0 },
      { rows: [{ id: "1" }], rowCount: 1 },
      { rows: [{ id: "1" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      {
        rows: [{ id: "1", email: "one@test", name: "updated" }],
        rowCount: 1,
      },
    ];

    await expect(
      engine.prepare(user, "upsert", {
        where: { email: "one@test" },
        create: { id: "1", email: "one@test", name: "created" },
        update: { name: "updated" },
      })
    ).resolves.toMatchObject({ id: "1", name: "updated" });
    expect(driver.transactionCount).toBe(2);
    expect(driver.executionCount).toBe(6);
  });

  it("does not retry an unrelated unique failure in the found update arm", async () => {
    const driver = new FailingWriteContractDriver(new MySQLAdapter(), "mysql");
    const engine = new QueryEngine(driver, registry);
    const conflict = new UniqueConstraintError("update name conflict", {
      meta: { columns: ["name"] },
    });
    driver.failures.set(3, conflict);
    driver.queued = [
      { rows: [{ id: "1" }], rowCount: 1 },
      { rows: [{ id: "1" }], rowCount: 1 },
    ];

    let failure: unknown;
    try {
      await engine.prepare(user, "upsert", {
        where: { email: "one@test" },
        create: { id: "1", email: "one@test", name: "created" },
        update: { name: "occupied" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UniqueConstraintError);
    if (!(failure instanceof UniqueConstraintError)) {
      throw new Error("Found-arm conflict lost its typed error");
    }
    expect(failure.message).toBe(conflict.message);
    expect(failure.meta.columns).toEqual(["name"]);
    expect(driver.transactionCount).toBe(1);
    expect(driver.executionCount).toBe(3);
  });

  it("fails closed when the create conflict names another unique target", async () => {
    const driver = new FailingWriteContractDriver(new MySQLAdapter(), "mysql");
    const engine = new QueryEngine(driver, registry);
    const conflict = new UniqueConstraintError("create id conflict", {
      meta: { columns: ["id"] },
    });
    driver.failures.set(2, conflict);
    driver.queued = [{ rows: [], rowCount: 0 }];

    let failure: unknown;
    try {
      await engine.prepare(user, "upsert", {
        where: { email: "one@test" },
        create: { id: "occupied", email: "one@test", name: "created" },
        update: { name: "updated" },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UniqueConstraintError);
    if (!(failure instanceof UniqueConstraintError)) {
      throw new Error("Create-arm conflict lost its typed error");
    }
    expect(failure.message).toBe(conflict.message);
    expect(failure.meta.columns).toEqual(["id"]);
    expect(driver.transactionCount).toBe(1);
    expect(driver.executionCount).toBe(2);
  });

  it("attributes combined-batch guards by adjusted index and proof only", async () => {
    const { driver } = createEngine(new PostgresAdapter(), "postgresql");
    const guards: PreparedBatchGuard[] = [
      {
        queryIndex: 4,
        premise: "exists",
        probe: sql`SELECT 1`,
        model: "user",
        operation: "upsert",
        failure: {
          kind: "nestedWrite",
          message: "first guard",
          relation: "user",
          raceable: false,
        },
      },
      {
        queryIndex: 7,
        premise: "notExists",
        probe: sql`SELECT 2`,
        model: "user",
        operation: "upsert",
        failure: {
          kind: "nestedWrite",
          message: "second guard",
          relation: "user",
          raceable: true,
        },
      },
    ];
    const indexed = new NestedWriteAssertionError("assertion", {
      meta: { statementIndex: 7 },
    });
    const mapped = await attributeOperationBatchError(indexed, guards, driver);
    if (!(mapped instanceof NestedWriteError)) {
      throw new Error("Indexed guard did not preserve its failure type");
    }
    expect(mapped.message).toBe("second guard");
    expect(mapped.meta.raceable).toBe(true);

    const unindexed = new NestedWriteAssertionError("assertion");
    driver.queued = [
      { rows: [{ one: 1 }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ];
    await expect(
      attributeOperationBatchError(unindexed, guards, driver)
    ).resolves.toBe(unindexed);

    driver.queued = [
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ];
    const proved = await attributeOperationBatchError(
      unindexed,
      guards,
      driver
    );
    if (!(proved instanceof NestedWriteError)) {
      throw new Error("Re-probed guard did not preserve its failure type");
    }
    expect(proved.message).toBe("first guard");
  });

  it("lowers affected-row guards and preserves live failure attribution", async () => {
    const failure: ProgramFailure = {
      kind: "nestedWrite",
      message: "affected-row premise failed",
      relation: "user",
      raceable: true,
    };
    const write = createWriteStep("write:guarded", sql`UPDATE users`, {
      expectedCardinality: "many",
      affectedRows: "unrestricted",
    });
    const guard: GuardStep = {
      id: "guard:affected",
      kind: "guard",
      premise: {
        kind: "affectedRows",
        step: write.id,
        minimum: 1,
        statement: sql`SELECT 1 FROM users WHERE id = ${"expected"}`,
      },
      failure,
    };
    const program: OperationProgram = {
      atomicity: "operation",
      steps: [write, guard],
      result: {
        source: { kind: "rowCount", results: [createResultSource(write)] },
        operation: "updateMany",
        args: { data: { name: "updated" } },
      },
    };

    const live = createEngine(new PostgresAdapter(), "postgresql");
    live.driver.queued = [{ rows: [], rowCount: 0 }];
    const livePending = live.engine.prepare(
      user,
      "updateMany",
      program.result.args
    );
    const liveCompiler = new OperationCompiler(livePending);
    const liveResults = new OperationResults(livePending);
    const liveRuntime = new OperationRuntime(
      livePending,
      liveCompiler,
      liveResults
    );
    const executeProgram = Reflect.get(liveRuntime, "executeProgram");
    if (typeof executeProgram !== "function") {
      throw new Error("OperationRuntime omitted program execution");
    }
    let liveFailure: unknown;
    try {
      await Reflect.apply(executeProgram, liveRuntime, [
        program,
        live.driver,
        () => ({ count: 0 }),
      ]);
    } catch (error) {
      liveFailure = error;
    }

    const batchDriver = new BatchOnlyWriteContractDriver(
      new PostgresAdapter(),
      "postgresql"
    );
    const batchEngine = new QueryEngine(batchDriver, registry);
    const batchPending = batchEngine.prepare(
      user,
      "updateMany",
      program.result.args
    );
    const batchCompiler = new OperationCompiler(batchPending);
    const batchResults = new OperationResults(batchPending);
    const batchRuntime = new OperationRuntime(
      batchPending,
      batchCompiler,
      batchResults
    );
    const prepared = await new OperationBatchRuntime(batchRuntime).prepare(
      program,
      batchDriver
    );
    expect(prepared?.queries).toHaveLength(2);
    expect(prepared?.guards).toMatchObject([
      { queryIndex: 1, premise: "exists", failure },
    ]);
    const declaredProbe = sql`SELECT 0 AS compiler_declared_postcondition`;
    const declared = await new OperationBatchRuntime(batchRuntime).prepare(
      {
        ...program,
        steps: [
          write,
          {
            ...guard,
            premise: { ...guard.premise, statement: declaredProbe },
          },
        ],
      },
      batchDriver
    );
    expect(declared?.queries[1]?.sql).toContain(
      "compiler_declared_postcondition"
    );
    const assertion = new NestedWriteAssertionError("assertion", {
      meta: { statementIndex: 1 },
    });
    const batchFailure = await attributeOperationBatchError(
      assertion,
      prepared?.guards ?? [],
      batchDriver
    );

    expect(liveFailure).toBeInstanceOf(NestedWriteError);
    expect(batchFailure).toBeInstanceOf(NestedWriteError);
    if (
      !(
        liveFailure instanceof NestedWriteError &&
        batchFailure instanceof NestedWriteError
      )
    ) {
      throw new Error("Guard runtimes did not preserve failure types");
    }
    expect(liveFailure.message).toBe(failure.message);
    expect(batchFailure.message).toBe(failure.message);
    expect(liveFailure.meta.raceable).toBe(true);
    expect(batchFailure.meta.raceable).toBe(true);
  });

  it("offsets direct batch guards past scratch setup and excludes cleanup", async () => {
    const driver = new IndexedBatchFailureDriver(
      new PostgresAdapter(),
      "postgresql"
    );
    const engine = new QueryEngine(driver, dynamicRegistry);
    const pending = engine.prepare(counter, "updateMany", {
      data: { value: 2 },
    });
    const compiler = new OperationCompiler(pending);
    const results = new OperationResults(pending);
    const runtime = new OperationRuntime(pending, compiler, results);
    const batch = new OperationBatchRuntime(runtime);
    const produced: ProducedValue = {
      kind: "producedValue",
      id: "value:guard-offset",
      producer: "write:generated",
      field: "id",
      source: "insertId",
    };
    const write = createWriteStep(
      "write:generated",
      sql`INSERT INTO counters`,
      {
        expectedCardinality: "one",
        affectedRows: "exact",
        producedValues: [produced],
      }
    );
    const guard: GuardStep = {
      id: "guard:after-generated",
      kind: "guard",
      premise: { kind: "exists", statement: sql`SELECT 1` },
      failure: {
        kind: "nestedWrite",
        message: "offset guard failed",
        relation: "counter",
        raceable: false,
      },
    };
    const program: OperationProgram = {
      atomicity: "operation",
      steps: [write, guard],
      result: {
        source: { kind: "rowCount", results: [createResultSource(write)] },
        operation: "updateMany",
        args: { data: { value: 2 } },
      },
    };
    const prepared = await batch.prepare(program, driver);
    expect(prepared?.setupQueries).toHaveLength(2);
    expect(prepared?.queries).toHaveLength(3);
    expect(prepared?.guards).toMatchObject([{ queryIndex: 2 }]);
    expect(prepared?.cleanupQueries).toHaveLength(1);

    driver.statementIndex = 4;
    await expect(batch.execute(program, driver)).rejects.toMatchObject({
      name: "NestedWriteError",
      message: "offset guard failed",
    });

    driver.statementIndex = 5;
    let cleanupFailure: unknown;
    try {
      await batch.execute(program, driver);
    } catch (error) {
      cleanupFailure = error;
    }
    expect(cleanupFailure).toBeInstanceOf(NestedWriteAssertionError);
    expect(cleanupFailure).not.toBeInstanceOf(NestedWriteError);
    if (!(cleanupFailure instanceof NestedWriteAssertionError)) {
      throw new Error("Cleanup assertion lost its original type");
    }
    expect(cleanupFailure.message).toBe("indexed direct batch assertion");
    expect(cleanupFailure.meta.statementIndex).toBe(5);
    expect(driver.batchCount).toBe(2);
  });

  it("fails closed when a result source names an undeclared produced result", () => {
    const { driver, engine } = createEngine(new SQLiteAdapter(), "sqlite");
    const pending = engine.prepare(user, "create", {
      data: { id: "1", email: "one@test", name: "one" },
    });
    const program = pending.compile();
    const [source] = program.result.source.results;
    if (!source) throw new Error("compiled program omitted its result source");
    const invalidProgram: OperationProgram = {
      ...program,
      result: {
        ...program.result,
        source: {
          ...program.result.source,
          results: [{ ...source, result: "write:0:unknown" }],
        },
      },
    };
    const providerResult = {
      rows: [{ id: "1", email: "one@test", name: "one" }],
      rowCount: 1,
    };

    expect(() =>
      new OperationResults(pending).resolve(
        invalidProgram,
        new Map([["write:0", providerResult]]),
        driver
      )
    ).toThrow(
      "Program result 'write:0:unknown' is not produced by step 'write:0'."
    );
  });
});
